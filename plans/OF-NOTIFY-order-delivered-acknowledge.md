# OF-NOTIFY — "Your order was delivered, please acknowledge"

## Requirement

When an order is delivered, the **order initiator** and the **order approver**
receive an in-app notification and an email saying the order was delivered and
asking them to acknowledge the delivery so the order is fulfilled.

Acknowledging a delivery means handing over the order's fulfilment token (any
of the five operational roles may, `lib/fulfillment-token-access.ts`), which
settles a delivered order to `FULFILLED`. The 48-hour auto-fulfil sweep is
unchanged.

## Where it fires

Delivery is recorded in exactly one place, `progressOrderFulfillment`
(`lib/server/order-fulfillment-progress.ts`), shared by Super Admin's
`POST /api/v1/orders/[id]/fulfillment-status` and the warehouse's
`POST /api/v1/warehouse/orders/[id]/progress`. On the step to `DELIVERED` it
calls `queueOrderDeliveredNotifications` (`lib/server/order-notifications.ts`)
**inside the same transaction**, so a rolled-back delivery announces nothing,
and drains the outbox for those events after commit
(`attemptImmediateOrderEmailDelivery`, which never throws). A notice never
holds a delivery back: an order that cannot be placed in its tenant is simply
not announced.

## Who is told

Template `ORDER_DELIVERED`, one event per recipient
(`ORDER_DELIVERED:<orderId>:<userId>`, deduplicated by the existing unique
indexes — `delivered_at` is written once, so there is one delivery per order).

| Recipient | Rule |
|---|---|
| Initiator | `orders.created_by_user_id`, role in `ORDER_CREATOR_ROLES` (Order Initiator, Group Order Initiator), active, in the tenant, still reaching the branch (`creatorReachesOrderBranch`) |
| Approver | `orders.approved_by_user_id`, role `BRANCH_ADMIN` (its own branch), `HEAD_OFFICE` (its tenant) or `GROUP_USER` (resolved assignments), active, in the tenant; skipped when it is the initiator |

Nobody is told when:

- the fulfilment token was already handed over (`token_handoff_at` set) — the
  delivery settles the order to `FULFILLED` straight away;
- the order was entered by the Order Desk — Apricart fulfils those itself;
- the order was approved at creation by policy — it has no approver, so only
  the initiator is told.

A Super Admin or Apricart Executive approver is never a recipient.

## Send-time checks

`deliverClaimedOrderEmail` re-checks every row as it does for the other
lifecycle mail (active, role, tenant/branch, group assignments), and for
`ORDER_DELIVERED` also requires the order to be still `APPROVED` +
`DELIVERED` (`isUnacknowledgedDelivery`) and an approver recipient to still be
`orders.approved_by_user_id`. Otherwise the row is skipped.

## Content

TID, organization and branch only — no amount, no person, no token (the
email footer already says it never carries one). The initiator's button opens
their portal (`/shop` or `/group-portal`); the approver's opens
`/orders/<id>`. In-app title "Order delivered — please acknowledge".

## Database impact

None. `notifications.type`, `notifications.target_role`,
`email_outbox.template` and `email_outbox.recipient_role` carry no check
constraint.

## Tests

- `lib/email/templates.test.ts` — wording and links per recipient role.
- `lib/server/order-notifications-security.test.ts` — queued inside the
  delivering transaction, recipient rules, send-time checks.
- `tests/integration/order-delivered-notifications.test.ts` — recipients,
  Head Office approver, auto-approved, moved approver, token already handed
  over, desk order, earlier stages, idempotency, rollback, send-time skips.
