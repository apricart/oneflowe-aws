# OF-TOKEN — Tell the sender when a token hand-off could not settle the order, and let them retry

## Problem

Sending a delivered order's fulfilment token to the admin does two things: the
email leaves and the hand-off is recorded (`sendTokenEmailOncePerOrder`), then
the order is settled to FULFILLED (`settleOrdersAfterTokenHandoff` →
`fulfillApprovedOrder`). The settlement runs after the email has gone, so a
failure there is swallowed by design — but nobody was told, and nothing could
retry it:

- the route answered 200 with `fulfilled: false, awaitingDelivery: false`, and
  every screen showed it as a success;
- the order now carries `token_handoff_at`, so every screen showed "Token sent"
  with the button disabled, and the route refused a second send as
  `TOKEN_ALREADY_SENT`;
- the 48-hour auto-fulfil sweep that would have caught it is not scheduled in
  production.

Production, 2026-10-26 04:40 UTC: orders 1871 (KE-LEGACY-1426) and 2058 at
K-Electric / Cluster defense were left APPROVED + DELIVERED with their tokens
sent. They were settled by hand on 2026-10-28 (report
`updatedReports/settle-handed-off-commit-777c8384e2be.json`).

## Rule

An order is **waiting on a failed settlement** when its token has been handed
over, it is DELIVERED, and it is still APPROVED — `tokenSettlementNeedsRetry`
in `lib/order-token-handoff.ts`. In normal running that state lasts only inside
the request that settles it.

## Change

- `settleOrdersAfterTokenHandoff` reports `failedOrderIds`: delivered orders it
  could not settle that the live row says are still waiting (a lost race is not
  a failure). If even that read fails, the order is reported as failed — the
  retry re-checks before it moves anything.
- `retryTokenHandoffSettlements` settles again only orders the live row says are
  waiting, through `settleDeliveredOrderAfterTokenHandoff`, crediting the
  original sender. No email is sent.
- **Both send routes** (`/api/v1/orders/[id]/send-token-email`,
  `/api/v1/group-portal/orders/[groupOrderId]/tokens`) answer:
  - a first send whose settlement failed: **200**, `settlementFailed: true`,
    `code: TOKEN_SETTLEMENT_FAILED` (the email did leave);
  - a send for an order whose token has gone and which is waiting: a **retry**
    instead of the 409 — 200 with `retried: true` when it settles, **503**
    `TOKEN_SETTLEMENT_FAILED` when it fails again; anything else is still the
    409 `TOKEN_ALREADY_SENT`.
  The retry sits after each route's existing authorization, tenant/branch fence,
  Order Portal visibility, token policy, APPROVED gate and email rate limit, so
  it grants no new reach. Each attempt writes `RETRY_ORDER_TOKEN_FULFILMENT`
  (`fulfilled: true|false`); a first send records `settlementFailed` on its
  `SEND_ORDER_TOKEN_EMAIL` row.
- Every send surface — shop detail and Unacknowledged tab, orders directory row
  and panel, group `TokenHandoff`, group "Email all" — shows a destructive
  message and turns the action into **Retry fulfilment** for such an order,
  derived from the order's own fields, so it also appears after a refresh or
  when the failure happened at delivery time. The group history read now
  carries `tokenHandoffAt` for that.

No migration. No change to who may send a token, to the fulfilment transition,
or to the ledger moves.

## Tests

- `lib/server/order-token-fulfillment.test.ts` — the rule, the wording, the
  response reader, and that both routes retry only on "already sent" and never
  email from the retry.
- `components/orders/unacknowledged-orders-table.test.tsx` — the retry button.
  The case that expected a disabled "Token sent" on a delivered order was the
  defect and was rewritten deliberately.
- `tests/integration/token-email-once-per-order.test.ts` — a real settlement
  fault inside the fulfilment transaction: 200 + `settlementFailed`, retry by
  another authorized actor settles crediting the sender with one email in all,
  a second failure is 503, an undelivered order is still 409, an outsider is
  403, and the group route retries only its failed orders.

## Rollback

Revert the commit. Orders a retry settled stay settled — exactly as a hand-off
would have left them.
