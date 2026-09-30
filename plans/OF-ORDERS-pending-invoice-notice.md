# OF-ORDERS — Pending invoice notice before placing an order

## Requirement

If a user has a pending invoice, show a notification when they attempt to
place another order, telling them an invoice is pending.

## Definition of "pending invoice"

An order the caller **created themselves** that:

- has an invoice snapshot (`receipt_data` is not null), and
- is in a post-approval status — `APPROVED`, `FULFILLED`, `PARTIAL`,
  `PARTIALLY_FULFILLED` (the same set `lib/invoice-availability.ts` treats as
  having an issuable invoice), and
- has `payment_status = 'UNPAID'`.

`PENDING` orders are excluded: `receipt_data` is written at creation, but no
invoice is issuable until approval. `REJECTED`, `CANCELLED` and `REFUNDED` are
excluded: nothing is owed on them.

The rule is pure in `lib/pending-invoice.ts` (`PENDING_INVOICE_ORDER_STATUSES`,
`isPendingInvoiceOrder`); the endpoint's SQL mirrors it.

## Behaviour

- **A notice, not a block.** The dialog names the invoice number and offers
  *Cancel* or *Continue with order*. Blocking on overdue payment is a separate,
  server-enforced feature (`lib/server/payment-control.ts`); this change does
  not touch it.
- Applies to new orders in the Order Portal (`app/shop/page.tsx`) and to Group
  Order Portal submissions (`components/group-portal/storefront/group-storefront.tsx`).
- Editing an existing pending order skips the check — it is not "another order".
- If the check itself fails (network, non-2xx, malformed body) the order is
  **not** submitted and a toast explains why; a failed check never silently
  bypasses the notice.

## Endpoint

`GET /api/v1/orders/pending-invoice`

- 401 without a session; 403 while a forced password change is pending.
- Scope is the session user id only (`orders.created_by_user_id`). The endpoint
  takes no parameters, so there is no user/branch/organization id to tamper
  with, and it cannot reveal another user's or tenant's invoice.
- Returns `{ hasPendingInvoice, pendingInvoice: { orderId, invoiceNumber,
  orderReference } | null }` — no amounts, no line items. The newest pending
  invoice is named; `invoiceNumber` falls back to the order TID for snapshots
  that predate invoice numbering.
- `Cache-Control: private, no-store`.
- Read-only, one bounded row (`LIMIT 1`), no audit row needed.

Not rate-limited: it is a cheap, parameterless read of the caller's own rows,
not auth-adjacent and not enumerable.

## Out of scope

- Invoices for group orders raised *for* the caller's branch by someone else.
  They are the branch's invoices, but the requirement is about the user's own
  pending invoice; widen later if the business asks.
- Any server-side enforcement. The notice is advisory by design.

## Database impact

None. No schema change, no migration, no backfill.

## Tests

- `lib/pending-invoice.test.ts` — the definition and response parser.
- `app/api/v1/orders/pending-invoice/route.test.ts` — 401/403/empty/summary.
- `lib/hooks/use-pending-invoice-guard.test.tsx` — continue, pause, fail-closed.
- `components/orders/pending-invoice-alert.test.tsx` — dialog content and choices.
- `lib/server/pending-invoice-notification-contract.test.ts` — both submission
  paths are wired; the query stays owner-scoped.
- `tests/integration/pending-invoice-api.test.ts` — the real SQL against
  Postgres: each status in and out, paid vs unpaid, other users and other
  tenants excluded, newest wins, TID fallback.

## Risk and rollback

Presentation only. Rolling back is reverting the files above; no data is
written. Imported K-Electric orders default to `UNPAID`, so K-Electric
requesters with any approved/fulfilled order will see the notice on every
order unless payment status is maintained for that tenant — confirm with the
business before release.
