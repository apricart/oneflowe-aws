# OF-INVOICE — Issue the tax invoice when processing starts

Status: **built 2026-10-13 (uncommitted).** Rename with the Jira ID when one is
assigned. Amends D2 and D6 of `plans/OF-INVOICE-invoice-ledger.md`.

## Why

The ledger issues, numbers and dates the tax invoice when delivery is recorded
(Phase 0, answer 1). The warehouse hands the customer the invoice **with the
goods**, so it has to be printed before the van leaves — and before delivery
there is no invoice to print. The warehouse order sheet shows **Download
invoice** only once the order carries an invoice number
(`components/warehouse/warehouse-order-sheet.tsx`), so in practice it could not
print one at all until after the delivery it was meant to accompany.

## Decision (requester, 2026-10-13)

The tax invoice is issued, numbered and dated **when the order is marked In
Process** — the first delivery stage, when the warehouse (or Super Admin)
starts work on it. This replaces Phase 0 answer 1 ("at delivery").

To confirm with the accountant: the invoice is now dated the day processing
starts, which is usually but not always the day of delivery.

## Design

### The rule, in one place

`lib/invoice-policy.ts`:

- `INVOICE_ISSUE_POINT` becomes `"processing"` (was `"delivery"`). Still a code
  constant, not an environment variable. `drawsInvoiceNumberAtCreation` is
  unchanged: numbering at creation stays off.
- `TAX_INVOICE_ISSUE_STAGE = "IN_PROCESS"`.
- `issuesTaxInvoiceOnStep(nextStatus)` — true for that stage **and every later
  one**.
- `isBeforeTaxInvoiceStage(fulfillmentStatus)` / `STAGES_BEFORE_TAX_INVOICE` —
  the stages at which no invoice exists yet.

### Issuing

`progressOrderFulfillment` (still the only place a delivery stage moves) calls
`issueTaxInvoice` (renamed from `issueTaxInvoiceAtDelivery`) inside the same
transaction on every step `issuesTaxInvoiceOnStep` admits. Issuing is
idempotent (`invoices_order_uq`; an existing invoice returns `exists`), so:

- a new order is issued its invoice on **In Process**, and the later steps find
  it and do nothing;
- an order already at In Process or Out for Delivery when this deploys, with
  no invoice yet, is issued one on its **next** step — never skipped.

If issuing fails (no company code), the step does not record, exactly as
delivery behaved: `invoice-code-missing`, 409 on both routes.

The issue date is the Karachi date of the step that issued it
(`issued_at = now`); the audit row (`ISSUE_TAX_INVOICE`) gains `stage`.
`origin` stays `ISSUED_AT_SUPPLY` — a database value pinned by the ledger's
triggers; renaming it would need a migration for no behavioural gain.

Everything else in the ledger is keyed on **the invoice row**, not on
delivery, and needs no change:

- credit notes (`issueCreditNoteForRefund`) — a refund approved after In
  Process is credited with a numbered credit note, before or after delivery;
- invoice status (`deriveInvoiceStatus` / `invoiceStatusSql`) — the ledger row
  wins;
- the admin delete refuses an order with an invoice row;
- frozen document printing (`invoiceDocumentForOrder`);
- the consolidated report — invoices by `issue_date`; an invoiced order drops
  out of proforma mode because its status is no longer `PROFORMA_AVAILABLE`.

### Things that assumed "issued ⇒ delivered"

| Reader | Before | After |
|---|---|---|
| Shop "pending invoice" notice (`lib/pending-invoice.ts`, `GET /api/v1/orders/pending-invoice`) | ISSUED / PARTIALLY_CREDITED, which implied delivered | additionally requires the goods **supplied** (`isOrderSupplied` / `orderSuppliedSql`), so an order still being picked does not interrupt the customer's next checkout. Behaviour unchanged for the customer. |
| Order Desk cancel (`deskOrderActions`, `cancelDeskOrder`) | until delivery | **until processing starts** (`isBeforeTaxInvoiceStage`). Cancelling an order whose tax invoice is issued would leave a numbered invoice on a cancelled order; after that point Super Admin refunds it, which issues a credit note. The claim re-asserts the stage under the order lock, and the stage step's compare-and-set requires `APPROVED`, so a cancel and an In Process step have one winner. Refusal: 409 `invoiced`. |
| Unpaid-invoice ordering block | FULFILLED + DELIVERED + invoiced + UNPAID | unchanged — it already requires delivery. |
| Proforma wording | "the tax invoice is issued on delivery", "(on delivery)" | "when the order is processed", "(when processed)" |
| Consolidated report footnote | "later invoices carry their delivery date" | "later invoices carry the date they were issued" |

### Not changed

- No schema change, no migration, no backfill.
- Who may move a stage (Super Admin, the warehouse in its reach) — unchanged.
- The unacknowledged-delivery block, the delivery dashboard, the challan rules.

## Tests

- `lib/invoice-policy.test.ts` — the stage rule.
- `lib/order-desk-access.test.ts` — cancel offered only before In Process.
- `lib/pending-invoice.test.ts` — an issued, undelivered invoice is not pending.
- `lib/server/invoice-ledger-contract.test.ts` / `lib/server/order-desk-contract.test.ts` — the hook and the claim.
- `tests/integration/invoice-ledger.test.ts` — issued on In Process, dated
  then, unchanged by the later steps; an order already Out for Delivery with
  no invoice is issued one on delivery.
- `tests/integration/invoice-ledger-edge-cases.test.ts` — the no-code refusal
  and the refund race move from delivery to In Process.
- `tests/integration/order-desk-api.test.ts` — cancel refused once processing
  has started.
- `tests/integration/pending-invoice-api.test.ts` — no notice for an invoiced,
  undelivered order.

## Risk and rollback

- If wrong: invoices are dated a day or two earlier than delivery for orders
  that sit in process. Nothing is lost; every invoice still has one number.
- Rollback: set `TAX_INVOICE_ISSUE_STAGE` to `"DELIVERED"` and
  `INVOICE_ISSUE_POINT` back to `"delivery"`. Invoices already issued stay
  issued (they are immutable), with their own dates.
