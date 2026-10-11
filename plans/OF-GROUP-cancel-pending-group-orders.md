# OF-GROUP — A group requester may cancel a group order until it is approved

Status: implemented 2026-10-08.

## Requirement

A Group Order Portal user may cancel a group order while it is still waiting
for approval. Once a branch order is approved it can no longer be cancelled.
Decided with the product owner:

- **Who:** `GROUP_ORDER_PORTAL` only, for group orders at any branch in its live
  assignment set — the same reach it already has to edit them
  (`lib/order-write-access.ts`). No other role gains a cancel.
- **What:** one branch order (from its side panel), or every still-pending
  branch order of one of the user's own submissions at once (from the
  submission card). Approved, fulfilled, rejected and already-cancelled branch
  orders are left exactly as they are.
- **Reason:** required, stored on the order and in the audit trail.

## Rule

`lib/group-order-cancel.ts` (pure): a branch order is cancellable when it is a
group order (`group_order_id` set) and its status is `PENDING` — including one
returned for correction, which is still pending. Everything else is refused.

## Server — `lib/server/group-order-cancel.ts`

One transaction per request. Each branch order is read `FOR UPDATE`, its scope
re-checked with `canRequesterActOnOrder` against `resolveScopedBranchIds` read
inside the same transaction, and claimed with `UPDATE … WHERE status = 'PENDING'`,
so an approval racing the cancel has exactly one winner (approve, reject,
return and edit all claim on `PENDING` too). Then, mirroring the Order Desk
cancel and the rejection path:

- status `CANCELLED`, `cancelled_at`, `cancelled_by_user_id`, `cancellation_reason`;
  correction flag cleared and an open correction round closed `CANCELLED`
  (`orders_correction_state_ck` allows the flag only on `PENDING`);
- the money hold released from the order's own period (`budgetPeriodOf`), only
  if the order took one (`orderTakesBudget`), never below zero
  (`BUDGET_LEDGER_INVARIANT` rolls the whole request back);
- the quantity hold released (`releaseHeldQuantityBudgetForOrder`);
- stock put back on every line;
- `ORDER_CANCELLED` in `audit_logs` per order (with `onBehalfOfUserId` when the
  order was raised by someone else), and the raiser notified
  (`ORDER_CANCELLED_BY_COLLEAGUE`) on the same transaction; a submission cancel
  also writes `CANCEL_GROUP_ORDER` to `group_audit_logs`.

The Order Desk cancel is deliberately not refactored: it is live and pinned by
its own contract tests. The release is mirrored, and the new module joins the
same contract inventories (`LEDGER_MOVERS`, `LEDGER_PERIOD_WRITERS`, audit
coverage).

## Routes

- `POST /api/v1/group-portal/branch-orders/[orderId]/cancel` — one branch order.
- `POST /api/v1/group-portal/orders/[groupOrderId]/cancel` — every pending branch
  order of a submission the caller raised (matched to creator and tenant, like
  the tokens route); 409 when none is pending.

Both: `requireGroupOrderPortal`, write rate limit, `{ reason }` validated strictly,
404 for anything outside the caller's scope (indistinguishable from missing),
409 for a non-pending order or a lost race.

## Read side — already handles `CANCELLED`

`CANCELLED` is a first-class status: the "Rejected" filter includes it
(`getOrderStatusesForFilter`), it derives to "Cancelled", reports count it with
rejections, budget consumption treats it as "none", and the ordering blocks do
not count it. The group history rows gain `cancelledAt`/`cancellationReason`
(additive) so the reason shows beside the order.

## Not in scope

No cancel for any other role or for non-group orders; approvers are not sent a
new notification (their pending queue simply no longer lists the order).
