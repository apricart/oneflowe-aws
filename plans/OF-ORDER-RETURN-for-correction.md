# OF-ORDER-RETURN — Return an order to its requester for correction

## Objective

An approver can send a pending order back to the people who raised it with a
comment saying what to fix. They correct it with the edit they already have, and
send the **same order** back for approval. This can go round as many times as
needed; every round is kept.

## Acceptance criteria

1. An approver who may decide an order — `BRANCH_ADMIN` / `HEAD_OFFICE` when
   they are the tenant's configured approver, and `GROUP_USER` within its
   assigned branches — can return a `PENDING` order with a required comment
   (1–1000 characters). This is the same rule as approve/reject, enforced by
   `authorizeOrderDecision`, inside the same transaction.
2. A returned order stays `PENDING`. Its budget hold, quantity-budget hold and
   stock reservation stay exactly as they were. Nothing in the ledger moves.
3. While it is returned, the order **cannot be approved** (409). It **can still
   be rejected**, which closes the open return as `REJECTED`.
4. A requester who may edit the order — `ORDER_PORTAL` at the order's branch,
   `GROUP_ORDER_PORTAL` across its assigned branches (`lib/order-write-access.ts`,
   "the branch owns its orders") — can edit it through the existing
   `PUT /api/v1/orders/{id}` and then resubmit it with an optional note
   (≤1000 characters). Resubmitting does not require an edit.
5. Resubmitting clears the returned state, records who and when, and puts the
   order back in front of the approvers. A resubmission by someone other than
   the raiser is recorded `onBehalfOfUserId` and the raiser is told, as edits are.
6. The person who raised the order is notified of a return (in-app and email —
   including a `GROUP_ORDER_PORTAL` raiser, which decision emails never reached);
   the configured approvers are notified of a resubmission. A second round
   produces new notifications rather than colliding with the first round's.
7. Every return and resubmission is audited (`ORDER_RETURNED_FOR_CORRECTION`,
   `ORDER_RESUBMITTED`) on the same transaction as the change.
8. Every order surface that shows status shows "Returned for Correction" and the
   comment; the order detail shows the full history of rounds.
9. Double submission, concurrent approve/return and concurrent
   return/resubmit each have exactly one winner.

## Design decisions

* **A returned order stays `PENDING`, with a flag — not a new status.** Every
  money reader keys on status (`lib/budget-consumption.ts`, its SQL twin, the
  parity contract): consumption is `spent + held`, the hold belongs to pending
  and approved orders, and a new status would have to be threaded through every
  one of them or the ledger and the orders figures would disagree. A flag on a
  `PENDING` row leaves all of that untouched, and the existing PENDING-only edit
  needs no change at all.
* **The hold is kept while returned.** Releasing it and re-taking it on
  resubmission would let the money be spent elsewhere in between, so the
  corrected order could then fail for budget. Keeping it is also what a pending
  order already does; a returned order that is never resubmitted is cleared the
  way any pending order is — by rejecting it.
* **The current round lives on `orders`, every round in
  `order_correction_requests`.** The three columns mirror the existing
  `rejected_at / rejected_by_user_id / rejection_reason` idiom, so list reads
  stay a column read (and defensive, like the other late columns); the table
  is the trail the detail view renders. Both are written in one transaction
  under the order's row lock.
* **The flag lives on the order row so the guards are row-level.** Approve and
  return both claim with `UPDATE … WHERE status = 'PENDING' AND
  returned_for_correction_at IS NULL`; under READ COMMITTED a concurrent update
  re-evaluates that predicate on the new row version, so exactly one wins.
* **No new `Permission` key.** Approve and reject are authorized by
  `authorizeOrderDecision`, not by `ORDER_APPROVE`; returning is the third
  decision and uses the same policy. A new key would need a `role_permissions`
  re-seed on production for nothing.
* **Not gated by the payment-control or unacknowledged-delivery blocks.** Those
  gate *new* orders only; a resubmission creates nothing, just as an edit is
  not gated.

## Data

Migration `20261006120000_add_order_correction_requests.sql` (hand-written,
additive, `when` after the last applied entry):

* `orders.returned_for_correction_at timestamptz NULL`
* `orders.returned_for_correction_by_user_id uuid NULL → users.id`
* `orders.correction_request_note text NULL`
* `orders_correction_state_ck`: all three null, or all three set **and**
  `UPPER(status) = 'PENDING'`. A returned flag can never outlive the pending
  state, whatever path moves the status.
* `order_correction_requests` — `order_id` (FK, `ON DELETE CASCADE`, so the
  administrative delete keeps working), `organization_id`, `branch_id`,
  `requested_by_user_id`, `requested_by_role`, `comment`, `requested_at`,
  `resolution` (`RESUBMITTED` | `REJECTED` | null = open), `resolved_at`,
  `resolved_by_user_id`, `resolved_by_role`, `response_note`.
  Partial unique index: one open round per order. Checks on resolution values,
  the open/closed shape, and comment/note length.

Every existing row is null / absent, so no constraint has anything to reject.
**Apply before deploying** — the approve claim reads the new column.

Rollback: drop the table, the check, the FK and the three columns (statement
list in the migration header). Any order still returned simply becomes an
ordinary pending order.

## API

| Method | Path | Roles | Body |
|---|---|---|---|
| POST | `/api/v1/orders/{id}/return-for-correction` | `BRANCH_ADMIN`, `HEAD_OFFICE`, `GROUP_USER` | `{ comment }` |
| POST | `/api/v1/orders/{id}/resubmit` | `ORDER_PORTAL`, `GROUP_ORDER_PORTAL` | `{ note? }` |

Statuses: 400 bad id / body (strict schema, unknown fields refused); 401 no
session; 403 role or decision policy refuses; 404 not found **or out of the
requester's branch scope** (matches the edit path); 409 not pending / already
returned / not returned / lost a race; 429 rate limited.

Read additions (all additive): `returnedForCorrectionAt`,
`correctionRequestNote` on the order list, order detail, Group approval queue
and group order history; `correctionHistory` on the order detail;
`capabilities.canReturnOrders` alongside the existing decision capabilities.

## Security

* Authentication from the session only; actor role/tenant/branch re-read from
  `users` inside the transaction on both endpoints.
* Return: `authorizeOrderDecision` (tenant, branch, configured approver role,
  GROUP_USER assignment set read in-transaction, organization row `FOR SHARE`).
* Resubmit: the order is located by id **and** the actor's tenant, locked
  `FOR UPDATE`, then `canRequesterActOnOrder` / `canRequesterEditOrder` against
  the branch set re-resolved in-transaction. Out of scope reads as 404.
* Free text is stored as text, rendered by React (escaped) and HTML-escaped in
  email. No price data is added to any response.
* Rate limited with the `order` bucket, as the requester edit and group
  decisions are.
* `ORDER_DESK` is refused by `proxy.ts` (not in `ORDER_DESK_API_RULES`) and by
  each route's role allowlist; desk orders are created `APPROVED` anyway.
* Email delivery re-checks scope at send time. A `GROUP_ORDER_PORTAL`
  recipient must still be the raiser and still be assigned the order's branch;
  a resubmission email is dropped if the recipient is no longer the configured
  approver — the same rule `ORDER_CREATED` already has.

## Also fixed

`notifyRaiserOfOrderWrite` keyed its notice on `type:orderId` with a plain
insert against a unique index, so the **second** colleague edit of the same
order failed with a unique violation and the edit returned 500. Correction
rounds make repeated edits routine, so it now inserts `ON CONFLICT DO NOTHING`
(the stated intent: one notice per order and event) and callers may pass a
discriminator; the resubmission notice is keyed per round.

## Tests

* Unit — `lib/order-correction.test.ts` (transition rules, comment bounds,
  event keys), `lib/order-status.test.ts` additions (derived label), email
  template (escaping, links per recipient role), schemas.
* Contract — audit coverage (`VIA_LIB`), approver contract (return route role
  list), a new `lib/server/order-correction-contract.test.ts` (both routes
  delegate; the approve claim requires the flag clear; reject clears it).
* Integration — `tests/integration/order-correction-api.test.ts`: full cycle
  with ledger and stock unchanged, edit-while-returned moves the hold by the
  difference, approve blocked while returned, reject while returned, two rounds
  with distinct notifications, group order raised by `GROUP_ORDER_PORTAL`,
  colleague resubmission notifies raiser, 401/403/404/409/400, cross-tenant,
  GROUP_USER outside its assignments, requester outside its branch, approve vs
  return race, the database check, and two colleague edits no longer 500.

## Risks

* Approval breaks if the code ships before the migration (the approve claim
  names the new column). Same rule as the last three releases: migrate first.
* Dashboards still count a returned order as pending — correct for money (it
  still holds budget), and the row is labelled. Not changed here.

## Steps

1. Schema + migration + journal; apply to the test database.
2. Pure rules (`lib/order-correction.ts`), schemas, derived status.
3. Server module (`lib/server/order-correction.ts`), decision-service changes,
   notifications + email.
4. Routes; read-model additions.
5. UI: shared notice, approver detail page, orders directory, Group approver
   sheet, Order Portal shop, Group Order Portal history and branch orders.
6. Unit, contract and integration tests; typecheck, lint, test, build.
