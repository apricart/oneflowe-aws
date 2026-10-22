# OF-ORDER-DESK — the Order Desk enters a line's price

## Request

Apricart's Order Desk keys in orders customers send by email or WhatsApp. The
price the customer agreed in that conversation is not always the catalogue
price. The desk must be able to type a price per product on the order, and that
price must be what the order — and so the customer — is charged.

## Decision (2026-10-22)

This is an exception to "only a Super Admin writes a price", approved by the
product owner with these limits:

- **One order line, never the catalogue.** The entered price lives on
  `order_items.price_cents` of that order only. No global, organization or group
  price changes, and nothing cascades.
- **Order Desk only.** `ORDER_LINE_PRICE_ROLES = ["ORDER_DESK"]` in
  `lib/pricing-access.ts`, deliberately separate from `PRICE_MUTATION_ROLES`
  (still Super Admin alone). Any other role sending a line price is refused with
  403 — refused, not stripped, the same as `rejectPriceFieldsForRole`.
- **Any price above zero**, at most `MAX_PRICE_CENTS`. Tax-inclusive, exactly
  like a catalogue price, so the tax split is unchanged.
- **No reason required.** The line records the catalogue price beside the
  charged one and the audit row carries both; the intake screenshot already
  explains the agreement.
- **The executive sees it.** Every desk order already waits for an Apricart
  Executive. The approval list marks a hand-priced line and shows the catalogue
  price it replaced.

## Design

### Data

`order_items` gains two columns (migration `20261031120000`, additive):

| column | meaning |
|---|---|
| `price_entered_manually boolean NOT NULL DEFAULT false` | the desk typed this line's price |
| `catalogue_price_cents bigint NULL` | what the price ladder said at that moment; null on every other line, and when the ladder had no price |

`order_items_manual_price_ck`: `catalogue_price_cents` is set only on a manual
line and is never negative. A constant default is metadata-only in Postgres 11+,
so the table is not rewritten.

### Rules (pure, `lib/order-line-price.ts`)

`resolveOrderLinePrice({ cataloguePriceCents, enteredPriceCents })`:

- no entered price → the catalogue price, as today (null → "Pricing is unavailable");
- entered price equal to the catalogue price → treated as the catalogue price,
  not flagged (re-typing the same figure is not a price change);
- otherwise → the entered price, flagged, with the catalogue price recorded.

The catalogue price is still resolved through `resolveEffectivePriceCents`; no
hand-written fallback.

### Write paths

- `POST /api/v1/orders` — `items[].unitPriceCents` (optional integer). Refused
  (403) unless the caller is `ORDER_DESK`. Applied in the pre-flight estimate and
  again inside the creation transaction, so the budget hold, stock, tax, invoice
  receipt and total all follow the entered price. The request fingerprint
  includes a line's price only when one is sent, so every other order's
  idempotency hash is unchanged.
- `PUT /api/v1/order-desk/orders/[id]` (pending only) — the same field. A line
  sent without a price is re-priced at today's catalogue, as before; the edit
  form prefills a hand-priced line's price so it survives an edit.
- `PUT /api/v1/orders/[id]` (requester edit) does not accept the field
  (`orderUpdateSchema` is unchanged) and already refuses desk orders.

### Reads

The desk order list and the executive approval list return
`priceEnteredManually` and `cataloguePriceCents` per line. Nothing else changes:
invoices, credit notes, refunds and reports already read `price_cents`.

## Security

- Authority: `orderLinePriceFailure(role, items)` in `lib/pricing-access.ts`,
  called in `POST /api/v1/orders` before anything is read; the desk edit route
  is already `requireApiRole(["ORDER_DESK"])`.
- Mass assignment: the schema is `.strict()`; the price is the only new field
  and is bounded.
- Approval bypass: none — desk orders are always created `PENDING` for an
  executive, and an approval names the `updatedAt` it saw, so a re-priced edit
  in between is a 409.
- Audit: `ORDER_CREATE` (system log) and `ORDER_EDITED` carry the hand-priced
  lines with both figures.

## Tests

- `lib/order-line-price.test.ts`, `lib/pricing-access.test.ts` (new role list,
  separation from `PRICE_MUTATION_ROLES`, refusal for every other role).
- `lib/order-desk-draft.test.ts` — price parsing, estimate, request body.
- `lib/server/mass-assignment.test.ts` — the requester edit schema still refuses
  a line price.
- `tests/integration/order-desk-api.test.ts` — create and edit at an entered
  price (total, tax, budget hold, line flags), a portal user refused, zero refused.

## Rollout

Apply `20261031120000` before deploying: creation writes the columns.

Rollback: revert the code, then
`ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_manual_price_ck,
DROP COLUMN IF EXISTS catalogue_price_cents, DROP COLUMN IF EXISTS price_entered_manually;`
Orders already placed keep the price they were charged.
