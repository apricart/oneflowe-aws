# OF-ORDERING-BLOCK — configurable ordering-block thresholds

Builds on `plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md` and
`plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md`.

## Requirement

Both ordering blocks stop a branch at a fixed **2**: two unpaid invoices, or two
delivered-but-unacknowledged orders. Super Admin wants to choose the number per
organization when switching a block on.

## Decision

- Two new columns on `organizations`, one per block, each an integer
  `NOT NULL DEFAULT 2` with a `CHECK` of `1..100`:
  `unpaid_invoice_block_threshold`, `unacknowledged_delivery_block_threshold`.
  The default is today's fixed value, so the migration changes nothing for any
  tenant until a Super Admin edits it.
- Bounds and the default live once, in `lib/ordering-block-threshold.ts`
  (`ORDERING_BLOCK_THRESHOLD_MIN = 1`, `…_MAX = 100`,
  `DEFAULT_ORDERING_BLOCK_THRESHOLD = 2`). `PAYMENT_CONTROL_POLICY.overdueBlockThreshold`
  and `UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD` remain, as the default.
  - **0 is refused**: it would block every branch with nothing outstanding.
    Switching the block off is how a tenant stops blocking.
  - **100 is the ceiling**: a bound, not a business figure; it also bounds the
    invoice list the status route returns (below).
- The threshold is independent of the toggle. It may be set while the block is
  off and takes effect when it is switched on.
- Each gate reads its threshold from the same organization row it already reads
  the toggle from, inside the order-creation transaction. Nothing is taken from
  the request. A stored value outside the bounds (unreachable behind the CHECK)
  falls back to the default rather than to "never block".
- The unpaid-invoice seam lists `max(20, threshold)` invoices, so the date the
  limit was reached (`blockedSince` — the threshold-th oldest delivery) is
  still exact for a threshold above 20.
- Writes: Super Admin only, through the existing `POST /api/v1/organizations`
  and `PATCH /api/v1/organizations/[id]`, validated by Zod (integer, 1..100,
  no strings). Each change is audited in the PATCH transaction with what it
  replaced: `UPDATE_UNPAID_INVOICE_BLOCK_THRESHOLD`,
  `UPDATE_UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD`. Creation records both in
  the `CREATE_ORGANIZATION` audit.
- UI: under each switch in Create/Edit Company, while the switch is on, a
  number field. The hint prints the number being typed. An invalid number
  disables Save while the block is on; with the block off an invalid draft is
  simply not sent.

## Unchanged

The refusal shape and codes (`PAYMENT_CONTROL_BLOCKED`,
`UNACKNOWLEDGED_DELIVERIES_BLOCKED`), the order of the two gates, the Head
Office exception (payment control only), the pre-check routes (they already
return the threshold), the popup wording (it states the count, not the limit).

## Security

Authorization unchanged: only Super Admin may write either column (contract
tests extended to the new columns). No tenant data crosses: the threshold is
read by the organization id the gate was given. No price or amount involved.

## Database

Additive. `ADD COLUMN … NOT NULL DEFAULT 2` is metadata-only on Postgres 11+;
the CHECK scans `organizations` (a few rows). **Apply before deploying**: the
order gates select the new columns.

Rollback:

```sql
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_unpaid_invoice_block_threshold_ck;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_unacknowledged_delivery_block_threshold_ck;
ALTER TABLE organizations DROP COLUMN IF EXISTS unpaid_invoice_block_threshold;
ALTER TABLE organizations DROP COLUMN IF EXISTS unacknowledged_delivery_block_threshold;
```

(after deploying code that no longer selects them).

## Tests

- Unit: bounds, draft parsing, fallback; both pure resolvers at 1, at N−1/N/N+1
  for a custom N, at 100, with junk thresholds.
- Contract: the gates read the threshold from the organization row; only the
  two Super Admin routes write the columns; audits in the PATCH transaction;
  schema/migration bounds equal the constants.
- UI: the field appears with the switch, prefills, sends a number, disables
  Save on an invalid value, is hidden from Head Office.
- Integration (`tests/integration/ordering-block-thresholds.test.ts`): column
  defaults and CHECK; Super Admin create/patch with audit; 400 on 0, 101,
  1.5, "3", null; 403 for other roles; both gates at a custom threshold on the
  single-branch and group paths and the pre-check/status routes; threshold 1;
  raising/lowering the threshold lifts/imposes a block at once; one tenant's
  threshold never applies to another.
