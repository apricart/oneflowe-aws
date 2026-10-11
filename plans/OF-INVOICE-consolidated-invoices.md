# OF-INVOICE — Consolidated Invoice Report (preview and PDF download)

Status: **decided; build after Phase 3 of `plans/OF-INVOICE-invoice-ledger.md`.**
Rename with the Jira ID when one is assigned.

> **Dependency (2026-10-11).** The invoice-ledger investigation found that app
> refunds never record their tax part (`refunds.tax_refund_cents` is 0 for
> them), so D5's `refundTax` would understate the tax deducted on refunded
> orders. Built on the ledger, rows come from `invoices` (dated by
> `issue_date`) less their credit notes, and that problem disappears. If this
> report must ship first, derive the refunded tax from `refund_items` ×
> `order_items.tax_rate_bp` via `splitInclusiveCents` instead of
> `tax_refund_cents`.

## Requirement (revised 2026-10-10)

The team decided the consolidated invoice is **for reporting only**. Nothing
is issued, numbered, saved, paid or voided. This supersedes the earlier
issue/payment design (kept in outline as follow-up F2).

A **Consolidated Invoice Report** for **Super Admin and Head Office**:

1. **A view of filters:**
   - organization (Super Admin);
   - period, **by month** or by **custom date range**;
   - branches and/or group;
   - which orders: **delivered & fulfilled**, **approved (not yet
     delivered)**, or both;
   - whether to include fully refunded orders.
2. **A preview** of the exact document those filters produce.
3. **Download** of that document as a PDF in the supplied template
   (`Group Invoice_Consolidation.pdf`).

Carried over from earlier decisions with the requester:

- CRC = the branch's Cost Center ID (`branches.cost_center_id`, set when a
  branch is created or edited).
- The Invoice Period printed is the selected period.
- Multi-page PDFs carry page numbers.
- Every invoice has a status (D2).

## Investigation

### The individual invoice (unchanged by this work)

- **No invoice table exists.** An invoice is the snapshot
  `orders.receipt_data` (jsonb): number, printed date, lines, totals. It is
  written at order **creation** by `saveOrderReceipt`
  (`app/api/v1/orders/route.ts`), by `lib/server/group-order-creation.ts` and
  by the KE importers. The only invoice table is `invoice_sequences` (one
  counter row per organization).
- **Availability:** `isInvoiceAvailableForOrder` (`lib/invoice-availability.ts`)
  — from approval onwards, including refunded orders whose `status_at_refund`
  was approved or fulfilled.
- **Readers:** `GET /api/v1/receipts/[orderId]`, `.../download`
  (`buildInvoiceDocument` → `renderInvoicePdf`, hand-drawn jsPDF, portrait),
  and the warehouse invoice route.
- **Access:** `resolveInvoiceAccess` (`lib/invoice-access-policy.ts`).

**A report needs no new table.** It reads what exists. This change has **no
migration**.

### Invoice numbers on the report are unique

| Source | Format | Uniqueness |
|---|---|---|
| Current | `<ORGCODE>-APR-000001` | `orders_tenant_prefixed_invoice_number_unique_idx` — global |
| Before 2026-09-24 | `APR-000030` | `orders_org_invoice_number_unique_idx` `(organization_id, number)` — per organization |
| KE imports | `KE-LEGACY-<id>` | per organization |
| Fallback (sequence table missing) | order `tid` | `orders.tid` unique |

A report covers **exactly one organization** (the Bill To), so no number can
appear twice on it. Gaps in the series are expected: numbers are drawn at
creation, and rejected or cancelled orders never reach an invoice (the sample
skips `APR-000036` and `APR-000040`).

### The printed invoice date is the one to filter on

- `receipt_data.date` is `toLocaleDateString("en-US")` (`MM/DD/YYYY`) in the
  time zone of the process that created the order: the production container
  for app orders, a Karachi workstation for the KE imports.
- For orders placed 00:00–05:00 Karachi time it differs by a day from the
  Karachi date of `created_at`.
- A report that selected on `created_at` could therefore list a row printed
  **31 Aug** under **September**. That contradicts the invoice it summarises.

The report selects on the **printed date** (D4).

### Refunds, payment, money

- A **full refund** sets `status = 'REFUNDED'` (keeping `status_at_refund`).
- A **partial refund** sets `refund_amount_cents > 0`
  (`getOrderRefundVariant`, `lib/order-status.ts`).
- `refunds.tax_refund_cents` is the tax part.
- Order money is integer cents: `orders.subtotal_cents`, `tax_cents`,
  `total_cents`.
- `order_items.quantity` is numeric(12,3); `order_items.tax_rate_bp` holds the
  rate.

### Existing report conventions this reuses

- **Shell and context:**
  - report pages are client components under `app/(portal)/reports/*`, inside
    the portal shell;
  - Super Admin's organization comes from the shell's context selector
    (`useAppContext().organizationId`);
  - the hub `app/(portal)/reports/page.tsx` lists role-specific cards in their
    own arrays (`executiveOnlyReportCards`, `groupUserOnlyReportCards`), so no
    role is offered a page it cannot open.
- **Filters:**
  - `BranchFilter` and `GroupFilter` (`components/reports/`) load from
    `GET /api/v1/branches` and `GET /api/v1/groups`;
  - both endpoints already pin Head Office to its own organization on the
    server (`getRequestScope()` in branches; session organization in groups),
    so they can be reused as they are.
- **PDF tables:**
  - `jspdf` 4.2.1 and `jspdf-autotable` 5.0.8 are already dependencies, used
    by eight report pages;
  - autotable handles page breaks, repeating headers, multi-row headers with
    `colSpan`, and wrapped cells, which is exactly what the template's
    two-band header and long Department/Approver names need;
  - it runs in Node (only its `html:` option needs a DOM), so the PDF can be
    built **on the server**.
- **Sorting:**
  - every Reports table sorts (`plans/OF-TABLE-column-sorting.md`);
  - server-sorted routes admit only allowlisted keys from
    `lib/list-sort-keys.ts`;
  - `lib/server/table-sort-contract.test.ts` lists each one.
- **Proxy:**
  - `/reports/*` is open to Super Admin, Head Office, Branch Admin and Group
    User;
  - other reports (e.g. Organization Report) have **no** page-level role gate
    and rely on their endpoints;
  - this report adds a real gate (D1).

## Decisions

### D1 — Access: Super Admin and Head Office only

| | Super Admin | Head Office | Every other role |
|---|---|---|---|
| Open the page | ✔ | ✔ | redirected (`proxy.ts`) |
| Preview / PDF | the organization it selects (required) | **its own organization only** | 403 |

- **Roles:** `CONSOLIDATED_INVOICE_REPORT_ROLES` in
  `lib/consolidated-invoice-access.ts`, a role allowlist rather than a new
  `Permission` key. A new key only takes effect after `db:seed` rewrites
  `role_permissions` on production; `lib/product-request-access.ts` makes the
  same choice. The sidebar, the hub card and the handlers all read
  `canReadConsolidatedInvoiceReport(role)`.
- **Head Office's organization** comes from `getRequestScope()` (the `users`
  row), never from the request. An `organizationId` it sends is ignored, and a
  Head Office account with no organization is 403.
- **Super Admin's** `organizationId` is required (400 without) and must exist
  (404).
- **`branchIds` (≤ 200) and `groupId`** are verified to belong to that
  organization in one query, or the request is **404 "Branch not found"** /
  **"Group not found"**. A caller cannot confirm another tenant's ids.
- **No price redaction applies:** price hiding covers only Branch Admin and
  Order Portal (`shouldHidePricesForRole`).
- **Navigation:**
  - `proxy.ts` gets a `ROLE_GATED_AREAS` entry
    `{ prefix: "/reports/consolidated-invoices", roles: ["SUPER_ADMIN", "HEAD_OFFICE"], home: "/reports" }`.
    Without it, Branch Admin and Group User would reach the page through the
    `/reports` prefix.
  - Order Portal, Group Order Portal, Viewer, Desk, Executive and Warehouse
    are already confined to their own areas, and their API allowlists refuse
    the new routes.
- **Exposure:** rows carry branch name, cost center, approver name, quantity
  and money. No phone, email, delivery address or line items.

### D2 — Invoice status: derived, defined once, never stored

`lib/invoice-status.ts` (pure), mapping the requester's table:

```
issued = status ∈ {FULFILLED, PARTIAL, PARTIALLY_FULFILLED}
      or fulfillment_status = DELIVERED
      or status_at_refund ∈ {FULFILLED, PARTIAL, PARTIALLY_FULFILLED}

status PENDING or REJECTED            → NOT_ISSUED          "Not issued"
status CANCELLED                      → CANCELLED           "Cancelled"
issued and status REFUNDED            → CREDITED            "Credited"
issued and refund_amount_cents > 0    → PARTIALLY_CREDITED  "Partially credited"
issued                                → ISSUED              "Issued"
not issued and status REFUNDED        → CANCELLED           "Cancelled"
not issued and status APPROVED        → PROFORMA_AVAILABLE  "Proforma available"
```

- **"Cancelled" is added to the requester's table** for an order cancelled,
  or fully refunded, before delivery. A credit can only follow an issued
  invoice; refunding goods never delivered cancels a proforma.
- **Why derived:** about ten code paths move an order (approve, deliver,
  fulfil, auto-fulfil, two refund routes, desk and group cancel, admin
  delete). A stored status would have to be updated by all of them and would
  drift. `lib/delivery-sla.ts` is read-time-only for the same reason.
- **SQL twin:** `invoiceStatusSql` in `lib/server/invoice-status-sql.ts`, a
  `CASE` expression for the report's filter. An integration test drives every
  combination of status × fulfilment status × refund through both and
  requires them to agree, the same discipline as `lib/budget-consumption.ts`
  and its SQL twin.
- **Scope of this change:** the status appears in this report (on-screen
  preview column, and the filter). Showing it on the individual invoice and
  in the Orders directory is follow-up F1, and reuses the same module.

### D3 — Which orders

**"Orders"** selector (single choice):

| Option | Invoice statuses included |
|---|---|
| **Delivered & fulfilled** (default) | Issued, Partially credited |
| **Approved — not yet delivered** | Proforma available |
| **All approved onwards** | both of the above |

- **"Include fully refunded orders"** checkbox, default **off**. When on, it
  adds *Credited* to a delivered selection. Their rows print 0.00 with status
  "Refunded".
- *Not issued* and *Cancelled* orders never appear: they have no invoice.
- Every order must also have an invoice snapshot (`receipt_data IS NOT NULL`)
  and belong to the selected organization (and branch/group filter).

### D4 — Period: month or custom range, on the printed invoice date

- **Month:** a year select plus a month select, sent as `month=YYYY-MM`, from
  the 1st to the last day.
- **Custom range:** two date inputs, sent as `from=YYYY-MM-DD&to=YYYY-MM-DD`.
  Inclusive, `from ≤ to`, at most 366 days, `to` no later than today in
  Karachi.
- The browser sends **date strings, never `Date` objects**, so a user's
  browser time zone cannot shift a boundary. The server resolves them.
- **Match:** `to_date(receipt_data->>'date', 'MM/DD/YYYY')` when the snapshot
  matches `^\d{2}/\d{2}/\d{4}$`. Otherwise it falls back to the Karachi date
  of `created_at`, so an unfamiliar legacy value still lands in a period.
- **Index use, without a migration:** the query also bounds `created_at` to
  the period widened by one day each side. That range scan runs on the
  existing `orders_org_created_idx (organization_id, created_at)`; the exact
  date test runs only on that small window.
- The printed **Invoice Period** is the selected period, e.g.
  `01 Aug 2026 – 31 Aug 2026`.

### D5 — Row figures (integer cents, pure, one module)

`lib/consolidated-invoice.ts` builds every row and total; the preview and the
PDF both read its output, so they cannot disagree. The figures are those of
the order's own invoice **after refunds**:

| Column | Value |
|---|---|
| Invoice No | `receipt_data->>'invoiceNumber'` |
| Invoice Date | `formatInvoiceDisplayDate(receipt_data->>'date')`, the text on the invoice |
| Order ID | `orders.id` |
| Order Status | `getOrderDerivedStatus(order, "fulfilled").label` (Fulfilled, Approved, Partially Refunded, Refunded…) |
| Department | `branches.name` |
| Approver | `getReceiptUserDisplayName(approver)`, the name the invoice prints |
| Designation | blank: no source exists (follow-up F4) |
| CRC | `branches.cost_center_id` |
| Items (Qty) | `Σ order_items.quantity` |
| Value Excl. Sales Tax | `max(0, subtotal_cents − (refund − refundTax))` |
| Sales Tax % | one distinct `tax_rate_bp` → "18%"; several → "Mixed"; none → "—" |
| Sales Tax Amount | `max(0, tax_cents − refundTax)` |
| Total Amount | `max(0, total_cents − refund)`, which is the individual invoice's TOTAL |

Where:

- `refund = refund_amount_cents`;
- `refundTax = min(refund, tax_cents, Σ tax_refund_cents of APPROVED/COMPLETED refunds)`.

Totals row and header cards are column sums **in cents**, formatted only at
the edge. Quantities print without trailing zeros (`169`, `12.5`).

### D6 — Query: one statement, bounded

`lib/server/consolidated-invoice-queries.ts`:

```
orders
  JOIN branches  ON (branches.id, branches.organization_id) = (orders.branch_id, orders.organization_id)
  LEFT JOIN users approver ON approver.id = orders.approved_by_user_id
  + correlated aggregates: Σ order_items.quantity, distinct tax_rate_bp,
    Σ approved refunds.tax_refund_cents
WHERE organization_id = $org
  AND created_at BETWEEN $from − 1 day AND $to + 1 day   -- index range
  AND printed-date ∈ [$from, $to]
  AND invoiceStatusSql ∈ $statuses
  AND receipt_data IS NOT NULL
  [AND branch_id = ANY($branchIds)] [AND branches.group_id = $groupId]
ORDER BY <allowlisted sort>, orders.id
LIMIT 1001
```

- **Selected columns:** only `receipt_data->>'invoiceNumber'` and
  `->>'date'`, never the whole jsonb.
- **No N+1:** approver names are joined, not loaded per row.
- **1 000-order cap:** above it the API answers **422** "This selection has
  more than 1,000 invoices — narrow the period or branches", with the count.
  Unbounded output is both a denial-of-service and an exfiltration path.
- **Sorting (complies with the table-sort rule):**
  - the preview's headers sort through `SortableHeader` / `useTableSort`;
  - the request carries `sort=&dir=`, admitted only from
    `CONSOLIDATED_INVOICE_SORT_KEYS` in `lib/list-sort-keys.ts` (400
    otherwise), mapped through a `Record<Key, SQL>` and `orderBySortSql`;
  - the **PDF uses the same sort**, so the download is the preview;
  - default order is invoice date, then invoice number;
  - S.No is renumbered in the chosen order;
  - the page and the route go on `table-sort-contract.test.ts`.

### D7 — Screen: Reports → Consolidated Invoice Report

**Placement:**

- Super Admin's and Head Office's **Reports** submenu in
  `components/shell/sidebar.tsx`: "Consolidated Invoice Report".
- A card on the Reports hub, held in its own `consolidatedInvoiceReportCards`
  array, shown to those two roles only.

**Page:** `app/(portal)/reports/consolidated-invoices/page.tsx`, built from
`components/reports/consolidated-invoice/*`:

1. **Filter bar:**
   - organization: Super Admin only, taken from the context selector; without
     one, the page asks to pick one;
   - **Period:** Month | Custom range;
   - Branches (`BranchFilter`) / Group (`GroupFilter`);
   - **Orders:** Delivered & fulfilled | Approved — not yet delivered | All;
   - **Include fully refunded.**
   - The selected filters live in the URL query string, so a report can be
     bookmarked or shared with a colleague of the same organization.
2. **Preview** (`ConsolidatedInvoiceDocument`): an HTML rendering of the
   template.
   - Masthead; the four header cards (Bill To + NTN, Invoice Period, Total
     Orders + Total Items, Grand Total with excl. + tax).
   - The two-band header: gold "Apricart Details" over Invoice No and Invoice
     Date, navy "<Organization> Details" over the rest.
   - Zebra rows, the Total row, and sortable column headers.
   - On screen only, a small **invoice-status** badge per row (D2), and each
     Invoice No links to the individual invoice (`/invoices/[orderId]`).
3. **Download PDF:** disabled while in flight and while the preview is empty
   or loading. It requests the same query string.

**States:** loading skeleton; empty ("No invoices match these filters"); 422
(the narrowing message); error (the safe message from the API, never a raw
error).

### D8 — PDF: server-built, matching the template

`lib/server/consolidated-invoice-pdf.ts`, jsPDF + jspdf-autotable on the
server, **A4 landscape**:

- **Masthead:**
  - the logo (`public/apricart-logo-blue.png`, loader extracted from
    `invoice-pdf.ts` into a shared helper so both invoices use one);
  - `INVOICE_ISSUER` name, address on one line, NTN/STRN;
  - "CONSOLIDATED INVOICE" at the right.
- **Header cards** as in the template.
- **Table:** an autotable with a two-row head (bands with `colSpan`, then the
  column titles in navy), right-aligned figures, wrapped
  Department/Approver/CRC cells, and the bold **Total** row as a foot.
  - `showHead: "everyPage"`: the column header repeats on every page;
  - `showFoot: "lastPage"`: the totals are printed once, at the end.
- **Footer on every page** (the only additions to the template):
  - **"Page x of y"**;
  - "Generated on <Karachi date-time>";
  - one line: *"Summary of the invoices listed. Sales tax is charged on each
    listed invoice; this is not a separate tax invoice."*

  The template's title is kept as requested. A document titled "invoice" with
  no number of its own must say what it is, or it can be booked as a second
  tax invoice and the tax counted twice.
- **File name:** `consolidated-invoice-<ORGCODE>-<from>_<to>.pdf` through
  `safeFilenamePart`.
- Building it on the server means the authorization, the query and the
  document come from one place. It does not depend on the browser, and the
  download can be audited (D10).

### D9 — API

| Method | Path | Roles | Rate limit |
|---|---|---|---|
| GET | `/api/v1/reports/consolidated-invoice` | SA, HO | `search` |
| GET | `/api/v1/reports/consolidated-invoice/pdf` | SA, HO | `report` (10 per 10 min, fail-closed) |

**Shared query parameters, Zod `.strict()`** (unknown keys → 400):

| Parameter | Values |
|---|---|
| `organizationId` | Super Admin only; ignored for Head Office |
| `mode` | `month` \| `range` |
| `month` / `from` + `to` | as in D4 |
| `branchIds` | comma list, ≤ 200 |
| `groupId` | optional |
| `orders` | `delivered` \| `approved` \| `all` |
| `includeCredited` | `true` \| `false` |
| `sort`, `dir` | allowlisted |

**Handler order (rule 05):** rate limit → session (401) → role (403) → scope
from the database → validate (400) → fence filters (404) → query → cap
(422) → respond.

**JSON response:** `{ billTo: { name, ntn, code }, period: { from, to, label },
rows[], totals, count }`. Money is in cents; the client formats it.

Both responses carry `Cache-Control: no-store`. There is no request body, so
the WAF's 8 KB limit is not a concern.

### D10 — Audit

Each **PDF download** writes one `audit_logs` row in the handler:

- action `DOWNLOAD_CONSOLIDATED_INVOICE_REPORT`;
- organization, actor, role, filters, order count, grand total in cents;
- a SHA-256 digest of the ordered `(orderId, invoiceNumber, totalCents)`
  list.

A document handed to a client can then be traced to who produced it and
verified later. No names or line items go in the audit row. Previews are
reads and are not audited, as with every other report.

## Modules

| File | Layer | Contents |
|---|---|---|
| `lib/invoice-status.ts` (+ test) | pure | D2 |
| `lib/server/invoice-status-sql.ts` | server | SQL twin of D2 |
| `lib/consolidated-invoice-access.ts` (+ test) | pure | D1 roles |
| `lib/consolidated-invoice.ts` (+ test) | pure | Zod schema, period resolution (D4), row and total arithmetic (D5), tax-rate label, digest, file name, limits |
| `lib/list-sort-keys.ts` *(edit)* | pure | `CONSOLIDATED_INVOICE_SORT_KEYS` |
| `lib/server/consolidated-invoice-scope.ts` | server | caller → organization; branch/group fence |
| `lib/server/consolidated-invoice-queries.ts` | server | D6 |
| `lib/server/consolidated-invoice-pdf.ts` (+ test) | server | D8 |
| `lib/server/pdf-logo.ts` | server | logo loader shared with `invoice-pdf.ts` |
| `app/api/v1/reports/consolidated-invoice/route.ts`, `.../pdf/route.ts` | routes | thin handlers (D9) |
| `app/(portal)/reports/consolidated-invoices/page.tsx` | UI | host page |
| `components/reports/consolidated-invoice/{filters,period-picker,document}.tsx` | UI | D7 |
| `components/shell/sidebar.tsx`, `app/(portal)/reports/page.tsx`, `proxy.ts` *(edits)* | UI / edge | placement and gate |
| `CLAUDE.md` *(edit)* | docs | one paragraph under Important Patterns |

**No schema change, no migration, no new dependency.**

### Build order

1. `lib/invoice-status.ts`, its SQL twin, and their tests.
2. The pure report module (`lib/consolidated-invoice.ts`), its access module
   and unit tests.
3. Scope, query, JSON route, and integration tests.
4. The PDF renderer and its route, with the audit row.
5. The page, filters and preview; sidebar, hub card, proxy gate; contract
   lists; `CLAUDE.md`.

## Tests

**Unit:**

- `deriveInvoiceStatus`: every row of D2, including partial refund on an
  undelivered order, full refund before delivery, cancelled after approval,
  and returned for correction.
- **Periods:** a leap February, December → January, 0/366/367-day ranges,
  `from > to`, a future `to`, a malformed month, unknown parameters.
- **Rows:** no refund; partial refund; full refund; a tax refund larger than
  the tax; mixed and absent tax rates; totals equal the column sums;
  quantity formatting.
- Digest stability; file-name sanitising; role allowlist.
- **PDF:** renders one page and many pages; "Page x of y" is present; the
  header repeats; totals appear once; the text includes every invoice number
  (asserted on the extracted text, as `invoice-pdf.test.ts` does).

**Contract:**

- Both routes on `lib/server/security-boundaries.test.ts`; each handler
  checks the allowlist itself and reads the organization through
  `getRequestScope`.
- The page and route on `table-sort-contract.test.ts`.
- The sidebar entry and hub card for Super Admin and Head Office only.
- The proxy gate is present.

**Integration** (`tests/integration/consolidated-invoice-report-api.test.ts`,
`tests/integration/invoice-status-sql.test.ts`):

- **Roles:** 401 unauthenticated; 403 for Branch Admin, Group User, Order
  Portal, Group Order Portal, Viewer, Order Desk, Apricart Executive and
  Warehouse; 200 for Super Admin and Head Office, on both routes.
- **Tenant isolation:**
  - Head Office of A sending `organizationId=B` still gets A;
  - B's branch or group in a filter → 404;
  - Super Admin without `organizationId` → 400;
  - no row from another organization ever appears (two-tenant fixture).
- **Selection:**
  - each `orders` option returns exactly the right statuses;
  - `includeCredited` toggles fully refunded rows;
  - pending, rejected and cancelled orders never appear.
- **Date boundary:** an order created 2026-08-31 20:00 UTC with snapshot
  `08/31/2026` is in August and not September; a legacy snapshot with an
  unparseable date falls back to its Karachi creation date.
- **Row parity:** each row's Items and Total equal what
  `GET /api/v1/receipts/[id]` reports for that order.
- **Refund netting** against real `refunds` rows.
- **Bounds:** > 1 000 orders → 422.
- **Sorting:** an unknown sort key → 400; the PDF order equals the JSON
  order.
- **Audit:** a PDF download writes the audit row with the right digest.
- `invoiceStatusSql` ≡ `deriveInvoiceStatus` over every combination.
- The warehouse isolation and write sweeps cover the new GET handlers
  automatically and must stay green.

**E2E:** Head Office opens Reports → Consolidated Invoice Report, picks a
month, sees the preview, downloads the PDF. A Branch Admin typing the URL is
sent back to `/reports`.

## Security impact

- **Authentication:** session on both routes; the forced password-change gate
  in `proxy.ts` applies unchanged.
- **Authorization:** two-role allowlist in each handler, plus the proxy gate
  for navigation only.
- **Tenant isolation:**
  - Head Office's organization comes from the `users` row;
  - Super Admin's is the only request-supplied tenant, and only for that
    role;
  - filters are fenced (404);
  - the branch join uses the tenant composite key;
  - the integration suite holds a two-tenant fixture.
- **Input:** Zod strict, enum allowlists, date strings parsed and bound as
  parameters, sort through an allowlist, no `sql.raw`.
- **Abuse:** ≤ 1 000 rows, ≤ 366 days, ≤ 200 branch ids, rate limits,
  `no-store`.
- **Exposure:** branch, cost center, approver name and figures only.
- **Audit:** every download is recorded with a verifiable digest.

## Database impact

None. No migration, no index, no backfill. Reads use `orders_org_created_idx`.

Before release, run `EXPLAIN ANALYZE` read-only (`begin read only`, never a
session `SET` on the pooler) for a 12-month, whole-organization query on
K-Electric, the largest tenant.

## Rollout

1. Read-only production checks:
   - no duplicate invoice numbers per organization;
   - the distribution of `receipt_data->>'date'` formats per organization (to
     size the D4 fallback);
   - every organization has an NTN where the Bill To should print one.
2. Deploy. Read-only feature, no flag: the sidebar entry, hub card and page
   are the only visible change.
3. **Rollback:** revert the commit. Nothing is written except audit rows.

## Risk

| Risk | Mitigation |
|---|---|
| A row from another tenant | Organization from the database; fenced filters; two-tenant integration fixture |
| A row disagreeing with its own invoice | Row-parity test; shared formatters (`formatInvoiceDisplayDate`, `getReceiptUserDisplayName`, `getOrderDerivedStatus`) |
| A slow query on a large tenant | Index range on `(organization_id, created_at)`; 1 000-row cap; `EXPLAIN` before release |
| The document mistaken for a second tax invoice | Footer statement (D8) |

## Follow-ups (not in this change)

- **F1 — Invoice status everywhere:** the same `lib/invoice-status.ts` on the
  individual invoice (status field, "PROFORMA INVOICE" title while proforma)
  and as a column and filter in the Orders directory.
- **F2 — Numbered, saved consolidated invoices** (issue, credit lines, payment,
  void), if the business later uses them for billing rather than reporting.
  The 2026-10-09 design in outline:
  - a `<ORGCODE>-CIN-000001` series with its own counter;
  - issue, void and payment by Super Admin only;
  - a `consolidated_invoice_lines` ledger with `UNIQUE (order_id)` on live
    charges, so each order is billed once;
  - credit lines for refunds after billing;
  - immutable snapshots for reprints.

  It would build on this report's query and row module unchanged.
- **F3 — Tax invoice at the time of supply:** today the individual invoice
  number and date are fixed at order creation, so rejected orders leave gaps
  and the date can precede delivery. Confirm with the company's tax adviser.
- **F4 — Designation:** an additive `users.designation` column, if the
  customer wants that column filled.
- **F5 — Excel export** of the same rows, if Finance asks for it. It reuses
  the JSON route and `sanitizeSpreadsheetRow`.
