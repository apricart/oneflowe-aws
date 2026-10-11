# OF-INVOICE — Consolidated Invoice Report (preview and PDF download)

Status: **decided, ready to build** (revised 2026-10-11 on top of the invoice
ledger). Rename with the Jira ID when one is assigned.

Builds on `plans/OF-INVOICE-invoice-ledger.md`, now in production: tax invoices
are records in `invoices` / `invoice_lines`, issued and dated at delivery;
refunds against them are `credit_notes`; and every invoice supplied before the
ledger was copied in on 2026-10-11 (batch `59e78541f853162b`, 1,184 rows).
This revision replaces the 2026-10-10 version, which read `orders.receipt_data`
and parsed a text date.

## Requirement

The consolidated invoice is **for reporting only**. Nothing is issued, numbered,
saved, paid or voided.

A **Consolidated Invoice Report** for **Super Admin and Head Office**:

1. **A view of filters:**
   - organization (Super Admin);
   - period, **by month** or by **custom date range**;
   - branches and/or group;
   - which documents: **issued invoices** (delivered / fulfilled) or
     **proformas** (approved, not yet delivered);
   - whether to include fully credited invoices.
2. **A preview** of the exact document those filters produce.
3. **Download** as a PDF in the supplied template
   (`Group Invoice_Consolidation.pdf`).

Carried over from the requester:

- CRC = the branch's Cost Center ID.
- The Invoice Period printed is the selected period.
- Multi-page PDFs carry page numbers.

## What changed since the last version, and why it matters

| Before (2026-10-10 plan) | Now (ledger in production) |
|---|---|
| Rows from `orders.receipt_data` | Rows from `invoices` |
| Invoice date parsed from text (`to_date(receipt_data->>'date')`) with a `created_at` window | `invoices.issue_date`, a real `date` column, indexed `(organization_id, issue_date)` |
| Refund tax recorded on no app refund, so the report would have understated the tax credited | `invoices.credited_net/tax/total_cents` record what was credited, tax included, for every invoice |
| Invoice status derived per row | `invoices.status` (Issued, Partially credited, Credited) is stored by the ledger |
| A row's figures could drift from its invoice (live branch, live NTN) | Issued invoices are frozen; the report reads the same frozen buyer, lines and totals the invoice prints |
| Approved orders mixed in with delivered ones | Proformas are not tax invoices; they are a separate report mode, never mixed with invoices |
| No migration | Still no migration: everything needed exists |

## What exists (investigation, 2026-10-11)

### The ledger

| Column (`invoices`) | Use in the report |
|---|---|
| `organization_id`, `branch_id` | tenant and branch fence; composite FK to `branches (id, organization_id)` |
| `order_id` | order status label, Order ID column, legacy fallbacks; `UNIQUE` |
| `number` | Invoice No (unique per organization: `invoices_org_number_uq`) |
| `issue_date` | Invoice Date and the period match |
| `origin` | `ISSUED_AT_SUPPLY` (frozen rows and lines) or `LEGACY_SNAPSHOT` / `LEGACY_IMPORT` (backfilled) |
| `status` | Issued / Partially credited / Credited |
| `buyer` (jsonb) | `branchName`, `costCenterId`, `organizationName`, `ntn`, `strn` as at issue (as at backfill for legacy rows) |
| `participants` (jsonb) | `approvedByName` as at issue; `{}` on legacy rows |
| `net_cents`, `tax_cents`, `total_cents` | invoiced figures |
| `credited_net_cents`, `credited_tax_cents`, `credited_total_cents` | everything credited since, in cents |

- `invoice_lines` (issued at supply only): quantity and `tax_rate_bp` per line.
- `credit_note_lines`: quantity credited per line, null for an un-itemised
  adjustment.
- Legacy rows have no lines. Their quantities and rates come from
  `order_items`, and refunded quantities from approved `refund_items`.

### Dates: two meanings in one column, by design

- **Issued at supply:** `issue_date` is the Karachi date of **delivery**.
- **Legacy:** `issue_date` is the date the invoice was **printed** with, which
  was the order's creation date.

The report shows each invoice under the date printed on it, which is what the
customer holds. The legacy/new boundary is 2026-10-11; a report spanning it
mixes both meanings and says so in a footnote (D7).

### Production volumes

- 1,184 invoices across 4 organizations; K-Electric has 1,051, the largest.
- A whole year for K-Electric is about 1,000 rows, so the 1,000-row cap (D5)
  is checked against real numbers before release.

### Conventions reused

- **Report shell and filters:**
  - report pages under `app/(portal)/reports/*`;
  - Super Admin's organization from the context selector;
  - `BranchFilter` / `GroupFilter`, whose endpoints already pin Head Office to
    its own organization;
  - role-specific hub cards in their own array.
- **PDF table:** `jspdf` + `jspdf-autotable` on the server, which gives page
  breaks, a repeated header row, `colSpan` bands and wrapped cells.
- **Sorting:** server sort through an allowlist in `lib/list-sort-keys.ts`,
  checked by the table-sort contract.
- **Masthead:** `INVOICE_ISSUER` and the logo, as the invoice PDF uses them.
- **Access:** role allowlists in a `lib/*-access.ts` module rather than new
  `Permission` keys (as `lib/product-request-access.ts` does), because a new
  key needs `db:seed` on production.

## Decisions

### D1 — Access: Super Admin and Head Office only

| | Super Admin | Head Office | Every other role |
|---|---|---|---|
| Open the page | ✔ | ✔ | redirected by `proxy.ts` |
| Preview / PDF | the organization it selects (required) | **its own organization only** | 403 |

- `CONSOLIDATED_INVOICE_REPORT_ROLES` and `canReadConsolidatedInvoiceReport(role)`
  live in `lib/consolidated-invoice-access.ts`. The sidebar, the hub card and
  both handlers read them.
- **Head Office's organization** comes from `getRequestScope()`, never the
  request. An `organizationId` it sends is ignored; a Head Office account
  without an organization is 403.
- **Super Admin's** `organizationId` is required (400 without it) and must
  exist (404).
- **`branchIds` (≤ 200) and `groupId`** are checked against that organization
  in one query, otherwise **404** "Branch not found" / "Group not found".
- **`proxy.ts`** gets `ROLE_GATED_AREAS` `{ prefix: "/reports/consolidated-invoices", roles: ["SUPER_ADMIN", "HEAD_OFFICE"], home: "/reports" }`.
  Branch Admin and Group User reach `/reports/*` today, so this gate is needed.
- **No price redaction:** Head Office is never price-restricted.

### D2 — Two report modes, never mixed

| Mode | Rows | Title | Period matched on |
|---|---|---|---|
| **Invoices** (default) | `invoices` rows: Issued and Partially credited; Credited too when "include fully credited" is ticked | **CONSOLIDATED INVOICE** | `invoices.issue_date` |
| **Proformas** | orders that are approved, not delivered (`deriveInvoiceStatus` = Proforma available), with no invoice row | **CONSOLIDATED PROFORMA** | Karachi date of `orders.approved_at` |

- **Why not both in one document:** a tax invoice and a proforma are different
  documents. A total that adds proformas to invoices states an amount that was
  never invoiced. The requester's "approved orders" filter is honoured as its
  own mode.
- **Proforma rows:**
  - Invoice No shows the number reserved when the order was placed, marked
    "(on delivery)", or "On delivery" if there is none;
  - Invoice Date shows the approval date;
  - figures are the order's own, less refunds approved before delivery.
- **The PDF footer says what the document is:**
  - Invoices: "Summary of the tax invoices listed; sales tax is charged on
    each. Not a separate tax invoice."
  - Proformas: "Proformas only; no tax invoice has been issued for these
    orders."

### D3 — Period: month or custom range

- **Month:** a year select plus a month select, sent as `month=YYYY-MM`.
- **Range:** `from`/`to` as `YYYY-MM-DD`, inclusive, `from ≤ to`, at most 366
  days, `to` no later than today in Karachi.
- The browser sends **date strings**; the server compares them directly with
  `issue_date` (`BETWEEN $from AND $to`), with no time-zone arithmetic. That
  uses `invoices_org_issue_date_idx`.
- Proformas compare `(approved_at AT TIME ZONE 'Asia/Karachi')::date`; the
  number of approved, undelivered orders is small (66 in production today).

### D4 — Row figures: the invoice, less what has been credited

`lib/consolidated-invoice.ts` (pure) builds every row and total; the preview
and the PDF both render its output.

| Column | Invoices mode | Proformas mode |
|---|---|---|
| Invoice No | `invoices.number` | reserved number "(on delivery)", or "On delivery" |
| Invoice Date | `issue_date` | Karachi approval date |
| Order ID | `order_id` | `orders.id` |
| Order Status | `getOrderDerivedStatus(order, "fulfilled").label` | same |
| Department | `buyer.branchName` (as at issue) | live `branches.name` |
| Approver | `participants.approvedByName`; legacy rows: the live approver's display name | live approver's display name |
| Designation | blank (no source; follow-up F4) | blank |
| CRC | `buyer.costCenterId` (as at issue) | live `branches.cost_center_id` |
| Items (Qty) | invoiced quantity less quantity credited (see below) | order quantity less refunded quantity |
| Value Excl. Sales Tax | `net_cents − credited_net_cents` | order net less refunded net |
| Sales Tax % | one distinct line rate → "18%"; several → "Mixed"; none → "—" | same, from `order_items` |
| Sales Tax Amount | `tax_cents − credited_tax_cents` | order tax less refunded tax |
| Total Amount | `total_cents − credited_total_cents` | order total less refunds |

- **Quantity:**
  - issued at supply: `Σ invoice_lines.quantity − Σ credit_note_lines.quantity`;
  - legacy: `Σ order_items.quantity − Σ approved refund_items.quantity`;
  - an un-itemised credit has no quantity and moves money only.
- **Refunds before delivery (proformas)** use `refundTaxCents`
  (`lib/invoice-ledger.ts`), the same rule the ledger uses, so the two modes
  split tax identically.
- **Credits are applied as at the moment the report is generated**, whatever
  the credit note's own date. A report for August pulled in October shows each
  August invoice net of everything credited since. That is the figure the
  customer owes against each invoice now, and it matches the individual
  invoice's status. Showing credit notes by their own dates is follow-up F3.
- **Totals row and header cards** are column sums in **cents**, formatted only
  at the edge.
- Every row satisfies **Value + Tax = Total**. The ledger guarantees it for
  issued invoices, and the backfill checked it for every legacy row (0
  exceptions in production).

### D5 — Query: one statement per mode, bounded

`lib/server/consolidated-invoice-queries.ts`.

Invoices mode, in outline:

```
invoices i
  JOIN orders o           ON (o.id, o.organization_id) = (i.order_id, i.organization_id)
  JOIN branches b         ON (b.id, b.organization_id) = (i.branch_id, i.organization_id)   -- group filter
  LEFT JOIN users ap      ON ap.id = o.approved_by_user_id                                  -- legacy approver
  + correlated aggregates: invoiced quantity and distinct rates (invoice_lines, or order_items for legacy),
    credited quantity (credit_note_lines, or approved refund_items for legacy)
WHERE i.organization_id = $org
  AND i.issue_date BETWEEN $from AND $to
  AND i.status = ANY($statuses)              -- ISSUED, PARTIALLY_CREDITED [, CREDITED]
  [AND i.branch_id = ANY($branchIds)] [AND b.group_id = $groupId]
ORDER BY <allowlisted sort>, i.issue_date, i.number, i.id
LIMIT 1001
```

- **One statement, no N+1.** Only the columns the report prints are selected;
  `legacy_snapshot` and `seller` are never read.
- **Bound:** more than 1,000 rows answers **422** "This selection has more
  than 1,000 invoices: narrow the period or branches", with the count.
- **Sorting:**
  - keys come from `CONSOLIDATED_INVOICE_SORT_KEYS` (400 for anything else),
    mapped through a `Record<Key, SQL>`;
  - the PDF uses the same sort as the preview;
  - default order is invoice date, then number;
  - S.No follows the chosen order.
- **Proformas mode** reads `orders` with `invoiceStatusSql = 'PROFORMA_AVAILABLE'`
  and the same fences, joins and bound.

### D6 — Screen: Reports → Consolidated Invoice Report

- **Placement:** the Reports submenu for Super Admin and Head Office in
  `components/shell/sidebar.tsx`, and a card on the Reports hub in its own
  `consolidatedInvoiceReportCards` array.
- **Page:** `app/(portal)/reports/consolidated-invoices/page.tsx`, with
  components in `components/reports/consolidated-invoice/`.
  1. **Filters:**
     - organization (Super Admin, from the context selector; without one, the
       page asks to pick one);
     - Period (Month or Custom range);
     - Branches, Group;
     - **Mode:** Invoices or Proformas;
     - **Include fully credited** (Invoices mode).

     The filters live in the URL, so a report can be bookmarked.
  2. **Preview:** an HTML rendering of the template.
     - Masthead, and the four header cards: Bill To with NTN and STRN,
       Invoice Period, Total Orders and Total Items, Grand Total (excl. +
       tax).
     - Two-band column header: gold "Apricart Details" over Invoice No and
       Invoice Date; navy "<Organization> Details" over the rest.
     - Zebra rows, a Total row, and sortable headers.
     - On screen only: an invoice-status badge per row (`InvoiceStatusBadge`),
       and each Invoice No links to `/invoices/[orderId]`, where the invoice
       and its credit notes can be downloaded.
  3. **Download PDF:** disabled while a request is in flight, and while the
     preview is empty or loading.
- **States:** loading; empty ("No invoices match these filters"); 422 (the
  narrowing message); error (the API's safe message).
- **Bill To** prints the organization's **current** name, NTN and STRN. A
  report describes the account as it is now; each row keeps the branch and
  cost centre recorded on its own invoice.

### D7 — PDF: server-built, matching the template

`lib/server/consolidated-invoice-pdf.ts`, jsPDF + jspdf-autotable, A4
landscape.

- **Masthead:** the logo (its loader extracted from `invoice-pdf.ts` into a
  shared helper), `INVOICE_ISSUER`, and the title from D2.
- **Header cards** as in the template; STRN under NTN when present.
- **Table:**
  - a two-row head (bands with `colSpan`, then the column titles);
  - right-aligned figures; wrapped Department, Approver and CRC;
  - the Total row as the foot;
  - `showHead: "everyPage"`, `showFoot: "lastPage"`.
- **Footer on every page:** "Page x of y", "Generated on <Karachi date-time>",
  and the D2 statement.
- **Footnote when relevant:** when the period includes dates before
  2026-10-11, one line says "Invoices dated before 11 Oct 2026 carry their
  order date; later invoices carry their delivery date."
- **File name:** `consolidated-invoice-<ORGCODE>-<from>_<to>.pdf`, or
  `consolidated-proforma-…`, through `safeFilenamePart`.

### D8 — API

| Method | Path | Roles | Rate limit |
|---|---|---|---|
| GET | `/api/v1/reports/consolidated-invoice` | SA, HO | `search` |
| GET | `/api/v1/reports/consolidated-invoice/pdf` | SA, HO | `report` (fail-closed) |

**Query parameters, validated with Zod `.strict()`:**

| Parameter | Values |
|---|---|
| `organizationId` | Super Admin only |
| `mode` | `invoices` \| `proformas` |
| `period` | `month` \| `range` |
| `month`, or `from` + `to` | as in D3 |
| `branchIds` | ≤ 200 |
| `groupId` | one group |
| `includeCredited` | `true` \| `false` |
| `sort`, `dir` | allowlisted (D5) |

- **Handler order:** rate limit → session (401) → role (403) → scope from the
  database → validate (400) → fence filters (404) → query → cap (422) →
  respond.
- **JSON:** `{ mode, billTo: { name, ntn, strn, code }, period: { from, to, label }, rows[], totals, count }`,
  with money in cents.
- **Headers:** `Cache-Control: no-store` on both routes. No request body, so
  the WAF's 8 KB limit does not apply.

### D9 — Audit

Every PDF download writes one `audit_logs` row: `DOWNLOAD_CONSOLIDATED_INVOICE_REPORT`.

- It records organization, actor, role, mode, period, filters, row count and
  grand total in cents.
- It records a SHA-256 of the ordered `(number, totalCents)` list, so a
  document handed to a client can be verified later.
- No names, no lines. Previews are not audited, like other reports.

## Modules

| File | Layer | Contents |
|---|---|---|
| `lib/consolidated-invoice-access.ts` (+ test) | pure | D1 role allowlist |
| `lib/consolidated-invoice.ts` (+ test) | pure | Zod schema, period resolution (D3), row and total arithmetic (D4), tax-rate label, digest, file name, footnote rule, limits |
| `lib/list-sort-keys.ts` *(edit)* | pure | `CONSOLIDATED_INVOICE_SORT_KEYS` |
| `lib/server/consolidated-invoice-scope.ts` | server | caller → organization; branch/group fence |
| `lib/server/consolidated-invoice-queries.ts` | server | D5, both modes |
| `lib/server/consolidated-invoice-pdf.ts` (+ test) | server | D7 |
| `lib/server/pdf-logo.ts` | server | logo loader shared with `invoice-pdf.ts` |
| `app/api/v1/reports/consolidated-invoice/route.ts`, `.../pdf/route.ts` | routes | D8, thin |
| `app/(portal)/reports/consolidated-invoices/page.tsx` | UI | host page |
| `components/reports/consolidated-invoice/{filters,period-picker,document}.tsx` | UI | D6 |
| `components/shell/sidebar.tsx`, `app/(portal)/reports/page.tsx`, `proxy.ts` *(edits)* | UI / edge | placement and gate |
| `CLAUDE.md` *(edit)* | docs | one paragraph |

**Reused, not rebuilt:**

- `lib/invoice-status.ts` (`deriveInvoiceStatus`, `INVOICE_STATUS_LABELS`);
- `lib/server/invoice-status-sql.ts` (proforma selection);
- `lib/invoice-ledger.ts` (`refundTaxCents`);
- `components/orders/invoice-status-badge.tsx`;
- `INVOICE_ISSUER`.

**No schema change, no migration, no new dependency.**

### Build order

1. Pure modules (`consolidated-invoice`, `-access`) with unit tests.
2. Scope and queries (both modes), the JSON route, and integration tests.
3. PDF renderer and route, with the audit row.
4. Page, filters, preview; sidebar, hub card, proxy gate; contract lists;
   `CLAUDE.md`.

## Tests

### Unit

- **Periods:** a leap February, December → January, ranges of 0, 366 and 367
  days, `from > to`, a future `to`, a malformed month, unknown parameters.
- **Rows:**
  - an uncredited invoice;
  - partly and fully credited invoices, where the figures equal invoiced minus
    credited and Value + Tax = Total;
  - a legacy row's quantity from order items less refunded items;
  - mixed and absent tax rates;
  - a proforma with a refund before delivery, whose tax matches
    `refundTaxCents`.
- **Totals and output:** totals equal the column sums; the footnote rule;
  digest stability; file-name sanitising; the role allowlist.
- **PDF:** one page and many pages; "Page x of y"; the header repeats; totals
  appear once; both titles; both footer statements; every invoice number
  appears in the extracted text.

### Contract

- Both routes are on `lib/server/security-boundaries.test.ts`; each checks the
  allowlist itself and takes the organization through `getRequestScope`.
- The page and route are on `table-sort-contract.test.ts`.
- The sidebar entry and hub card exist for Super Admin and Head Office only;
  the proxy gate is present.
- The queries read `invoices.issue_date` and never `receipt_data`.

### Integration (`tests/integration/consolidated-invoice-report-api.test.ts`)

Fixtures issue invoices through `progressOrderFulfillment` and credit them
through the refund route, so the report reads real ledger rows. Cleanup goes
through `purgeInvoiceLedger`.

- **Roles:** 401 when unauthenticated; 403 for Branch Admin, Group User, Order
  Portal, Group Order Portal, Viewer, Order Desk, Apricart Executive and
  Warehouse; 200 for Super Admin and Head Office on both routes.
- **Tenant isolation:**
  - Head Office of A sending `organizationId=B` still gets A;
  - B's branch or group → 404;
  - Super Admin without `organizationId` → 400;
  - the two-tenant fixture never leaks a row.
- **Modes:**
  - Invoices mode never contains an undelivered order;
  - Proformas mode never contains a delivered one;
  - `includeCredited` toggles Credited rows.
- **Periods:** an invoice delivered at 23:30 Karachi on 31 Aug is in August;
  a legacy row is matched on its printed date.
- **Row parity:** each row's total equals the individual invoice's TOTAL less
  its credit notes, and its quantity equals the delivered quantity less what
  was credited.
- **Credits:** a credit note issued after the period still reduces the row.
- **Bounds:** more than 1,000 rows → 422.
- **Sorting:** an unknown sort key → 400; the PDF order equals the JSON
  order.
- **Audit:** the row is written with the right digest.
- The warehouse isolation and write sweeps stay green.

### E2E

Head Office opens Reports → Consolidated Invoice Report, picks a month,
previews, downloads, then switches to Proformas. A Branch Admin typing the URL
is sent back to `/reports`.

## Security impact

- **Authentication:** session on both routes; the forced-password-change gate
  applies.
- **Authorization:** two-role allowlist in each handler; the proxy gate is for
  navigation only.
- **Tenant isolation:**
  - organization from the `users` row;
  - filters fenced with 404;
  - joins on composite tenant keys;
  - the integration suite holds two tenants.
- **Input:** Zod strict; enum allowlists; dates bound as parameters; sort via
  an allowlist; no `sql.raw`.
- **Abuse:** ≤ 1,000 rows, ≤ 366 days, ≤ 200 branch ids; rate limits;
  `no-store`.
- **Exposure:** invoice numbers, branch, cost centre, approver name and
  figures only.
- **Audit:** every download, with a verifiable digest.

## Database impact

- **None:** no migration, index or backfill.
- **Index:** reads use `invoices_org_issue_date_idx`.
- **Before release:** `EXPLAIN ANALYZE` read-only (`begin read only`) for a
  12-month K-Electric query.

## Operational notes

- **The report reads only the ledger.** An order imported by `import:ke-orders`
  appears only after `npm run backfill:invoice-ledger` has run (the ledger
  plan already requires that after every import).
- `npx tsx scripts/backfill-invoice-ledger.ts --validate` must show nothing in
  `creditedTotalsOutOfStep` before a report is handed to a customer; a stale
  credited total would show here as a wrong row.

## Risk

| Risk | Mitigation |
|---|---|
| A row from another tenant | Organization from the database; fenced filters; composite joins; two-tenant fixture |
| A row disagreeing with its invoice or credit notes | Figures read straight from `invoices.*_cents` / `credited_*`; row-parity test |
| Invoices and proformas added into one total | Separate modes, separate titles, never mixed (D2) |
| Mixed date meanings across 11 Oct 2026 | Footnote on any period that spans it (D7) |
| Slow query on K-Electric | Index on `(organization_id, issue_date)`; cap of 1,000 rows; `EXPLAIN` before release |

## Follow-ups (not in this change)

- **F1 — Excel export** of the same rows (reuses the JSON route and
  `sanitizeSpreadsheetRow`).
- **F2 — Numbered, saved consolidated invoices** (issue, payment, void), if
  the business moves from reporting to billing. They would charge each
  `invoices` row once and carry credit notes as credit lines (outline in the
  ledger plan's F2).
- **F3 — Credit notes by their own date:** an option to show credit notes
  issued in the period as their own negative rows, instead of netting each
  invoice as at today.
- **F4 — Designation:** a `users.designation` column, if the customer wants
  that column filled.
