# Direct communication between portal users and Apricart

## The requirement

> Portal users should have a direct communication channel with the Apricart
> team. Users should be able to raise queries or complaints related to invoices,
> orders, and other relevant issues.

Today a client with a question about an invoice has no route through the
product: the only channels the application offers are the order rejection
reason and the refund request reason, both of which are attached to a decision
rather than to a conversation, and neither of which reaches Apricart.

## The rule this change implements

> A **support thread** is a conversation between one client organization and
> Apricart. It may be raised against a specific order (and therefore its
> invoice) or stand on its own. Apricart — `SUPER_ADMIN` — is a participant in
> every thread. On the client side the participants are the person who raised
> it and the people already accountable for that branch's orders.

**Visibility (decided, not negotiable in implementation):**

| Viewer | Sees |
|---|---|
| `SUPER_ADMIN` | every thread, every organization |
| `HEAD_OFFICE` | every thread in **their** organization |
| `BRANCH_ADMIN` | threads on **their** branch, plus any they raised |
| `ORDER_PORTAL` | threads **they** raised |
| `GROUP_USER`, `GROUP_ORDER_PORTAL` | threads **they** raised |

The group roles are deliberately *not* widened to their assigned branch set.
They are neither the branch's administrator nor the organization's head office,
so they are outside the chain the requirement describes. Widening them later is
a one-line change in `lib/support-access.ts` with its own decision; widening
them silently now would put one requester's complaint in front of another.

This is a **reading** rule. Replying requires visibility *and* a non-terminal
thread. Triage — assigning, closing, changing priority — is Apricart's alone.

## Non-goals for this change

- No internal-only notes. Every message in a thread is visible to every
  participant of that thread. An internal note is a different feature with a
  different leak profile and it is easier to add than to retract.
- No SLA timers, escalation, or auto-close. `first_response_at` is recorded so
  the measurement is possible later without a backfill.
- No live push. The thread polls, like every other data surface in this app.
- No PDF attachments. Images only — `sharp` sanitises a raster, and nothing in
  this repo sanitises a PDF.

## Data model

Four new tables, plus two relaxations on existing ones.

### `support_threads`

`organization_id` NOT NULL, `branch_id` NULL (a Head Office raiser has no
branch), `order_id` NULL, `subject`, `category`, `status`, `priority`,
`created_by_user_id`, `assigned_to_user_id` NULL, `message_count`,
`last_message_at`, `last_message_side`, `first_response_at`, `resolved_at` /
`resolved_by_user_id`, `closed_at` / `closed_by_user_id`.

There is no `reference` column. The human reference is `SUP-000123`, derived
from the id by `supportThreadReference()` — a column would be a second source of
truth for a value that is already unique.

**Status machine** (`lib/support-thread.ts`, pure):

```
OPEN                ── customer wrote last; Apricart owes a reply
AWAITING_CUSTOMER   ── Apricart wrote last; the client owes a reply
RESOLVED            ── settled; either side may reopen
CLOSED              ── terminal; only SUPER_ADMIN reopens
```

- A customer message moves any non-terminal thread to `OPEN`.
- An Apricart message moves any non-terminal thread to `AWAITING_CUSTOMER`.
- Either side may set `RESOLVED`; either side may reopen `RESOLVED` → `OPEN`.
- Only Apricart may `CLOSE`, and only Apricart may reopen a closed thread.
- `CLOSED` accepts no messages from anyone.

### `support_messages`

`thread_id`, `author_user_id`, `author_side` (`CUSTOMER` | `APRICART`),
`author_role` (snapshot — a person's role can change, the record of who said
what at the time must not), `body`, `created_at`.

### `support_attachments`

Uploaded before the message that carries them, then **claimed** inside the same
transaction that writes the message. An upload that is never claimed is an
orphan row pointing at an S3 object, owned by its uploader and readable by
nobody — acceptable, and a cleanup script can come later.

Claiming requires: the row is unclaimed, the caller uploaded it, and it is less
than `ATTACHMENT_CLAIM_WINDOW_MS` old.

### `support_thread_reads`

`(thread_id, user_id) → last_read_at`. Drives the unread count in the list. Not
a participant table — visibility is computed, never stored, so a role change
takes effect immediately instead of leaving a stale grant behind.

### Changes to existing tables

- `notifications.support_thread_id` — nullable FK. Needed for the bell's
  deep link. `notifications.order_id` is already nullable, and the route's
  existing org/branch scoping applies unchanged.
- `email_outbox.order_id` and `email_outbox.branch_id` relax to NULL, and
  `support_thread_id` is added. Relaxing NOT NULL is additive: every existing
  row and every existing write is unaffected.

## Storage and the attachment leak

`GET /api/v1/images/[...key]` authenticates but does **not** authorize — every
signed-in user may fetch any product image, which is correct for a catalogue
picture and catastrophic for a screenshot of another tenant's invoice.

So support attachments are **not** served by that route. `isValidImageKey` stays
pinned to the `products/` prefix, support objects are written under `support/`,
and they come back only through `GET /api/v1/support/attachments/[id]`, which
resolves the attachment to its thread and applies the same visibility rule as
the thread itself. A signed-in user from another tenant gets a 404.

## Layers

### Pure (`lib/`, unit-tested, no database)

| Module | Holds |
|---|---|
| `lib/support-thread.ts` | categories, statuses, priorities, sides, labels, the status machine, `supportThreadReference` |
| `lib/support-access.ts` | the visibility table above, reply/manage rights, and which orders a caller may cite |

### Server (`lib/server/`)

| Module | Holds |
|---|---|
| `lib/server/support-threads.ts` | create / reply / transition / list / read, all transactional |
| `lib/server/support-notifications.ts` | bell rows + outbox rows for the other side, and support email delivery |
| `lib/server/email-outbox-runtime.ts` | the claim loop and delivery-state helpers, lifted out of `order-notifications.ts` unchanged |
| `lib/email/support.ts` | the message template |

`processOrderEmailOutbox` and `attemptImmediateOrderEmailDelivery` keep their
names, signatures and behaviour; internally they now dispatch by template family
so an order row still takes exactly the path it takes today.

### API (`app/api/v1/support/`)

| Route | Method | Notes |
|---|---|---|
| `threads` | GET | list, scoped, bounded page size, allowlisted sort |
| `threads` | POST | opens a thread with its first message |
| `threads/[id]` | GET | thread + messages; marks read |
| `threads/[id]` | PATCH | status / priority / assignee, each with its own right |
| `threads/[id]/messages` | POST | reply |
| `attachments` | POST | multipart, one image, `sharp`-sanitised |
| `attachments/[id]` | GET | authorized stream |

Every one: rate limit → authenticate → authorize → scope from session →
validate with Zod → verify ownership → transact → audit → shape the response.
Out-of-scope threads answer 404, never 403, so a thread id cannot be enumerated.

### Permissions

New category and four permissions in `lib/permissions.ts`:
`support:view`, `support:create`, `support:reply`, `support:manage`.
`support:manage` is Apricart-side triage and belongs to `SUPER_ADMIN` alone
(it arrives there through `Object.values(Permission)`). Every other role
template gains view/create/reply.

### UI

`/support` is a shared area like `/invoices` — it has its own layout and is
reachable by every role, because every role is a potential participant.
`proxy.ts` gains it in the same way it already admits the invoice area, and the
role gate stays where it belongs, on the endpoints.

- `app/support/page.tsx` — list, filters, and the "raise a query" dialog.
- `app/support/[id]/page.tsx` — the conversation.
- Sidebar entry for the admin-shell roles; header link in `/shop` and
  `/group-portal`; a "Raise a query" action on the order detail page and the
  invoice page that deep-links `/support?orderId=<id>`.

## Tests

- `lib/support-access.test.ts` — the visibility table role by role, including
  cross-tenant denial for every role and the group roles' deliberate narrowness.
- `lib/support-thread.test.ts` — every legal and illegal transition, terminal
  behaviour, reference formatting.
- `lib/server/support-boundaries.test.ts` — contract: each support route
  authenticates, authorizes and scopes; the attachment route resolves through
  the thread rule; `isValidImageKey` never admits a `support/` key.

## Risk and rollback

The feature is additive: four new tables, one nullable column on
`notifications`, two relaxations plus one column on `email_outbox`. Nothing
existing changes shape, so rolling the code back leaves unused tables and the
application exactly as it was. The one behavioural edit to an existing file is
the outbox worker's dispatch, which is covered by the existing order
notification tests.

---

## As built — decisions worth recording

**Who is notified, and who merely sees it.** Both channels go to the people on
the *other* side of the conversation, plus the raiser when somebody answers on
their behalf:

- a customer wrote → every active Apricart administrator, and the raiser
- Apricart wrote → the raiser

A branch administrator and a head office reading their organization's queue are
deliberately **not** mailed for every reply. They can read the thread — the
unread marker in their list is what tells them it moved — but turning one
client's conversation into everybody's inbox is how a support channel gets
switched off. Widening this is a change to `queueSupportMessageNotifications`
and nothing else.

**The outbox worker was generalised, not duplicated.** The claim loop, the
attempt counter, the backoff and the retirement sweep moved verbatim into
`lib/server/email-outbox-runtime.ts`; `processOrderEmailOutbox` keeps its name,
its signature and its behaviour, and now dispatches each claimed row by template
family. An order lifecycle row takes exactly the path it took before, and
`lib/server/order-notifications-security.test.ts` still pins that path
unchanged.

**A support email carries no conversation.** It says something happened and
links to the thread. Mail is the one place where content leaves this
application's access control behind — forwarded, quoted, read on a shared
mailbox — and a thread can hold an invoice dispute, a price, or a name. The
recipient's right to the thread is re-checked at delivery time, not at queue
time, so a person deactivated or moved between the two is dropped rather than
mailed.

**Assignment fails closed.** `resolveAssignee` accepts only an active Apricart
administrator; anything else resolves to nobody rather than to an error, so a
stale user id unassigns instead of parking a thread with someone who cannot see
the queue.

## How this was verified

```
npm run typecheck        clean
npm run lint             0 errors (109 pre-existing warnings, none in this change)
npm test                 1693 passed, 1 pre-existing failure (see below)
npm run test:integration  SKIPPED — no TEST_DATABASE_URL; 56 tests skipped
npm run build            succeeds; all five support routes in the manifest
```

Two things a reviewer should know rather than rediscover:

1. **`lib/server/group-order-reporting.test.ts` fails, and it is not this
   change.** It asserts an LF-joined substring against
   `app/(portal)/reports/page.tsx`, which is stored CRLF in a Windows working
   tree. Verified by stashing this entire branch and re-running: it fails
   identically on a clean tree. Untouched here.
2. **`npm run build` needs an HTTPS `NEXTAUTH_URL`.** A production build
   rejects an HTTP one during page-data collection, before any route of this
   change is involved. Built with the variable overridden.

New tests: `lib/support-thread.test.ts` (36), `lib/support-access.test.ts` (22),
`lib/server/support-boundaries.test.ts` (18).

The integration suite skipped, so **nothing here has been exercised against a
real Postgres.** The migration, the row-locked transitions, the attachment claim
window and the `ON CONFLICT` upserts are unverified against a live database and
should be run on a disposable one before this reaches production.
