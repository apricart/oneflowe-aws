# OF-ORDERS — Block ordering on unacknowledged deliveries (per-organization toggle)

Sits beside `plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md` and
reuses its shape (toggle on the organization, gate inside the order
transaction, pre-check that fails open, popup), but it is a **separate rule
with a separate gate**: a different condition, a different remedy, and no
Head Office exception.

## Requirement

A Super Admin, while creating or editing an organization, has a toggle. When
it is on, a branch of that organization with **two or more orders that are
delivered but not yet acknowledged** cannot place a new order, and the person
ordering is shown a popup telling them to acknowledge (fulfil) their
delivered orders first.

## Definitions and decisions

1. **An unacknowledged delivery is an order with `status = 'APPROVED'` and
   `fulfillment_status = 'DELIVERED'`**, both compared case-insensitively,
   with a null `fulfillment_status` read as `NOT_STARTED`. This is exactly the
   dashboard's **Delivered/Unacknowledged** figure (the `DELIVERED_UNACKNOWLEDGED`
   bucket, `lib/order-delivery-status.ts`), and the SQL reuses that bucket's
   predicate (`viewerStatusBucketCondition`), so the popup's count and the
   dashboard's count cannot disagree.
2. **Per branch.** The toggle is on the organization; the count and the block
   are per branch. Every order at the branch counts, whoever raised it — group
   orders included (CLAUDE.md: the branch owns its orders; never filter on
   `groupOrderId`).
3. **Threshold 2** (`count >= 2` blocks; 0 and 1 are allowed), one exported
   constant that the gate, the payload and the hint all print.
4. **Default off**, so nothing is blocked on deploy.
5. **Every role ordering for the branch is blocked**, on both creation paths
   (`POST /api/v1/orders`, group submission), Super Admin and Head Office
   included — the same reach as the payment-control gate.
6. **Only new orders.** Editing a pending order is not gated: it creates no
   order, and a pending order is not a delivery.
7. **No Head Office exception.** The branch can always clear the block itself:
   handing the fulfilment token over (the existing "send token" action) settles
   a delivered order to `FULFILLED` at once (`settleOrdersAfterTokenHandoff`),
   Super Admin can fulfil with the token, and the 48-hour auto-fulfil sweep
   settles delivered orders with no refund activity.
8. **Order of gates.** Payment control runs first, then this gate. With both
   toggles on and both conditions true, the user sees the unpaid-invoice popup
   first and this one after paying.
9. **No order references leave the gate.** An Order Portal user may see only
   their own orders and their branch's group orders
   (`lib/group-order-visibility.ts`), so listing the branch's delivered TIDs
   would widen that. The refusal and the pre-check carry the count and the
   threshold only.

## Architecture

| Piece | Layer | File |
|---|---|---|
| Toggle column | persistence | `db/schema.ts` (`organizations.blockOrderingOnUnacknowledgedDeliveries`), `drizzle/20260930170000_add_block_ordering_on_unacknowledged_deliveries.sql` |
| Definition, decision, message, error, response parsers (pure) | domain | `lib/unacknowledged-delivery-block.ts` + `.test.ts` |
| Toggle read + count + gate | server domain | `lib/server/unacknowledged-delivery-block.ts` |
| Gate call sites | route / server domain | `app/api/v1/orders/route.ts`, `lib/server/group-order-creation.ts` |
| Pre-check read | route | `GET /api/v1/orders/delivery-acknowledgement` |
| Pre-check client (fails open) | client | `lib/delivery-acknowledgement-check.ts` |
| Popup | UI | `components/orders/unacknowledged-deliveries-dialog.tsx` |
| Toggle in Create / Edit Company | UI | `app/(portal)/organizations/page.tsx` |
| Popup call sites | UI | `app/shop/page.tsx`, `components/group-portal/storefront/group-storefront.tsx` |

## API

- `POST /api/v1/orders` — a blocked branch gets **409**
  `{ error, code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", deliveryAcknowledgement: { code, unacknowledgedCount, threshold } }`; nothing is written.
- `POST /api/v1/group-portal/orders` — the blocked branch's result is
  `{ status: "failed", reason, code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedDeliveryCount }`; the other branches still commit.
- `GET /api/v1/orders/delivery-acknowledgement?branchId=` (new, read-only) →
  `{ enabled, orderingAllowed, unacknowledgedCount, threshold }`,
  `Cache-Control: private, no-store`. Fenced exactly like
  `GET /api/v1/payment-control` (`resolveViewableBranch`, then the branch row's
  tenant): single-branch roles read their own branch only, group roles their
  resolved assignment set only (empty set → 403), Head Office its tenant
  (another tenant's branch → 404), Super Admin any. 401 without a session;
  403 for a password-change-pending session (global guard).
- `POST /api/v1/organizations`, `PATCH /api/v1/organizations/:id` — accept
  `blockOrderingOnUnacknowledgedDeliveries: boolean`, Super Admin only (both
  routes are already `requireApiRole(["SUPER_ADMIN"])`, schemas are strict).

## Data

```sql
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS block_ordering_on_unacknowledged_deliveries boolean NOT NULL DEFAULT false;
```

Additive, defaulted, metadata-only on Postgres 11+. No backfill. The count is
served by `orders_org_branch_status_idx (organization_id, branch_id, status)`.
Rollback: deploy the previous build; the column is then unused.

## Security

- **Toggle:** Super Admin only, strict Zod, audited in the same transaction
  (`UPDATE_UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK`, before/after); the creation
  audit records the initial value.
- **Gate:** server-side inside the order transaction, before any lock or
  write; scope from the authoritative branch, never the request. The UI
  pre-check is presentation only and fails open.
- **Tenant isolation:** the count carries `organization_id` **and**
  `branch_id`; the toggle is read from the gate's organization.
- **Exposure:** count and threshold only; no amounts, no order references.

## Tests

- `lib/unacknowledged-delivery-block.test.ts` — definition (every status ×
  fulfilment status, case, null), decision at 0/1/2/3 and toggle off, message
  singular/plural, error shape, all three parsers incl. malformed input.
- `lib/delivery-acknowledgement-check.test.ts` — blocked, allowed, non-OK,
  malformed, network failure (fails open), URL with and without a branch.
- `components/orders/unacknowledged-deliveries-dialog.test.tsx` — copy,
  branch list, only an OK button, close.
- `app/(portal)/organizations/page.test.tsx` — toggle defaults off, sent on
  create and edit, prefilled, not shown to / sent by Head Office.
- `app/shop/page.test.tsx` — pre-check blocked → popup, nothing submitted;
  server 409 → popup, not a toast.
- Contract (`lib/server/unacknowledged-delivery-block.test.ts`) — both
  creation paths call the gate inside the transaction after payment control
  and before the first lock and the write; the 409 mapping; the group tag;
  both pages wire the popup; the toggle is written only behind the Super
  Admin gate and audited; the SQL reuses the dashboard's bucket predicate and
  both tenant predicates.
- `tests/integration/unacknowledged-delivery-ordering-block.test.ts` — the
  real gate against Postgres: off → nothing blocked; on → 0 and 1 allowed, 2
  refused with 409 and no row, 3 carries the real count; only
  APPROVED+DELIVERED counts (fulfilled, partial, pending, rejected,
  not-started, out-for-delivery, null, lowercase all checked); group orders
  and other users' orders count; another branch and another tenant do not;
  every role blocked; a token hand-off on one order unblocks through the real
  route; the group submission fails only the blocked branch; the pre-check
  route's 401/403/404/400 fence and payload; toggle Super Admin only (403 for
  every other role, 401, 400 non-boolean), audited once per change, create
  with and without; both toggles on → payment control answers first.

## Risks

- **K-Electric:** the dashboard shows 112 delivered-unacknowledged orders.
  Switching this on for K-Electric blocks every branch with two of them at
  once. Default off; clear the backlog (or confirm the auto-fulfil cron runs)
  before enabling.
- An Order Portal user can be blocked by a colleague's unacknowledged orders
  that they cannot see. The popup says the branch's delivered orders must be
  acknowledged; a Branch Admin (or the raiser) clears them.

## As built — notes

- The shop runs the two pre-checks **in sequence**, unpaid invoices first,
  matching the order of the gates on the server; the delivery check is not
  fetched at all when the branch is already blocked for unpaid invoices. The
  group storefront shows the two popups one after the other, never stacked.
- The two ordering-block audits on `PATCH /api/v1/organizations/:id` moved
  into `auditOrderingBlockToggles(tx, …)`, called inside the transaction with
  its `tx` (the handler had crossed the lint complexity limit). Behaviour and
  audit payloads are unchanged for the unpaid-invoice toggle.
- `fulfillment_status` is `NOT NULL` in the schema, so the null case is covered
  by the pure rule's test only; the SQL still coalesces, as the dashboard does.
- A replayed group submission rebuilds its results from stored failures, which
  keep no `code`, so a replay shows the reason text without the popup — the
  same as the unpaid-invoice block.
- The count is read, not locked: a delivery recorded concurrently with an order
  may let that one order through. The same holds for payment control, and the
  next order is refused.

## Follow-up — "Unacknowledged Orders" tab on /shop

The branch clears the block itself, so the Order Portal now lists what it has
to clear. A fourth tab beside Shop / Active Orders / Refunded shows every
delivered-but-unacknowledged order in a table — order, items, delivered date,
the **full** fulfilment token (with copy), and an action that emails the token
to admin operations through the existing `POST /api/v1/orders/[id]/send-token-email`.
That hand-off settles a delivered order to FULFILLED, the tab and count
refresh, and the next order attempt is judged against the lower count.

- Rows are selected by `selectUnacknowledgedOrders` (`lib/unacknowledged-orders.ts`),
  which filters on `isUnacknowledgedDelivery` — the block's own rule.
- The source is `GET /api/v1/orders?status=approved&limit=500`, so fulfilled
  history cannot push an old delivery off the page.
- No new endpoint and no change to token visibility. The list already nulls the
  token wherever `canViewFulfillmentToken` refuses it, so a group order raised
  by someone else is listed without a token or a send action. That order still
  counts toward the block; only its raiser (or an approver) can clear it.
- The block popup gained a "View unacknowledged orders" action on /shop
  (optional `onReview` prop; the group storefront is unchanged). Active Orders
  cards show a "Delivered · Awaiting acknowledgement" badge.

## Follow-up — fulfilment columns and a "Delivered · Unfulfilled" tab on /orders

- `OrdersDirectory` table gains **Fulfillment Token** (full token + copy) and
  **Action**, pinned to the right edge (sticky) and kept out of the column
  picker, so both stay on screen at any width. Only an APPROVED order with a
  token the list returned gets either. `orderRowFulfilmentAction` picks the
  action: Super Admin → "Fulfil" (the existing token dialog, pre-filled, still
  verified by `POST /fulfill`); an approver holding the token → "Send token"
  (`POST /send-token-email`, which does not admit Super Admin). Token
  visibility is unchanged — still `canViewFulfillmentToken` on the server.
- Delivered-but-unfulfilled orders are identifiable separately: a
  "Delivered · Unfulfilled" badge on the row/card, and a tab of that name with
  its count. `GET /api/v1/orders` accepts `delivery=unacknowledged`
  (allowlisted; anything else is 400), narrows with
  `viewerStatusBucketCondition("DELIVERED_UNACKNOWLEDGED")` after the summary
  snapshot, and returns `summary.deliveredUnacknowledged` (additive field).
  `/orders?delivery=unacknowledged` opens the tab. Covered in
  `tests/integration/unacknowledged-delivery-ordering-block.test.ts`.

## Not built

- An exception mechanism, an organization-wide count, a per-organization
  threshold, listing the orders in the popup (see decision 9).
