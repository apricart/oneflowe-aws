# OF-REFUND — Seven-day requester window; no time limit for Super Admin

## Requirement

1. A Super Admin may approve or reject a refund at any time. No time limit applies
   to anything a Super Admin does with a refund.
2. Every role that can raise a refund request today — `HEAD_OFFICE`,
   `BRANCH_ADMIN`, `ORDER_PORTAL`, `GROUP_ORDER_PORTAL` (single-order route and
   Group Order Portal) and `ORDER_DESK` — may raise one only from the moment the
   order is fulfilled until **7 days** after it.

## Before

Every path used one window: the order's **creation** UTC month
(`isSameBudgetPeriod(order.createdAt, now)`), for requesters and Super Admin
alike.

| Path | Who | Window | Delivery gate |
|---|---|---|---|
| `POST /api/v1/orders/[id]/refunds` | requesters, Super Admin (direct, APPROVED) | creation month | requester roles + desk only |
| `POST /api/v1/group-portal/refunds` | `GROUP_ORDER_PORTAL` | creation month | yes |
| `POST /api/v1/admin/refunds` | Super Admin (approve a request / direct refund) | creation month | no |
| `PATCH /api/v1/admin/refunds/[id]` | Super Admin (reject/cancel a request) | none | no |
| `components/refund-management.tsx` | button visibility | creation month | requester roles only |
| `deskOrderActions` | Order Desk "Request refund" flag | none | yes |

## After

One pure module, `lib/refund-window.ts`, states the rule:

- `REQUESTER_REFUND_WINDOW_DAYS = 7`. The window runs from `orders.fulfilled_at`
  to `fulfilled_at + 7 × 24 h`, inclusive of the closing instant. It opens at
  fulfilment rather than at delivery because a requester cannot claim before
  fulfilment anyway (`isOrderPortalRefundEligible`), and every fulfilment path
  requires delivery first — so the requester gets the full seven days.
- An order with no `fulfilled_at`, or an unparseable one, is outside the window.
  Every fulfilment path writes it (`fulfillApprovedOrder`, the auto-fulfil
  sweep, the KE import).
- `requesterRefundBlockReason(order, now)` returns the user-facing reason or null:
  first the fulfilled-and-delivered gate, then the window.
- `isRefundWindowExemptRole(role)` — Super Admin only.

Applied:

- **Requester route**: every non-Super-Admin role (Head Office and Branch Admin
  included, by decision of the product owner) needs fulfilled + delivered and
  the window — before the lock and again against the locked row. Super Admin
  keeps the status check only.
- **Group Order Portal**: `getRequesterRefundBlockReason` takes `fulfilledAt` in
  place of `createdAt`; the read and the in-transaction re-check both select it.
- **Admin route**: the month check is removed. The status check, the capacity
  checks and the row lock stay.
- **UI**: `RefundManagement` takes `fulfilledAt`, applies the same pure rule,
  and shows the deadline. `deskOrderActions` takes `fulfilledAt` and `now`.

## Budget consequence

With the month window gone, Super Admin can approve a refund on an order from
an earlier month. `CLAUDE.md` rule (3) says a refund is returned to the order's
own period, never today's. The requester route's direct path already does this
(`budgetPeriodOf(order.createdAt)`). The admin route credited
`new Date().toISOString().slice(0, 7)` — today's month — which matched only
because the window forced the two to be the same. It now credits
`budgetPeriodOf(order.createdAt)`, and it joins `LEDGER_PERIOD_WRITERS` in
`lib/server/budget-consumption-contract.test.ts`. For a same-month refund
nothing changes. For an earlier month, the credit lands on that month's row,
where the money was spent; the branch does not get it back to spend this month.

K-Electric's ledger is keyed on the Karachi month. That gap predates this change
and is deliberately not repaired.

## Security

- No role gains reach: the role/tenant/branch/desk checks in
  `canAccessOrderForRefund` are unchanged.
- Head Office and Branch Admin lose the ability to request a refund before
  fulfilment.
- The window is rechecked under `FOR UPDATE` on both requester paths.

## Database

No schema change, no migration. `orders.fulfilled_at` already exists.

## Tests

- Unit: `lib/refund-window.test.ts` (boundaries: at fulfilment, at +7 d,
  +7 d + 1 ms, null/invalid, future clock skew, not delivered, role exemption);
  `lib/server/group-order-refunds.test.ts`; `lib/order-desk-access.test.ts`;
  `components/refund-management.test.tsx`.
- Contract: refund window contract replaces the month contract in
  `budget-consumption-contract.test.ts`; the admin route is a ledger period writer.
- Integration: `tests/integration/refund-window-api.test.ts` — each requester
  role inside / outside the window, Head Office before fulfilment, Super Admin
  approving and rejecting an old request, the admin credit landing on the
  order's own period, 401/403/cross-tenant. `group-refunds-api.test.ts` fixtures
  move from "last month" to "fulfilled 8 days ago".

## Rollback

Revert. No data is written differently except the admin route's budget row for a
cross-month approval, which was impossible before this change.
