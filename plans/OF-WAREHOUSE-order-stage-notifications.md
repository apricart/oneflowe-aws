# OF-WAREHOUSE — Warehouse notifications for order stages

## Requirement

The warehouse receives an in-app notification and an email for every order
stage **except the delivery stages**, for the orders of the branches it serves:

| Event | Fired when |
|---|---|
| `CREATED` | An order is created (pending, or approved at creation by tenant policy) |
| `EDITED` | A pending order's lines are edited (requester or Order Desk) |
| `RETURNED` | An approver returns a pending order for correction |
| `RESUBMITTED` | A returned order is corrected and resubmitted |
| `APPROVED` | An order is approved (tenant approver or Apricart Executive) |
| `REJECTED` | An order is rejected |
| `CANCELLED` | An order is cancelled (Order Desk, or Group Order Portal) |
| `REFUNDED` | A refund on the order is approved (Super Admin direct, or approving a request) |
| `FULFILLED` | An order is fulfilled (token hand-off, Super Admin, Order Desk, delivery settling a hand-off, or the 48-hour sweep) |

**Never notified to the warehouse:** In process, Out for delivery, Delivered.
The warehouse records those itself, so no warehouse user is told about them
(product decision, 2026-10-13: "no warehouse user should be notified").

## Decision that widens what the warehouse learns

Until now the warehouse could not tell that a pending, rejected or cancelled
order existed: every warehouse route answers such an order 404 (AC1,
`plans/OF-WAREHOUSE-warehouse-fulfilment-role.md`). The product owner chose to
notify it of those stages anyway. What it learns is bounded:

- A notice carries the order TID, organization name, branch name and the stage
  — **no amount, no person, no free text** (no rejection reason, correction
  comment or cancellation reason), matching the warehouse's JSON reads, which
  name no one.
- AC1 is unchanged. A notice is not access: the order routes still answer a
  non-work order 404, and a notice for one carries no link.

## Who receives it

Every active, undeleted `WAREHOUSE` user whose reach covers the order's branch —
a branch assignment, or a city assignment matching the branch's city key
(`branchCityKeySql`), exactly the union `loadWarehouseReach` computes. Resolved
inside the transaction that changes the order, so a rolled-back change queues
nothing.

The reach is re-checked at send time (email) and at read time (in-app): a user
whose branch or city was withdrawn, or who was deactivated, is not mailed and
no longer sees the notice.

The existing tenant gates (`decisionQueuesNotifications`, "desk orders queue no
notification") are about telling the **customer's** staff; the warehouse is
Apricart's and fulfils desk orders too, so warehouse notices are queued on
those paths regardless.

## Design

- `lib/warehouse-order-notifications.ts` (pure): the event list, template names
  (`WAREHOUSE_ORDER_<EVENT>`), event keys, wording, and the link rule. Recurring
  events (`EDITED`, `RETURNED`, `RESUBMITTED`, `REFUNDED`) require an occurrence
  id in their key (edit timestamp, correction request id, refund id), so the
  second edit is not swallowed by the first's unique key.
- `lib/server/warehouse-order-notifications.ts`: `queueWarehouseOrderNotifications(tx, …)`
  writes `notifications` (`target_role = 'WAREHOUSE'`) and `email_outbox` rows,
  and `deliverClaimedWarehouseEmail` sends them, re-checking the reach.
- `lib/email/warehouse-order.ts`: the email. Its button opens `/warehouse`.
- The outbox scheduler drains every minute (`infra/email-outbox-scheduler.yml`);
  paths that already drain immediately include the warehouse keys.
- `GET` / `PATCH /api/v1/warehouse/notifications` — the warehouse's own list and
  mark-all-read, `requireApiRole(["WAREHOUSE"])`, fenced to the current reach,
  added to `WAREHOUSE_API_RULES`. The shared `/api/v1/notifications` stays closed
  to the role.
- A notification bell in the warehouse workspace header. An approved or
  fulfilled order's notice links to `/warehouse#orders`.

## Hooks (every path that makes each transition)

| Event | Path |
|---|---|
| CREATED | `app/api/v1/orders/route.ts` (`processOrderCreationTransaction`), `lib/server/group-order-creation.ts` |
| EDITED | `app/api/v1/orders/[id]/route.ts` (PATCH), `lib/server/order-desk-edit.ts` |
| RETURNED | `lib/server/order-correction.ts` (`returnOrderForCorrection`) |
| RESUBMITTED | `lib/server/order-correction.ts`, `lib/server/order-desk-orders.ts` |
| APPROVED / REJECTED | `lib/server/order-decision-service.ts` |
| CANCELLED | `lib/server/order-desk-orders.ts`, `lib/server/group-order-cancel.ts` |
| REFUNDED | `app/api/v1/orders/[id]/refunds/route.ts`, `app/api/v1/admin/refunds/route.ts` |
| FULFILLED | `lib/server/order-fulfillment.ts` (`fulfillApprovedOrder`), `app/api/v1/orders/cron/auto-fulfill/route.ts` |

`lib/server/warehouse-order-notifications.test.ts` pins this list, and that
`progressOrderFulfillment` queues nothing for the warehouse.

## Database impact

None. `notifications.target_role` and `email_outbox.recipient_role` are free
text; no migration.

## Risk and rollback

Email volume grows with orders × warehouse users per branch. Rollback is a
revert; queued rows for templates no deliverer recognises are skipped, not
retried.
