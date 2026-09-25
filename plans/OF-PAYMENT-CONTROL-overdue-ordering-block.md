# OF-PAYMENT-CONTROL — Branch payment control: overdue-payment ordering block

## Objective

When a branch has too many overdue payments, new ordering for that branch is
refused server-side until the payments are cleared — unless Head Office has
granted a time-bound exception. Affected users see, in plain language, how
many payments are overdue, whether the limit is reached, whether ordering is
allowed right now, and a timeline of what has happened and what happens next.

The client's rule as stated on 2026-09-21: *"If a branch/user has 2 overdue
payments, new ordering should be blocked until the payment issue is resolved.
Head Office can allow an overdue user/branch to keep ordering for one month as
an exceptional case."*

## What the investigation found (2026-09-21)

### There is no source of truth for "overdue payment" in production

The only payment fact anywhere in the schema is `orders.payment_status`
(`UNPAID` / `PAID`, `db/schema.ts:496`) — a two-value flag toggled by hand by
`SUPER_ADMIN` once an order is fulfilled and delivered
(`app/api/v1/orders/[id]/payment-status/route.ts`). There is **no due date, no
payment terms, no invoice table, no receivable, no balance, no credit limit**
on `orders`, `organizations`, `branches` or `organization_settings`.
`invoice_sequences` is a per-tenant counter that mints the number printed on
the receipt; the receipt itself is a point-in-time snapshot in
`orders.receipt_data`. "Overdue" needs a due instant plus elapsed time and
neither exists.

`budgets` / `budget_addons` are **not** a payables ledger. They are the
branch's internal spending allowance (`remaining = allocated + credited −
spent − held`, `lib/budget-addon-expiry.ts`): money the branch is *permitted
to spend*, not money it *owes*. A budget can never go negative
(`budgets_values_valid_ck`). They share vocabulary with accounting and
nothing else. Budget deficit ≠ overdue payment.

**Consequence:** the overdue *count* cannot be computed from anything in the
database today. This plan therefore builds every part of the feature that is
independent of that count, and leaves the count behind one replaceable seam
(`lib/server/overdue-payment-source.ts`) that returns "not configured" until
the client decides what an overdue payment is and where it is recorded. With
the seam in that state the gate is wired but inert: **nothing is blocked in
production by this change.**

### Order-creation paths (the enforcement points)

There is no shared `createOrder()` helper. Two independent, hand-rolled
implementations write live orders, each inside its own transaction:

| Path | Role(s) | Branch authority | Insert |
|---|---|---|---|
| `POST /api/v1/orders` (`app/api/v1/orders/route.ts`) | every role; HEAD_OFFICE / SUPER_ADMIN may name a branch in the body, every other role gets `session.user.branchId` (`getCreationBranchId`, ~L581) | `validateCreationBranch` pins the branch to the tenant | `processOrderCreationTransaction` (~L534) → `persistCreatedOrder` |
| `POST /api/v1/group-portal/orders` → `lib/server/group-order-creation.ts` | `GROUP_ORDER_PORTAL` only | `resolveSubmissionScope` → `resolveScopedBranchIds` (assignment-derived, fail-closed) | `createBranchOrder` (~L611), **one transaction per branch** |

No Server Action creates an order. Four legacy-import CLI scripts
(`scripts/import-ke-*.ts`) insert historical, already-fulfilled orders by raw
SQL, outside any session; they are ledger-neutral by design and are out of
scope for a live eligibility gate.

The gate is therefore one **shared rule** with **two call sites**, pinned by a
contract test the same way `settleDueAddonsOnBudget` is pinned
(`lib/server/budget-addon-expiry.test.ts`).

### Existing patterns reused

- **Time-bound grant that expires on its own** — `budget_addons.valid_until` +
  `expired_at`; liveness is `now < validUntil`, computed on every read, never a
  stored boolean (`isAddonDue`, `lib/budget-addon-expiry.ts:59`). Dates are
  resolved in Asia/Karachi (`lib/date-range-params.ts`).
- **Privileged-action audit** — `audit_logs` row written *inside* the same
  transaction as the state change (`lib/server/budget-addon-expiry.ts:105`,
  `app/api/v1/budgets/route.ts:748`), SCREAMING_SNAKE `action`, before/after
  values in `metadata`.
- **Role gate** — `requireApiRole([...])` with both `"SUPER_ADMIN"` and
  `"HEAD_OFFICE"` spelled out; there is no role hierarchy in force
  (`requireMinimumRole` exists in `lib/rbac.ts` and is unused). A pure
  role-predicate module beside it (`lib/money-budget-access.ts`) is the shape
  to copy.
- **Business rejection** — thrown `Error` classified by the route
  (`getOrderCreationErrorResponse`, `toUserFacingReason`). This feature adds a
  typed `PaymentControlBlockedError` carrying a stable `code` and a safe
  payload, mapped to **409** in the single-branch route and to a per-branch
  `failed` result in the group route.
- **Timeline** — `buildStatusTimeline` (`lib/order-utils.ts:92`) →
  `{ key, label, description, state }[]`, rendered as an `<ol>` stepper in
  `app/(portal)/orders/[orderId]/page.tsx`.
- **Confirmation** — `components/premium/premium-confirm-dialog.tsx`
  (`type: "warning"`, `isLoading`).

## Decisions

1. **The block and the exception belong to the branch.** `orders.branch_id`
   is the owner of an order; budgets are per branch; group orders spend the
   branch's budget; the repository's own rule is "the branch owns its orders —
   writes follow branch assignment, not authorship". A user is transient
   (moves branches, several users order for one branch) and any future
   invoice is addressed to the branch. The client's "user/branch" wording does
   not need two systems. If the client later insists on a user-level block, the
   resolver takes `userId` in its context and a user-keyed source can be added
   behind the same seam; the exception stays branch-keyed.
2. **State is derived, never stored.** The only persisted fact this feature
   adds is the exception grant. `CLEAR` / `WARNING` / `BLOCKED` are computed at
   read time from the overdue summary, the latest exception row and `now`.
   "Blocked with an active exception" is `state: BLOCKED` + `exceptionActive:
   true` + `orderingAllowed: true`, not a fourth state — the overdue condition
   is still unresolved and the UI says so.
3. **`NOT_CONFIGURED` is a real, visible state**, distinct from `CLEAR`. It
   means "no overdue-payment source is connected". It never blocks, and the
   Head Office panel says so in words rather than showing "0 overdue" as if
   something had been checked.
4. **Policy numbers live in one object** (`PAYMENT_CONTROL_POLICY` in
   `lib/payment-control-policy.ts`): threshold `2`, exception length one
   calendar month (Asia/Karachi). Both are the client's words and both are
   marked unconfirmed. No grace period is modelled, so the timeline never
   prints a future "ordering stops on …" date.
5. **One active exception per branch.** Granting while one is live is a 409;
   granting after expiry or revocation is allowed (the row is new, the old
   one stays as history). This is a consistency invariant, not a stance on
   how often Head Office may grant.
6. **Early revocation is implemented as a corrective action** (audited,
   `SUPER_ADMIN` / `HEAD_OFFICE`, tenant-fenced). Without it a mistaken grant
   would stand for a month with no way to undo it. This is an engineering
   choice, flagged for client confirmation (open question 8).
7. **Expiry is `now < expires_at`**, computed on every read and inside the
   order transaction. No job is needed for correctness. No sweep is added yet;
   if notifications are wanted later, copy
   `app/api/v1/budgets/cron/expire-addons/route.ts`.
8. **The check runs first inside the order transaction**, before the budget
   lock, once the branch is authoritative (session for single-branch roles,
   `resolveSubmissionScope` for the group portal). It reads committed state at
   that instant. Concurrent orders do not change each other's eligibility (the
   inputs are the overdue source and the exception row, not a consumed
   quantity), so no additional lock is taken; a revoke that commits between
   the read and the insert is the same as an order placed a moment before the
   revoke.

## Acceptance criteria (for the part built now)

1. `resolveBranchPaymentControl` returns `orderingAllowed: true` and
   `state: "NOT_CONFIGURED"` for every branch while no source is connected;
   no existing order flow changes behaviour.
2. With a configured source (unit/integration tests inject one): 0 overdue →
   `CLEAR`; 1 → `WARNING`, allowed; ≥ threshold → `BLOCKED`, refused with
   `PAYMENT_CONTROL_BLOCKED`; an active exception → allowed; at
   `expires_at` → refused again; revoked → refused; count back to 0 → `CLEAR`.
3. `POST /api/v1/orders` returns **409** `{ error, code:
   "PAYMENT_CONTROL_BLOCKED", paymentControl: {...} }` for a blocked branch;
   `POST /api/v1/group-portal/orders` reports that branch as `failed` with a
   plain reason and still creates the others.
4. `POST /api/v1/payment-control/exceptions` is `SUPER_ADMIN` / `HEAD_OFFICE`
   only; Head Office is fenced to its own tenant; a second live exception is
   409; the grant and its `audit_logs` row commit together.
5. `POST /api/v1/payment-control/exceptions/[id]/revoke` — same gate, same
   fence, audited.
6. `GET /api/v1/payment-control?branchId=` is readable by every role for a
   branch it may order for or manage: single-branch roles their own branch
   only, group roles their resolved assignment set, Head Office its tenant,
   Super Admin anywhere. Granter identity and reason are returned only to the
   manager roles.
7. Ordering users see a banner (warning / blocked / exception-active) with the
   timeline; Head Office sees the state, the timeline and the grant/revoke
   controls behind a confirmation dialog.

## Architecture

| Piece | Layer | File |
|---|---|---|
| Exception rows | persistence | `db/schema.ts` (`paymentControlExceptions`), `drizzle/20260921120000_payment_control_exceptions.sql` |
| Policy constants, state machine, timeline, error class (pure) | domain | `lib/payment-control-policy.ts` + `.test.ts` |
| Who may grant / revoke / view (pure) | domain | `lib/payment-control-access.ts` + `.test.ts` |
| The overdue seam (returns NOT_CONFIGURED today) | server domain | `lib/server/overdue-payment-source.ts` |
| Resolver, gate, grant, revoke, audit | server domain | `lib/server/payment-control.ts` + `.test.ts` (contract) |
| Read status | route | `app/api/v1/payment-control/route.ts` |
| Grant | route | `app/api/v1/payment-control/exceptions/route.ts` |
| Revoke | route | `app/api/v1/payment-control/exceptions/[id]/revoke/route.ts` |
| Gate call sites | route / server | `app/api/v1/orders/route.ts`, `lib/server/group-order-creation.ts` |
| Hook | UI | `lib/hooks/use-payment-control.ts` |
| Banner + timeline + Head Office panel | UI | `components/payment-control/*` |
| Against Postgres | integration | `tests/integration/payment-control-api.test.ts` |

### Schema

```
payment_control_exceptions
  id                  serial pk
  organization_id     int not null → organizations
  branch_id           int not null → branches
  granted_by_user_id  uuid not null → users
  reason              text null
  start_at            timestamptz not null default now()
  expires_at          timestamptz not null            -- never null: never permanent
  revoked_at          timestamptz null
  revoked_by_user_id  uuid null → users
  revoke_reason       text null
  created_at          timestamptz default now()
  check  expires_at > start_at
  index  (branch_id) where revoked_at is null           -- "latest live exception" lookup
  index  (organization_id)
```

Additive only. No backfill, no default rows: an existing branch has no
exception and — with the source unconfigured — no block. Rolling the
application back leaves an unused table.

### Audit

`audit_logs`, entity `BRANCH`, entity id = branch id, same transaction:
- `GRANT_PAYMENT_CONTROL_EXCEPTION` — `{ exceptionId, startAt, expiresAt,
  reason, actorRole, stateBefore }`
- `REVOKE_PAYMENT_CONTROL_EXCEPTION` — `{ exceptionId, revokedAt,
  revokeReason, expiresAt, actorRole, stateBefore }`

No audit row is written for a status read or an order-time check.

### Timeline

Built by `buildPaymentControlTimeline` from facts only:
- one *Payment overdue* step per overdue item that carries a date;
- *Overdue limit reached* and *Ordering stopped* at the date the threshold-th
  item became overdue (null when the source has no dates) — no grace period
  is modelled, so they coincide;
- *Warning* (current) and *Ordering stops if the limit is reached* (upcoming,
  no date) below the threshold;
- *Head Office exception granted* / *active until* / *expires* / *revoked*
  from the exception row;
- *Ordering blocked again* after an expired or revoked exception while the
  condition persists;
- *Payments cleared — ordering restored* as the final upcoming step whenever
  the branch is not clear.

Nothing is emitted when the source is not configured.

## Open questions — need the client (do not resolve in code)

1. What is an overdue payment: which document, which due date, how many days.
2. Where that fact is recorded — a new invoice/payment table in OneFlowe, a
   manual "mark overdue" by Head Office / Apricart, or a feed from an external
   accounting system. This decides what `overdue-payment-source.ts` reads.
3. Is the threshold exactly 2, and per branch (as built) or per user.
4. Is there a grace period between reaching the limit and the block. (None is
   built; the timeline prints no future stop date.)
5. What clears a block — marking the payment paid, a manual clearance, both.
6. Is the exception one calendar month, 30 days, or to the end of a billing
   period. (Calendar month, Asia/Karachi, is built and isolated in
   `PAYMENT_CONTROL_POLICY`.)
7. May Head Office grant again after one expires. (Allowed as built; nothing
   limits frequency.)
8. May Head Office revoke early. (Built as a corrective action; remove the
   route if not wanted.)
9. Should `SUPER_ADMIN` grant exceptions too. (Yes as built — every Head
   Office gate in this codebase lists both roles.)

## Deliberately not built

- Any computation of the overdue count. The seam returns "not configured".
- Any schema for invoices, due dates or payments.
- A grace period, a future block date, or a "clearance" action.
- Cancellation or modification of existing orders when a branch is blocked.
- A sweep job or notification on expiry.
