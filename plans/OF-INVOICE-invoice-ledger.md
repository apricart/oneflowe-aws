# OF-INVOICE — Invoice ledger: tax invoices and credit notes as real records

Status: **Phases 1–4 built 2026-10-11 (uncommitted); Phase 5 partly (see *As
built*).** Phase 0 answered 2026-10-11, except Q6. Rename with the Jira ID when
one is assigned.

## Phase 0 answers (requester, 2026-10-11)

| # | Question | Answer | Effect on the plan |
|---|---|---|---|
| 1 | When is the invoice numbered and dated? | **At delivery** | D2 as written |
| 2 | Which number series? | **Keep the existing series** (`<ORGCODE>-APR-NNNNNN`, one per customer, continuous, no yearly reset) | D1: `invoice_sequences` stays the tax-invoice counter. No new counter and no seeding for invoices. |
| 3a | Title "Sales Tax Invoice"? | **No.** Keep "INVOICE". | D4 |
| 3b | Customer STRN? | **Yes**, entered on the Create / Edit Organization form | D9 (new) |
| 4 | Credit notes: format, limits, refunds before cutover | Our recommendation: a numbered credit note per refund approved after cutover, referencing the invoice; **no retrospective credit notes**; **no time limit enforced in software** (Super Admin's existing unlimited refund window stands) | D3, D6 |
| 5 | FBR electronic reporting? | **Not required now** | None. Issuing lives in one function (D2), the single place a future integration would attach. |
| 6 | Is the number register enough for past gaps? | Open: explained to the requester; for the accountant to confirm | D6, D5 (invoice number on the delete audit) |

Related: `plans/OF-INVOICE-consolidated-invoices.md` (the consolidated
report). That report is built **on top of** this ledger (see *Consequences
for the consolidated report*).

## Why

The application treats an invoice as a JSON field on the order
(`orders.receipt_data`). Accounting systems treat it as a document in its own
right, in a fixed chain:

**Sales order → proforma → delivery → tax invoice → credit note → payment**

In that chain:

- the tax invoice is numbered and dated **at the time of supply**;
- once issued it **never changes**;
- a reduction after issue is a **separately numbered credit note** that
  references it.

This plan moves OneFlowe to that model without renumbering, redating or
altering a single invoice already given to a customer.

## Investigation — what the system does today

### Where an invoice is written

| Writer | What it does | File |
|---|---|---|
| Order creation | builds the snapshot **and draws the invoice number** | `saveOrderReceipt`, `app/api/v1/orders/route.ts:605` |
| Group order creation | same, per branch order | `lib/server/group-order-creation.ts:579` |
| Requester edit (pending) | regenerates the snapshot, keeps number and date | `app/api/v1/orders/[id]/route.ts:416` |
| Order Desk edit (pending) | same | `lib/server/order-desk-edit.ts:424` |
| **Refund approval (admin route)** | **rewrites the issued snapshot**: adds `refund`, `refundedItems`, lowers `totalAmount` | `app/api/v1/admin/refunds/route.ts:559`, `updateReceiptWithRefund` |
| KE importers | write `KE-LEGACY-<id>` snapshots | `scripts/import-ke-*.ts` |
| **KE repair scripts** | **rewrite issued snapshots in place** (tax split, categories, branch) | `apply-ke-legacy-order-tax.ts`, `categorize-ke-legacy-products.ts`, `repair-ke-order-branches.ts`, `repair-ke-case-sensitive-branches.ts` |

### Where an invoice is read

- **Preview and download:** `GET /api/v1/receipts/[orderId]`, `.../download`.
- **Shared builder:** `lib/server/invoice-document.ts`, used by the
  download and by `GET /api/v1/warehouse/orders/[id]/invoice`.
- **Invoice number:** `pending-invoice` route, `overdue-payment-source.ts`,
  `analytics/summary`, `analytics/drill-down`, `branches/[id]/export`,
  `warehouse-orders.ts`, `order-detail-panel.tsx`.
- **Other rules:**
  - "has this tenant invoiced?", which locks the organization code
    (`organizations/[id]/route.ts:192`);
  - two different "unpaid invoice" definitions (`lib/pending-invoice.ts`
    counts APPROVED; `lib/unpaid-invoice-block.ts` counts only
    FULFILLED + DELIVERED).

### Numbering

- `invoice_sequences`: one counter per organization; format
  `<ORGCODE>-APR-000001`; drawn under a `FOR SHARE` lock on the organization.
- Uniqueness: `orders_org_invoice_number_unique_idx (organization_id, number)`
  and `orders_tenant_prefixed_invoice_number_unique_idx` (global, new format).
- Refund numbers: `Refund-<refunds.id padded>`, written **after** the insert
  from the serial id. One series for every tenant, with gaps wherever a
  transaction rolled back.

### Defects measured against accounting practice

| # | Defect | Evidence | Why it matters |
|---|---|---|---|
| 1 | **Number drawn at order creation** | `saveOrderReceipt` | Every rejected, cancelled or deleted order burns a number. The series has gaps (the UBL sample skips 000036 and 000040). Tax invoices are expected to be serially numbered. |
| 2 | **Invoice date = creation date**, in the creating process's time zone | `receipt-generator.ts:172` (`toLocaleDateString`) | The tax invoice should be dated at supply (delivery). The date can precede delivery by days, and is off by one for orders placed 00:00–05:00 Karachi time. |
| 3 | **Issued invoice mutated by refunds** | `updateReceiptWithRefund` in the admin refund route | An issued tax invoice must not change. A reduction is a credit note. |
| 4 | **Refunds handled two ways** | The direct refund route does **not** touch the snapshot; the admin route does | The same refund prints differently depending on which button approved it. |
| 5 | **No credit note document** | Refunds are `Refund-000123` records with no tax breakdown | The customer gets no document to adjust its input tax, and Apricart has no record to adjust its output tax. |
| 6 | **App refunds never record their tax part** | `tax_refund_cents` written only by KE imports; both app routes insert gross only | Output-tax reduction from refunds cannot be reported; the consolidated report would understate the tax deducted. |
| 7 | **Reprint pulls live data** | The receipts route overrides `buyerAddress` with the branch's **current** address and `organizationNtn` with the **current** NTN, and computes status, refund and the "Fulfiller" name at read time | A reprinted invoice is not the invoice that was issued. It also contradicts the snapshot's own design, which stores the delivery address so a reissued invoice prints where the goods went. |
| 8 | **Issued invoices can be deleted** | `DELETE /api/v1/admin/delete-order` (Super Admin **and Head Office**) hard-deletes an `APPROVED` order, including one already **delivered**. Its `DELETE_ORDER` audit row (since 2026-09-26) omits the invoice number. | A delivered order has a tax invoice. Deleting it destroys a numbered financial document, and the trail cannot say which number went with it. |
| 9 | **History rewritten by scripts** | Four KE scripts `UPDATE orders SET receipt_data = …` | They are well intentioned, but an issued document is being edited. |
| 10 | **No structure** | Number and date are text inside jsonb; uniqueness via JSON expression indexes; dates parsed with `to_date()` | Cannot be a foreign-key target; cannot be indexed or reported on cleanly. |
| 11 | **"Unpaid invoice" defined twice** | `pending-invoice.ts` vs `unpaid-invoice-block.ts` | The two screens can disagree about what is owed. |

Facts the design relies on:

- **Pricing is tax-inclusive per line.**
  `splitInclusiveCents(grossCents, taxRateBp)` (`lib/tax.ts`) gives
  net + tax = gross exactly, and the order totals are sums of lines. Credit
  notes split the same way.
- **Delivery is recorded in one place:** `progressOrderFulfillment`
  (`lib/server/order-fulfillment-progress.ts`), shared by Super Admin and the
  warehouse. It writes `delivered_at` once. Fulfilment requires delivery.
- **Approval** happens in `order-decision-service.ts`, or at creation when a
  tenant does not require approval.
- **No email carries an invoice**, so no outbound copy has to be matched.

## Target model

| Document | Created when | Number | Changes after creation? |
|---|---|---|---|
| **Order** | placed | `orders.id` / `tid` | yes, while pending |
| **Proforma invoice** | order approved | **none.** Titled "PROFORMA INVOICE", references the order | not a record; rendered from the order |
| **Tax invoice** | **delivery recorded** | from the tax-invoice series, **gap-free** | **never.** Only its credited totals and status move |
| **Credit note** | a refund approved on an **issued** invoice | from the credit-note series, gap-free | **never** |
| Refund (existing) | requested / approved | `Refund-…` (internal workflow reference) | workflow states only |

**Invoice status** (the requester's table):

- **No invoice row:** status comes from the order:
  - Pending or Rejected → *Not issued*;
  - Approved → *Proforma available*;
  - Cancelled, or refunded in full before delivery → *Cancelled*.
- **Invoice row:** its own stored status, *Issued → Partially credited →
  Credited*, moved only by credit notes.

## Decisions

### D1 — New tables (additive)

**Number series** (Phase 0, answer 2):

- **Tax invoices keep the existing series and counter.** `invoice_sequences`
  and `generateNextInvoiceNumber` (`lib/invoice-number.ts`) stay exactly as
  they are: `<ORGCODE>-APR-000001`, per customer, continuous, ≤ 999 999.
  Only *when* the number is drawn moves, from creation to delivery. The
  series continues from today's last value: no jump, no repeat, no
  migration of the counter.
- **Credit notes get their own counter**, `credit_note_sequences`, the same
  shape as `invoice_sequences` (`organization_id` PK, `last_value` 0..999 999,
  timestamps). Format `<ORGCODE>-CN-000001`, drawn by
  `generateNextCreditNoteNumber`, beside the invoice formatter in
  `lib/invoice-number.ts`. A separate series means a credit note can never
  take a number the invoice series needs.

**`invoices`** — one row per tax invoice:

| Column | Type / rule |
|---|---|
| `id` | serial PK; `UNIQUE (id, organization_id)` |
| `organization_id`, `branch_id` | not null; composite FK → `branches (id, organization_id)` |
| `order_id` | not null; composite FK → `orders (id, organization_id)` (needs `orders_id_organization_uq`, below); **`UNIQUE (order_id)`** — one invoice per order. Partial deliveries would relax this later. |
| `number` | varchar(40) not null; `UNIQUE (organization_id, number)`, plus a global partial unique for the prefixed format, mirroring today |
| `issue_date` | date not null — the Karachi date of supply |
| `issued_at` | timestamptz not null |
| `origin` | `ISSUED_AT_SUPPLY` \| `LEGACY_SNAPSHOT` \| `LEGACY_IMPORT` |
| `status` | `ISSUED` \| `PARTIALLY_CREDITED` \| `CREDITED` |
| `seller` | jsonb snapshot: name, address, NTN, STRN |
| `buyer` | jsonb snapshot: organization name, NTN, **STRN** (D9), branch name, delivery address and label, cost center, PO number |
| `participants` | jsonb snapshot: placed by, approved by (names as at issue) |
| `net_cents`, `tax_cents`, `total_cents` | bigint ≥ 0; check `net + tax − discount + delivery = total` |
| `discount_cents`, `delivery_charges_cents` | bigint ≥ 0 |
| `credited_net_cents`, `credited_tax_cents`, `credited_total_cents` | bigint ≥ 0; check `credited_total ≤ total` |
| `legacy_snapshot` | jsonb null — the untouched `receipt_data` for legacy rows only |
| `issued_by_user_id` | uuid null (null for legacy) |
| `created_at` | timestamptz |

**`invoice_lines`**:

| Column | Type / rule |
|---|---|
| `invoice_id` + `organization_id` | composite FK |
| `line_no` | int > 0 |
| `order_item_id` | FK |
| `product_name`, `product_code`, `unit`, `category` | snapshots |
| `quantity` | numeric(12,3) > 0 |
| `unit_net_cents` | bigint |
| `tax_rate_bp` | int null |
| `net_cents`, `tax_cents`, `gross_cents` | bigint ≥ 0; check `net + tax = gross` |

`UNIQUE (invoice_id, line_no)`.

**`credit_notes`**:

| Column | Type / rule |
|---|---|
| `id` | serial PK |
| `organization_id` | not null |
| `invoice_id` | composite FK → `invoices (id, organization_id)` |
| `refund_id` | FK `refunds`; **`UNIQUE`** — one credit note per approved refund, so a retried approval cannot issue two |
| `number` | unique (as invoices) |
| `issue_date`, `issued_at` | not null |
| `reason` | text |
| `net_cents`, `tax_cents`, `total_cents` | bigint > 0; check `net + tax = total` |
| `issued_by_user_id` | not null |

**`credit_note_lines`**: as `invoice_lines`, plus `invoice_line_id`; figures
positive (the document is a credit).

**On existing tables:**

- `orders_id_organization_uq UNIQUE (id, organization_id)`, the composite
  target, as `branches` and `groups` already have.
- Every new table carrying `organization_id` + `branch_id` goes on
  `tests/integration/tenant-composite-foreign-keys.test.ts`.

**Immutability is enforced by the database, not only by the code.** A
`BEFORE UPDATE` trigger on `invoices` refuses any change to `number`,
`issue_date`, `issued_at`, `seller`, `buyer`, `participants`, the amounts,
`legacy_snapshot` and `order_id`; only `status` and the `credited_*` columns
may move. `invoice_lines`, `credit_notes` and `credit_note_lines` refuse
`UPDATE` and `DELETE` outright. An integration test proves each refusal. A
future script cannot "repair" an issued document by accident.

### D2 — Issuing the tax invoice at delivery

Inside `progressOrderFulfillment`, **in the same transaction** that sets
`fulfillment_status = 'DELIVERED'` and `delivered_at`:

1. Lock the organization row `FOR SHARE` (as `lockInvoiceTenantForIssuance`).
2. **Number:** if the order already carries a number drawn before cutover,
   `receipt_data->>'invoiceNumber'` (the *transition reservation*, D6), that
   number is used. Otherwise the next value of the tax-invoice series.
3. **Lines:** from `order_items`, net of refunds approved **before**
   delivery:
   - gross = original line gross − Σ refunded gross of that line, so the
     money matches the refund records to the paisa;
   - net and tax via `splitInclusiveCents` at the line's `tax_rate_bp`;
   - a line refunded to zero is omitted;
   - an un-itemised pre-delivery refund becomes `discount_cents`.
4. **Header:** seller from `INVOICE_ISSUER`; buyer from the order's own
   snapshot (delivery address as ordered), the organization's NTN and STRN,
   and the branch cost center, all **as at issue**; participants as at
   issue.
5. Insert `invoices` + `invoice_lines`, and write `ISSUE_TAX_INVOICE` to
   `audit_logs`.
6. If any step fails, **the delivery does not record**. A delivered order
   without its invoice is impossible.

**Idempotency:** `UNIQUE (order_id)`. The progress route already claims the
stage transition once, so a retry finds the invoice and does nothing.

**Gap-free:** the number is drawn in the same transaction as the insert. A
rollback rolls the counter back.

### D3 — Credit notes at refund approval

Both approval paths — the direct Super Admin refund
(`orders/[id]/refunds`, `createApprovedRefund`) and approval of a request
(`admin/refunds`) — call one new function,
`issueCreditNoteForRefund(tx, refund, order)`
(`lib/server/credit-notes.ts`), inside their existing transaction, **after**
the order row is locked:

- **The order has an invoice** (delivered):
  1. Lock the invoice `FOR UPDATE`.
  2. Build credit lines from `refund_items`: gross = refunded amount, split by
     `splitInclusiveCents` at the invoice line's rate. An un-itemised refund
     becomes one line split pro rata at the invoice's own tax/total ratio,
     with the rounding residue on that line, and is always reconciled.
  3. Draw the credit-note number, insert the credit note and its lines.
  4. Add to the invoice's `credited_*` and set its status to
     `PARTIALLY_CREDITED`, or `CREDITED` when `credited_total = total`. The
     `credited_total ≤ total` check makes over-crediting impossible.
  5. Write `ISSUE_CREDIT_NOTE`.
- **No invoice yet** (refund before delivery): no credit note. The refund
  reduces what the invoice will be issued for (D2 step 3).
- **Both cases:** write `refunds.tax_refund_cents` with the same split,
  closing defect 6 for every new refund.
- **Removed:** `updateReceiptWithRefund` is no longer called. Defects 3 and 4
  close together, because both paths now behave identically.

### D4 — Documents

**Tax invoice PDF / preview** for `origin = ISSUED_AT_SUPPLY`:

- **Title stays "INVOICE"** (Phase 0, answer 3a); not "Sales Tax Invoice".
- Rendered **only from `invoices` + `invoice_lines`**. No live branch
  address, NTN, status or refund (closes defect 7).
- Bill To prints the customer's **NTN and STRN** from the issue-time
  snapshot, each only when present.
- **"Fulfiller" is removed from the tax invoice.** Fulfilment happens after
  issue, so it cannot be part of a document frozen at issue. It remains on
  the order and the delivery challan.
- **Overlays outside the document body, clearly marked:** the existing PAID
  stamp, and a band "Credit notes issued against this invoice: UBL-CN-000004
  (PKR 2,000.00)". The content itself is identical on every reprint.

**Legacy invoices** (`LEGACY_SNAPSHOT`, `LEGACY_IMPORT`):

- Printed by today's renderer from `legacy_snapshot`, **exactly as today**,
  including their refund lines and the live-address behaviour. Changing what
  a historical document prints would itself be a restatement, so the
  boundary is clean: old documents print as they always have, and new ones
  print frozen.

**Credit note PDF / preview:**

- Same masthead; title "CREDIT NOTE".
- Credit note number and date, the referenced invoice number and date,
  buyer, lines, net / tax / total, reason.

**Proforma:**

- Rendered from the order, titled **"PROFORMA INVOICE"**, with **no invoice
  number**: "Proforma for Order 1778".
- States "Not a tax invoice. The tax invoice is issued on delivery."
- For a pre-cutover order holding a reservation, it shows that reserved
  number labelled "Invoice No. (on delivery)", so a customer who already saw
  it is not confused.

**Access:**

- Unchanged. Credit notes follow the order's invoice access
  (`resolveInvoiceAccess`) and price visibility.
- New routes:
  - `GET /api/v1/receipts/[orderId]/credit-notes`;
  - `GET /api/v1/receipts/[orderId]/credit-notes/[creditNoteId]/download`.
- The warehouse reads credit notes for orders in its reach, on its own
  route, as it does invoices.

### D5 — Guards on deleting and editing

- `DELETE /api/v1/admin/delete-order` **refuses any order that has an
  invoice row**, or whose `fulfillment_status = 'DELIVERED'` (409 "An order
  with a tax invoice cannot be deleted; refund it instead"). Closes defect 8.
  - Undelivered approved orders remain deletable. After cutover they hold no
    number, so deleting them burns nothing.
  - **Its audit row now carries the invoice number** the order held. Since
    2026-09-26 the route has written a `DELETE_ORDER` row (via
    `recordAuditEvent`) with the order id, tid, status, money and lines, but
    not the invoice number or fulfilment status; Phase 1 adds both. Orders
    deleted **before 2026-09-26** left no audit row at all.
  - *Correction (2026-10-11): an earlier draft of this plan said the route
    wrote no audit row. It has since 2026-09-26; the search had missed the
    `recordAuditEvent` helper.*
- Edits stay pending-only, as today. A pending order has no invoice.
- Scripts:
  - `lib/server/security-boundaries.test.ts` gains a contract test: no file
    under `scripts/` or `app/` writes `invoices`, `invoice_lines`,
    `credit_notes` or `credit_note_lines` except the issuing modules and the
    KE importer's insert;
  - the four KE repair scripts are left as they are for pre-cutover history;
  - after cutover, their writes to `receipt_data` no longer reach any
    issued document (the trigger also refuses).

### D6 — Cutover (prospective only, nothing renumbered)

A code constant `INVOICE_ISSUE_POINT` in `lib/invoice-policy.ts`
(`"creation"` → `"delivery"`), deliberately not an environment variable,
like `PASSWORD_CHANGE_EMAIL_VERIFICATION`.

**Backfill** (`npm run backfill:invoice-ledger`, dry-run by default, plan
digest required to commit, batch id recorded, rollback counterpart, as the KE
scripts work). For every order with a snapshot whose invoice is
**delivered or fulfilled at cutover**, insert an `invoices` row:

- origin `LEGACY_SNAPSHOT` (`LEGACY_IMPORT` for `KE-LEGACY-*`);
- its **existing number**;
- `issue_date` = its **printed date**, as given to the customer;
- `legacy_snapshot` = the snapshot verbatim;
- totals from the order's cents;
- `credited_*` = the order's approved refunds, with status derived;
- **no credit notes are created for pre-cutover refunds.** Back-dated
  numbered documents would be worse than none.

A validation counterpart checks counts, numbers and totals against the
orders.

**Transition reservations:** approved, not-yet-delivered orders at cutover
already hold a number drawn at creation. When delivered, they are issued
**with that number**, dated at delivery. A customer may already hold a
proforma showing it, and issuing a different number would put two numbers
on one sale. Their dates fall after newer-numbered invoices for a short,
bounded period; the cutover note records it.

**After cutover:**

- order creation (single and group) **stops drawing numbers**;
- `receipt_data` keeps its order snapshot (lines, buyer) for the proforma;
- `invoiceNumber` is simply absent.

**Number register:** one-off read-only report (`npm run report:invoice-number-register`)
for the accountant and auditors.

- **For each organization:** every number from 1 to the counter's
  `last_value` (`invoice_sequences`), with its fate:
  - *issued* (invoice number, date, order);
  - *not issued: order rejected / cancelled / refunded before delivery*
    (order and date);
  - *reserved* (approved, awaiting delivery);
  - *deleted*: matched to a `DELETE_ORDER` audit row, by its invoice number
    (rows from Phase 1 on) or by its order id within the deletion window;
  - *unaccounted*: no surviving order or audit row holds it. In practice
    these are orders deleted before 2026-09-26, when the route wrote no audit
    row (D5).
- **Output:** CSV plus a per-organization summary (issued, not issued,
  reserved, unaccounted). It goes into `updatedReports/`, which is
  gitignored, because it names customers.
- **New gaps are impossible after cutover:** numbers are drawn only when an
  invoice is actually issued, in the same transaction.

**Rollback:**

- Set the constant back to `"creation"`.
- Orders created in between get the TID fallback that `saveOrderReceipt`
  already has.
- Invoices already issued at delivery stay valid and are printed from their
  rows.
- The backfill's rollback deletes only its own batch (the trigger is
  disabled for that one statement inside the migration role's transaction).

### D7 — One definition of each thing, used everywhere

| Concept | Single home | Readers moved onto it |
|---|---|---|
| Invoice status | `lib/invoice-status.ts` + SQL twin | invoice page, Orders directory, consolidated report |
| Invoice number | `invoiceNumberSql` = `COALESCE(invoices.number, orders.receipt_data->>'invoiceNumber')` until cutover is complete, then `invoices.number` | `analytics/summary`, `drill-down`, branch export, `pending-invoice`, `overdue-payment-source`, `warehouse-orders`, `order-detail-panel` |
| Unpaid invoice | invoice ∈ {ISSUED, PARTIALLY_CREDITED} and order `payment_status = 'UNPAID'`, plus the existing FULFILLED rule for the ordering block | `pending-invoice.ts` and `unpaid-invoice-block.ts` both import it (closes defect 11) |
| "Tenant has invoiced" | `EXISTS invoices WHERE organization_id = …` | organization-code lock |
| Number format | `lib/invoice-number.ts` (`formatInvoiceNumber`, plus the new credit-note formatter) | tax invoices, credit notes, the consolidated series if built (F2) |

A contract test lists every reader of `receipt_data->>'invoiceNumber'`. After
the switch-over phase, only the legacy renderer and the backfill may read it.

### D9 — Customer STRN on the organization (Phase 0, answer 3b)

- **Column:** `organizations.strn_number` varchar(32), nullable, the same as
  `ntn_number` (`drizzle/20260822120000_add_organization_ntn_number.sql`).
  Nullable, so every existing organization stays valid without one and an
  operator can clear a wrong value.
- **Validation:** the same Zod rule as NTN (`organizationNtnNumber` in
  `lib/server/mutation-validation.ts`, generalised to
  `organizationTaxIdentifier`): trimmed, ≤ 32 characters, letters, digits
  and hyphens. A blank value becomes null.
- **Writers:** only the Create Organization (`POST /api/v1/organizations`)
  and Edit Organization (`PATCH /api/v1/organizations/[id]`) forms on
  `app/(portal)/organizations/page.tsx`, beside the NTN field. Both routes
  are already Super Admin's, and the field is picked explicitly, never
  spread.
- **Audit:** an STRN change is recorded in the existing organization-update
  audit row, before and after.
- **Use:**
  - snapshotted into `invoices.buyer` at issue (D2) and printed under Bill To
    beside the NTN on tax invoices and credit notes;
  - on the proforma, read live (a proforma is not a frozen document);
  - legacy invoices print as today, without it.
- **Lands in Phase 1:** additive migration; it is useful on the proforma
  immediately.

### D8 — Payment

`orders.payment_status` stays as is in this plan. The ordering block, the
Paid/Unpaid control and the dashboards depend on it, and it already applies
only to delivered and fulfilled orders, which now always have an invoice.

A receivables ledger (payments recorded against invoices, partial payments,
allocation, customer statements, ageing) is follow-up F1. It will move
"paid" onto the invoice.

## As built (2026-10-11) — where the build differs from the design above

- **Numbers are written back to the order's snapshot.** D7 proposed moving
  every reader of `receipt_data->>'invoiceNumber'` onto an
  `invoiceNumberSql` join. Instead, issuing at delivery also writes the number
  into `orders.receipt_data.invoiceNumber`, so every existing reader (pending
  invoice, unpaid-invoice block, analytics, exports, warehouse) stays correct
  without being touched, and the Phase 5 "remove the fallback" step has
  nothing to remove. `invoiceNumberSql` was not created.
- **The organization-code lock is unchanged.** It still locks the code once
  the tenant has any order with a snapshot. That is stricter than "once an
  invoice is issued" and was left as is.
- **No lazy backfill.** A refund on an order supplied before the ledger, and
  not yet backfilled, records its tax but issues no credit note; the backfill
  later records it as credited. Run the backfill before deploying, and again
  after, so that window is minutes.
- **No warehouse credit-note route.** The warehouse's invoice PDF (shared
  builder) lists the credit notes issued against the invoice; downloading the
  credit note itself stays with the tenant's invoice readers.
- **Test cleanup.** The immutability triggers allow a delete only in a
  database whose name contains `test`, with
  `oneflowe.invoice_ledger_test_cleanup` set for the transaction
  (`tests/integration/helpers/invoice-ledger-cleanup.ts`); the contract test
  forbids that setting anywhere in application code.
- **`credit_note_sequences` cascades with its organization**, as
  `invoice_sequences` does.
- **The consolidated report** (`plans/OF-INVOICE-consolidated-invoices.md`) is
  not built yet. It should now read `invoices` (dated by `issue_date`) less
  `credit_notes`, as that plan's dependency note says.
- **Pending-invoice notice narrowed** to issued tax invoices (D7, defect 11):
  an approved, undelivered order no longer triggers "you have a pending
  invoice". This reverses part of `plans/OF-ORDERS-pending-invoice-notice.md`;
  its tests were changed deliberately.

### Release order

1. Apply `20261014120000_add_organization_strn_number` and
   `20261015120000_add_invoice_ledger` (manually, as production migrations are
   run).
2. `npm run backfill:invoice-ledger` — dry run; check the summary; commit with
   the printed digest. Print `DATABASE_URL`'s host first.
3. Deploy.
4. `npm run backfill:invoice-ledger` again; then `--validate`.
5. `npm run report:invoice-number-register` for the accountant (Q6).

Rollback of the code: set `INVOICE_ISSUE_POINT` back to `"creation"` and
redeploy, or revert. Invoices and credit notes already issued stay, and keep
printing from their rows.

## Phases (each shippable and reversible on its own)

| Phase | Contents | Behaviour change |
|---|---|---|
| **0** | Tax adviser answers: **done 2026-10-11** (Q6 with the accountant) | — |
| **1** | Invoice status module + SQL twin; status on the invoice page and Orders directory; "PROFORMA INVOICE" title while approved; **customer STRN** on the organization forms (D9, additive migration); **invoice number on the delete-order audit row** (D5) | display + one new field + audit detail |
| **2** | Migration: tables, trigger, `orders_id_organization_uq`; backfill script + validation + rollback; **no writer changes** | none (new tables filled) |
| **3** | Readers through `invoiceNumberSql` and invoice rows; legacy renderer path; credit-note read routes; delete guard (D5); `tax_refund_cents` written by both refund paths | delete guard; refund tax recorded |
| **4** | **Cutover** (after Phase 0): issue at delivery (D2), credit notes at refund (D3), stop drawing at creation, stop `updateReceiptWithRefund`, frozen tax invoice and credit note PDFs (D4) | the accounting change |
| **5** | Contract: remove the `receipt_data` invoice-number fallback from readers; consolidated report reads `invoices` (see below); `CLAUDE.md` | cleanup |

## Phase 0 — status

All answered on 2026-10-11 (table at the top) except **Q6**: whether the
number register (D6) is sufficient documentation for the gaps in the
pre-cutover series. That is for the company's accountant to confirm, and it
does not block any phase. The register is built either way.

## Tests

**Unit:**

- Invoice and credit-note number formats; series independence.
- Line building: pre-delivery refunds (itemised and un-itemised), decimal
  quantities, a line refunded to zero.
- Credit-note splitting: itemised; un-itemised pro rata with residue;
  mixed rates.
- Status transitions; cutover reservation logic.

**Integration:**

- **Issue at delivery:**
  - one invoice per delivered order;
  - gap-free under concurrent deliveries in one organization;
  - a failure rolls back the delivery;
  - a retried delivery issues nothing new.
- **Credit notes:**
  - one per approved refund;
  - concurrent approvals cannot over-credit (the check holds);
  - status moves Issued → Partially credited → Credited;
  - `tax_refund_cents` is written by both paths.
- **Immutability:** every refused `UPDATE`/`DELETE` raises; a reprint
  matches the issue-time digest after the branch address, NTN and cost
  center are changed.
- **Delete guard:** delivered → 409; undelivered approved → deleted, with no
  number burned after cutover.
- **Backfill:**
  - counts and totals reconcile;
  - legacy rows print identically to today (PDF text compared);
  - re-run is a no-op;
  - rollback removes only its batch.
- **Tenant isolation:** composite FKs refuse cross-organization rows;
  credit-note routes 404 outside scope; full role matrix as for invoices.
- **Readers:** every number reader returns the same value before and after
  Phase 3.
- **Unpaid invoice:** the dashboard and the ordering block agree.

**E2E:** approve → proforma; deliver → tax invoice with a number dated today;
partial refund → credit note; reprint unchanged.

## Security and audit

- **Access:** no new readers beyond those who read invoices today; credit
  notes follow the same policy and price visibility.
- **Writes:** only in the delivery and refund-approval transactions, which
  are already role-checked (Super Admin, warehouse in reach).
- **Audit:** `ISSUE_TAX_INVOICE`, `ISSUE_CREDIT_NOTE` and the backfill batch
  are all written to `audit_logs`.
- **Immutability:** enforced by triggers, so a defect, a script or a console
  session cannot alter an issued document without a deliberate migration.

## Database impact

- **New objects:** five tables, one trigger function with three triggers,
  and a unique constraint on `orders (id, organization_id)`. The index is
  built over tens of thousands of rows in seconds; run it off-hours.
- **Backfill:** one `invoices` row per delivered or fulfilled order, plus
  lines. Batched, digest-gated, with validation and rollback.
- **Release order:** apply each phase's migration manually before deploying
  that phase.

## Consequences for the consolidated report

`plans/OF-INVOICE-consolidated-invoices.md` should be built **after Phase 3**
and read the ledger:

- **Rows:** `invoices`.
- **Invoice Date:** `issue_date` (no more `to_date()` on text).
- **Value, tax, total:** the invoice's figures less its credit notes.
  `refunds.tax_refund_cents` is 0 for every app refund today (defect 6), so
  the report's current refund-tax formula would understate the tax deducted.
  The ledger fixes this at the source.
- **Approved orders:** remain proforma rows from the order.

Until then, the report plan's own query is the fallback.

## Follow-ups

- **F1 — Receivables:** payments against invoices, partial payments,
  allocation, customer statements of account, ageing; "paid" moves to the
  invoice.
- **F2 — Numbered consolidated invoices** (the 2026-10-09 design), on top of
  `invoices`, with its own counter table like `credit_note_sequences`.
- **F3 — Partial deliveries:** several invoices per order (relax
  `UNIQUE (order_id)`).
- **F4 — Customer STRN and tax registration fields**, depending on the Phase
  0 answer.
