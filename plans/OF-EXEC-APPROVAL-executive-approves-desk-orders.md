# OF-EXEC-APPROVAL — Apricart Executives approve Order Desk orders

Status: **implemented — unit, contract and integration gates green on the test database; migration not yet applied to staging or production; Playwright spec updated but not run**
Date: 2026-10-07
Jira: _to be assigned_
Builds on: `plans/OF-ORDER-DESK-internal-order-entry.md`,
`plans/OF-DELIVERY-management-delivery-dashboard.md`,
`plans/OF-ORDER-RETURN-for-correction.md`

---

## 1. What was asked

Give the Apricart Executive role (`APRICART_EXECUTIVE`, today read-only on the
delivery dashboard) the right to approve orders, under two strict conditions:

1. **Only orders created by the Order Desk** (`orders.created_by_role = 'ORDER_DESK'`).
2. **Only in organizations assigned to that executive.**

Decisions taken with the requester (2026-10-07):

| Question | Answer |
|---|---|
| When does a desk order wait for approval? | **Always.** Every desk order starts `PENDING`, whatever the organization's own approval switch says. |
| What may the executive do with it? | **Approve, Reject, Return for correction.** |
| May the customer's own approvers (Head Office / Branch Admin / Group User) decide a desk order? | **No — executive only.** |

### Acceptance criteria

- AC1 A desk order is created `PENDING`, with no approver, no approval token,
  and its budget hold, quantity hold and stock taken exactly as today.
- AC2 An executive approves, rejects (reason required) or returns (comment
  required) a pending desk order in an organization assigned to them.
- AC3 An executive cannot decide: a non-desk order; a desk order in an
  organization not assigned to them; anything after their account is
  deactivated, deleted or the assignment removed. All read as **404**.
- AC4 Head Office, Branch Admin and Group User cannot approve, reject or return
  a desk order (**403**), and their screens do not offer it.
- AC5 The customer's Order Portal / Group Order Portal users cannot edit or
  resubmit a pending desk order (**404**).
- AC6 Only Super Admin assigns organizations to an executive; every change is
  audited.
- AC7 The desk can edit and cancel a pending desk order, edit and resubmit a
  returned one, and still cancel / fulfil / request refunds as today once
  approved. It can no longer edit an order after approval.
- AC8 Approving an order that the desk edited after the executive loaded it is
  refused (**409**), so an executive never approves lines they did not see.
- AC9 Nothing changes for any order that is not a desk order, or for any
  existing desk order already `APPROVED`.

## 2. Findings that shaped the design

- **F1 — Desk orders skip approval today.** `resolveInitialOrderApproval`
  makes them `APPROVED` at creation (OF-ORDER-DESK D5). There is nothing
  pending to approve until that changes.
- **F2 — One decision service, one authorizer.** `approveOrder`, `rejectOrder`
  (`lib/server/order-decision-service.ts`) and `returnOrderForCorrection`
  (`lib/server/order-correction.ts`) all call `authorizeOrderDecision` inside
  their own transaction. No other code moves an order from `PENDING` to
  `APPROVED`. Putting the executive and the exclusivity rule into that one
  authorizer covers every decision path, including the Group Portal bulk
  decide route.
- **F3 — A pending order "belongs to the branch".** The requester edit
  (`PUT /api/v1/orders/[id]`) and the resubmit route let any Order Portal /
  Group Order Portal user at the branch write to a pending order, whoever raised
  it (`lib/order-write-access.ts`). Desk orders were never pending, so this was
  never reachable. Once they are, the customer's staff could rewrite an order
  Apricart keyed in, so it must be fenced (AC5).
- **F4 — The desk edit only accepts `APPROVED`.** `lib/server/order-desk-edit.ts`
  and `cancelDeskOrder` assume a desk order starts Active. Both move to the new
  lifecycle.
- **F5 — Decision notifications would throw or warn.**
  `queueSuperAdminApprovalNotifications` throws `ORDER_NOTIFICATION_SCOPE_INVALID`
  when the deciding role is not the tenant's configured approver, which would
  roll back an executive approval. Desk orders notify no one (OF-ORDER-DESK
  D8), so executive decisions skip the notification calls explicitly.
- **F6 — Delivery stays safe.** The Super Admin progress route requires
  `APPROVED`, so a pending desk order cannot be delivered or fulfilled.
- **F7 — The executive is not price-restricted.** `lib/price-visibility.ts`
  restricts Branch Admin and Order Portal only. The approval screen shows
  amounts and lines. The delivery dashboard keeps carrying no money and no
  people.

## 3. Decisions

### D1 — Every desk order starts `PENDING`

`resolveInitialOrderApproval` returns the pending values for an `ORDER_DESK`
creator, whatever `organizations.order_approval_required` says. The creation
log records `approvalBasis: "APRICART_EXECUTIVE_APPROVAL"` so the trail says why
an order at an auto-approving tenant is pending. `orderDeskBypassesApproval` is
replaced by `orderDeskRequiresExecutiveApproval`. Existing `APPROVED` desk
orders are left alone. Creation still queues no notification.

### D2 — Executive reach: Super Admin's organization assignments

A new table `apricart_executive_assignments (user_id, organization_id)`, unique
per pair. Reach is resolved by a pure rule in `lib/apricart-executive-access.ts`
(`resolveExecutiveApprovalReach`) from rows re-read on every request by
`lib/server/apricart-executive-scope.ts`:

- the account is `APRICART_EXECUTIVE`, active, and not deleted; and
- the organization is assigned to it.

Organization status and `managed_ordering` are deliberately **not** required.
Only an executive can decide a desk order (D3), so if an organization stopped
being managed while desk orders were pending, requiring the flag would strand
those orders and their budget holds and stock. An empty reach matches nothing.

Any organization may be assigned. Granting one with no desk orders is harmless.

The executive's account stays organization-less, and the delivery dashboard
stays cross-tenant. The assignment governs **approval only**.

### D3 — Who decides is fixed by where the order came from

The pure rule `orderDecisionAuthority(order)` lives in `lib/order-desk-approval.ts`:

| Order | Decided by |
|---|---|
| `created_by_role = 'ORDER_DESK'` | `APRICART_EXECUTIVE` with the organization assigned |
| anything else | the tenant's configured approver / Group User, exactly as today |

`authorizeOrderDecision` dispatches on the caller:

- **Executive.** The account is re-read. The order must be a desk order, and the
  assignment row for its organization is read `FOR SHARE` inside the deciding
  transaction, so a Super Admin removing the grant waits for an in-flight
  decision. The branch must belong to the order's organization. Anything
  outside this reads as `not-found`, so the executive cannot enumerate orders.
  `decisionRole` is `APRICART_EXECUTIVE`.
- **Tenant roles.** The existing checks are unchanged, plus one refusal: a desk
  order returns `forbidden`.

`OrderDecisionRole` gains `APRICART_EXECUTIVE` (label "Apricart Executive"), so
audit rows record who really decided. The `ORDER_APPROVED`, `ORDER_REJECTED`
and `ORDER_RETURNED_FOR_CORRECTION` audit rows are written by the shared
service as today.

### D4 — Executive decisions queue no notification

Desk orders notify no one (OF-ORDER-DESK D8). The service skips the creator and
Super Admin notification calls when `decisionRole` is `APRICART_EXECUTIVE`,
explicitly, rather than relying on the creator lookup finding nobody. The desk
sees the outcome on its list; Super Admin sees approved orders on Orders.
(E-mail to the desk or to Super Admin is a possible follow-up.)

### D5 — Approve what was seen

The executive's approve request carries `expectedUpdatedAt`, the order's
`updatedAt` as listed. `approveOrder` takes it as an optional input and adds
`date_trunc('milliseconds', updated_at) = expected` to its claim. A desk edit
in between moves `updatedAt`, so the claim matches nothing and the result is
409. Existing callers pass nothing and behave exactly as before.

### D6 — The desk's lifecycle

| State | The desk may |
|---|---|
| Pending, awaiting approval | **Edit**, **Cancel** |
| Pending, returned for correction | **Edit**, **Resubmit**, **Cancel** |
| Active, not delivered | **Cancel** (no edit — it would change what was approved) |
| Active, delivered | **Fulfil** |
| Fulfilled | **Request refund** |
| Rejected / Cancelled | nothing |

- **Edit** (`order-desk-edit.ts`) accepts `PENDING` only. A desk order already
  `APPROVED` before this change cannot be edited any more; it can still be
  cancelled before delivery.
- **Cancel** accepts `PENDING` or `APPROVED` and not delivered. On a returned
  order it clears the correction flag (`orders_correction_state_ck` allows the
  flag only on `PENDING`) and closes the open round with resolution
  `CANCELLED`, a new value added to `order_correction_requests_resolution_ck`.
- **Resubmit** is a new route, `POST /api/v1/order-desk/orders/[id]/resubmit`
  `{ note? }`, through the desk's `manage` reach. It mirrors
  `resubmitOrderForApproval`: lock, `resubmissionRefusal`, conditional claim,
  close the round `RESUBMITTED`, audit `ORDER_RESUBMITTED`. It queues no
  notification, because the requester path's would e-mail the customer's
  approvers.
- **Tabs.** `awaiting_approval` is new and the default; it holds `PENDING`
  orders, with returned ones flagged. `rejected` is new. The existing tabs are
  unchanged.

### D7 — The customer's requesters keep off desk orders

`lockOrderEditAccess` (`PUT /api/v1/orders/[id]`) and `resubmitOrderForApproval`
refuse a desk order as `not-found`, before any write. Refund requests are
untouched: they need a fulfilled order, and that rule predates this change.

### D8 — The customer's screens say who decides

`GET /api/v1/orders` (list items) and `GET /api/v1/orders/[id]` add a derived
`decidedByApricart: boolean`. `OrdersDirectory` and the order detail hide
Approve / Reject / Return on such orders and show "Awaiting Apricart approval".
The dashboard's "awaiting your approval" prompt excludes them as well.

### D9 — Executive API

These routes are added to `APRICART_EXECUTIVE_API_RULES`. Each one also checks
`requireApiRole(["APRICART_EXECUTIVE"])` and the live reach itself, is rate
limited, and is served `private, no-store`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/v1/executive/approvals` | query: `status` (`awaiting_approval` default, `returned`, `approved`, `rejected`, `all`), `organizationId`, `q`, `page`, `limit` (≤ 50) | Desk orders in reach, with tab counts, the lines, the amounts, the channel and reference, the desk user's name, and the open correction comment. |
| POST | `/api/v1/executive/approvals/[id]/approve` | `{ expectedUpdatedAt }` | `approveOrder` |
| POST | `/api/v1/executive/approvals/[id]/reject` | `{ reason }` (1–500) | `rejectOrder` |
| POST | `/api/v1/executive/approvals/[id]/return` | `{ comment }` (1–1000) | `returnOrderForCorrection` |
| GET | `/api/v1/executive/approvals/[id]/attachment` | — | The customer's screenshot, served as the desk route serves it. |

Bodies are strict Zod objects (unknown keys refused). A response never includes
the approval token: the executive does not hand off fulfilment, and the desk
fulfils without a token.

### D10 — Super Admin assigns

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/apricart-executives` | Executives (name, e-mail, active), their organizations, and every organization (id, name, code, status, managed). |
| PUT | `/api/v1/apricart-executives/[userId]/organizations` | `{ organizationIds: number[] }` (≤ 200, unique, existing). Replaces the set in one transaction, audited as `UPDATE_APRICART_EXECUTIVE_ASSIGNMENTS` with before and after. A user that is not an executive is 404. |

Both are `requireApiRole(["SUPER_ADMIN"])`. The UI is a new section on the
existing Order Desk Team page (`/desk-team`), "Order approvers (Apricart
Executive)". Each executive has an *Organizations* dialog of checkboxes.

### D11 — Executive workspace

`/executive` gains two tabs: **Delivery** (today's dashboard, unchanged) and
**Approvals (n)**. Approvals shows the order list with tabs and counts, a detail
panel (lines, totals, channel, reference, screenshot, notes, PO, returned
comment) and three actions. Approve asks for confirmation. Reject asks for a
reason. Return asks for a comment. Each button is disabled while its request is
in flight.

## 4. Data

Migration `drizzle/20261010120000_add_apricart_executive_order_approval.sql`,
additive:

- `CREATE TABLE apricart_executive_assignments` (`id serial`,
  `user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE`,
  `organization_id integer NOT NULL REFERENCES organizations ON DELETE CASCADE`,
  `created_by_user_id uuid`, `created_at timestamptz DEFAULT now()`), with
  unique `(user_id, organization_id)` and an index on `organization_id`.
- `order_correction_requests_resolution_ck` is re-created to admit
  `'CANCELLED'`. The table is small, and the new check is a superset of the old,
  so every existing row passes.
- No backfill. Existing desk orders keep their status.

**Apply before deploying.** The decision authorizer reads the new table.

Rollback: redeploy the previous image, which never reads the table; the table
can stay. To remove it: `DROP TABLE apricart_executive_assignments;` and
re-create the check without `CANCELLED`, but only once no row holds it.

## 5. Security

- **Authentication.** Session via `requireApiRole` / `getRequestScope`. No id,
  role or organization is taken from a request.
- **Authorization.** The proxy allowlist is the first layer. Every handler
  re-checks the role, and `authorizeOrderDecision` re-reads the account and the
  assignment **inside the deciding transaction**, with `FOR SHARE` on the
  assignment.
- **Tenant isolation.**
  - An executive reaches only desk orders in assigned organizations; the list
    query ANDs every filter with that reach.
  - Tenant roles lose the ability to decide desk orders, and gain nothing.
  - A branch whose organization disagrees with the order's is refused.
- **Enumeration.** Out of reach is 404 for the executive and for requesters.
  Tenant approvers keep their existing 403 for out-of-tenant orders.
- **Mass assignment / validation.** Strict Zod schemas; the reason and comment
  are bounded; ids are positive integers; `organizationIds` is bounded and
  de-duplicated.
- **Replay / races.** Each transition is a conditional claim (`status =
  'PENDING'`, plus the correction flag and `expectedUpdatedAt` for approve), so
  a double click or a race between approve and cancel / edit / reject moves the
  ledger exactly once.
- **Audit.**
  - Decisions: `ORDER_APPROVED`, `ORDER_REJECTED` and
    `ORDER_RETURNED_FOR_CORRECTION`, with `decisionRole: APRICART_EXECUTIVE`.
  - Desk actions: `ORDER_RESUBMITTED`, and `ORDER_CANCELLED` with
    `before.status`.
  - Assignment changes: `UPDATE_APRICART_EXECUTIVE_ASSIGNMENTS`.
- **Screenshot.** It holds customer personal data. It is served only to an
  executive whose reach covers the order, `private, no-store`, sandboxed, the
  same way the desk route serves it.
- **Escalation.** An executive still cannot fulfil, deliver, refund, edit, or
  write a price, user or budget. The new routes are the only writes added to
  the role.

## 6. Tests

- **Unit**
  - `lib/order-desk-approval.test.ts`: the authority rule.
  - `lib/apricart-executive-access.test.ts`: the reach rule (inactive, deleted,
    wrong role, unassigned, empty), the new allowlist entries, and that every
    listed handler admits the role itself.
  - `lib/order-desk-access.test.ts`: `deskOrderActions` for every state.
  - `lib/order-desk-query.test.ts`: the new tabs and stages.
  - `lib/server/order-creation-approval.test.ts`: the desk case is now
    `PENDING`. This deliberately reverses the old assertion, because the
    requirement changed.
  - `lib/order-approver-role.test.ts`: the new decision role and its label.
- **Contract**
  - Every executive decision route goes through the shared service.
  - The authorizer reads the assignment `FOR SHARE`, inside the transaction.
  - Tenant roles are refused on desk orders.
  - The requester edit and resubmit refuse desk orders.
  - The new mutating routes are classified in the activity-audit coverage test.
- **Integration** (`tests/integration/executive-desk-approval-api.test.ts`)
  - 401 / 403 for each other role on every route.
  - Approve, reject and return happy paths: status, `approved_by`, token
    stored, audit `decisionRole`.
  - Reject releases the hold, the quantity hold and the stock, with a
    hand-worked ledger.
  - Refused (404): an unassigned organization, a non-desk order, an inactive or
    deleted executive, and an assignment removed.
  - A returned order cannot be approved until the desk resubmits it.
  - A stale `expectedUpdatedAt` is 409.
  - Head Office, Branch Admin and Group User are 403 on a desk order, and still
    decide portal orders.
  - Order Portal edit and resubmit of a desk order are 404.
  - Desk: pending edit, resubmit, and cancel of a returned order (round closed
    `CANCELLED`); no edit after approval.
  - Races: approve vs cancel and double approve, where the ledger moves once.
  - Super Admin assignment: replace, audit, 404 for a non-executive, and 403 for
    Head Office.
  - The list never shows another organization's or a non-desk order, and a
    filter cannot widen it.
- **Existing suites updated deliberately:** `order-desk-api` (desk orders now
  start pending) and the desk component tests.

## 7. Risks

- **Desk orders now wait.** A customer whose organization has no executive
  assigned gets no approvals; the orders hold budget and stock until someone
  acts. The desk can cancel. **Rollout: assign executives on `/desk-team`
  immediately after deploying.**
- **Shared decision code.** The authorizer and service also serve every
  tenant's approvals. The tenant path changes by one refusal, for desk orders
  only. The existing approval, correction and group-decision suites must stay
  green.
- **Customer approvers see pending desk orders they cannot decide.** Their
  pending counts include them, labelled as Apricart's. In practice managed
  customers have no approver accounts yet.

## 8. Steps

1. Pure rules: `lib/order-desk-approval.ts`; executive reach and allowlist;
   `OrderDecisionRole`; desk actions, tabs and stages. Unit tests.
2. Schema and migration; `lib/server/apricart-executive-scope.ts`.
3. Creation: desk orders start `PENDING`.
4. Authorizer and service (executive branch, tenant refusal,
   `expectedUpdatedAt`, notification skip); requester edit and resubmit fence.
5. Desk: edit, cancel and resubmit; list tabs.
6. Executive routes, Super Admin assignment routes, `proxy` allowlist.
7. UI: executive Approvals tab, `/desk-team` approvers section, customer
   decision buttons, desk table.
8. Integration tests, then typecheck, lint, unit, build and integration.
9. Update `CLAUDE.md` (Order Desk and Apricart Executive paragraphs) and the
   OF-ORDER-DESK plan (D5 superseded).
