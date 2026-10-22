# OF-TRACKING — Order tracking for the Order Initiator and Group Order Initiator

## Requirement

From the Order Initiator Portal (`/shop`) and the Group Order Initiator Portal
(`/group-portal`), a requester opens a separate **Order tracking** page, enters
an order ID or transaction ID, and sees the order's complete status the way a
standard e-commerce tracker shows it: connected steps from placement to
completion, plus the payment status (Paid / Unpaid) and the delivery status
(Not started / In process / Out for delivery / Delivered), each with its own
date and time.

## Design

### Pages

- `/shop/tracking` and `/group-portal/tracking`, both rendering
  `OrderTrackingWorkspace` (`components/orders/order-tracker.tsx`). Both live
  inside each portal's existing layout and proxy area, so nothing in `proxy.ts`
  changes.
- The tracked order is held in the URL (`?reference=`), so a link can be shared
  or opened from an order history row. The shop's order cards and the group
  portal's order side panel each carry a **Track** link; each storefront header
  carries **Track order**.
- With no reference the page lists the caller's recent orders to pick from.

### What the page shows

1. Order header — order id, copyable TID, placed time, branch, PO, group-order badge.
2. **Order journey** — Order placed → Approved → In process → Out for delivery →
   Delivered → Fulfilled, with connecting lines (horizontal on desktop, vertical
   on a phone). Each step carries its own timestamp. A rejected, cancelled or
   refunded order keeps the steps it reached and ends on a red stop marker.
3. Three status cards — **Order** (Pending / Approved / Fulfilled, or the stop),
   **Delivery** (all four fulfilment stages, current highlighted) and **Payment**
   (Unpaid → Paid, with the paid time and, where prices are visible, the total).
4. The approver's rejection reason, cancellation reason or correction note.
5. **Activity** — every recorded event, newest first, including payment and refunds.
6. **Items** — product, code, quantity and unit (no line prices), and where it is
   being delivered.

### Rules (pure, `lib/order-tracking.ts`)

`getOrderTrackingSteps`, `getTrackingSummary`, `getOrderTrackingActivity`,
`stageTimesFromTrail` and `parseTrackingReference`. No database, clock or
session; unit-tested in `lib/order-tracking.test.ts`.

### Timestamps

The `orders` row records approval, rejection, cancellation, delivery,
fulfilment, payment and refund times, but not when In process or Out for
delivery began. Those come from the progress route's own audit rows
(`ORDER_FULFILLMENT_STATUS_UPDATE`, metadata `to`), read the way the delivery
dashboard already reads them. `stageTimesFromTrail` takes the latest entry into
each stage and drops any stage past the order's current one, so a reverted step
never shows as done. No schema change.

## Endpoints

| Route | Roles | Answers |
|---|---|---|
| `GET /api/v1/order-tracking?reference=` | `ORDER_PORTAL`, `GROUP_ORDER_PORTAL` | `{ item: TrackedOrderView }` |
| `GET /api/v1/order-tracking/recent` | same | `{ items: RecentTrackableOrder[] }` (at most 8) |

Order of checks in the lookup: role allowlist (401/403) → session scope → rate
limit (`search`, per user) → reference parsed against an allowlist pattern
(400) → `loadTrackedOrder` (`lib/server/order-tracking.ts`).

## Security

- **Who may track an order is exactly who may read it on the order page.** The
  reference is resolved to an order **inside the caller's own organization**
  (by TID, also lower-cased, or by numeric id), and that order is then put
  through `canReadOrderDetail` (`lib/server/order-read-access.ts`): the Order
  Initiator its own orders and its branch's group orders at its own branch; the
  Group Order Initiator any order at a branch in its resolved assignment set
  (an empty set reads nothing). No second rule is written, so the tracker and
  the order page cannot drift.
- Not found, another tenant's, and out of scope all answer the same 404 and
  message, so the lookup cannot confirm that an id exists.
- The reference never reaches SQL as text: it is checked against
  `^[A-Za-z0-9_-]{1,64}$` and bound as a parameter; a numeric id is bounded to
  the `serial` range.
- No person is named (no creator, approver or fulfiller), no token, no
  organization id. Line prices are never returned; the order total is returned
  only when `shouldHidePricesForRole` allows it for the caller's role.
- The recent list is a strict subset of what the lookup admits (own orders and,
  for the Order Initiator, its branch's group orders) and carries no amounts.
- Read-only: nothing is written and nothing is audited. Responses are
  `private, no-store`.

## Tests

- `lib/order-tracking.test.ts` — the step, card, activity, trail and reference rules.
- `tests/integration/order-tracking-api.test.ts` — 401/403 role matrix; own order
  by TID, upper-case TID, id and `#id`; branch group order visible to the Order
  Initiator; colleague's order, a Head Office order and another branch's group
  order refused; another tenant's order refused by id and by TID; the Group Order
  Initiator's assigned-branch reach, an unassigned branch and a stale
  cross-tenant assignment; malformed references; hidden prices; the recent list
  per role. The warehouse isolation and write sweeps cover the new handlers.

## Database impact

None. No migration. Reads use the existing `orders` (pk, unique `tid`),
`order_items_order_idx`, `refunds_order_idx` and `audit_entity_lookup_idx`.

## Risk and rollback

Additive: two new read-only endpoints, two pages and three links. Removing the
links and the `tracking` folders reverts it; no data is involved.
