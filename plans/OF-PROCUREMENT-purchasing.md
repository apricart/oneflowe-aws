# OF-PROCUREMENT — Purchasing into Apricart warehouses

Builds on `plans/OF-STOCK-per-warehouse-stock.md`: a purchase names one
receiving warehouse, and goods received against it raise that warehouse's
on-hand figure only.

## Decided by the business (2026-10-28)

1. Procurement is Apricart's internal team only — a platform role with no
   organization, like Finance and Warehouse.
2. Only Super Admin approves purchase orders.
3. Procurement and Super Admin enter and see purchase prices; Finance sees them
   read-only (and matches supplier invoices); the warehouse never sees cost.
4. The same person may approve and receive a purchase order if their role allows
   both (Super Admin does). Separation of duties is a set of capabilities
   (`lib/procurement-access.ts`), not one role per user.
5. Over-delivery is allowed up to **20%** of an ordered line, and Super Admin can
   change the percentage.
6. Customer returns are recorded by the warehouse and approved by the
   warehouse's executives (Apricart Executive members of that warehouse) or
   Super Admin.

## Flow

```
Warehouse raises a requisition ─► Procurement converts it into a PO
                                  (supplier, ONE receiving warehouse, unit costs)
PO: DRAFT ─submit─► PENDING_APPROVAL ─Super Admin approve─► APPROVED
                         │ withdraw ▲          └─ reject ─► REJECTED
APPROVED ─receipt─► PARTIALLY_RECEIVED ─receipt─► RECEIVED
PARTIALLY_RECEIVED ─short-close─► CLOSED
DRAFT / PENDING_APPROVAL / APPROVED (nothing received) ─cancel─► CANCELLED
Supplier invoice against the PO ─► three-way match ─► Finance approves ─► paid
```

* **Goods receipt (GRN)** — the warehouse working the PO's receiving warehouse
  (an active `WAREHOUSE_OPERATOR` member) or Super Admin records what arrived,
  line by line. A line may be received in parts; the running total per line may
  not exceed `ordered × (1 + tolerance)`. The tolerance is snapshot onto the PO
  when it is approved, so changing the setting never changes an approved PO.
  Each receipt raises the warehouse's on-hand figure with a `PURCHASE_RECEIPT`
  stock movement in the same transaction. Receipts are append-only.
* **Three-way match** — a supplier invoice names PO lines, quantities and unit
  costs. A line matches when the quantity invoiced so far (every invoice not
  rejected) is within what was received, and the unit cost equals the PO's.
  Finance or Super Admin approves a matched invoice; an exception is approved by
  Super Admin only, with a reason. Finance or Super Admin then marks it paid.
* **Shortages** — per warehouse and product: on hand, reserved by open orders,
  on order (approved PO quantity not yet received), and the shortfall still
  uncovered. Read-only; nothing is ordered automatically.
* **Customer returns** — the warehouse records goods coming back (optionally
  naming the order), each line Resaleable or Damaged. On approval, resaleable
  quantities go back on that warehouse's shelf (`CUSTOMER_RETURN` movement);
  damaged ones are recorded only. A return moves stock only — refunds and credit
  notes stay with the existing refund flow.

## Stock ledger switch

Receipts and approved returns write `warehouse_stock`, which orders read only in
`STOCK_LEDGER_MODE = "warehouse"`. While the mode is `"global"` both are
refused with 409 (`STOCK_LEDGER_GLOBAL`) so a receipt can never land in a figure
no order reads, nor be double-counted by the opening script. Suppliers,
requisitions, POs, approvals and invoices work in either mode.

## Roles and reach

| Capability | Roles |
|---|---|
| Read POs, costs, invoices | SUPER_ADMIN, PROCUREMENT, FINANCE |
| Manage suppliers; create, edit, submit, cancel, close POs | SUPER_ADMIN, PROCUREMENT |
| Approve / reject a PO | SUPER_ADMIN |
| Raise a requisition | WAREHOUSE (its warehouses), PROCUREMENT, SUPER_ADMIN |
| Reject a requisition | PROCUREMENT, SUPER_ADMIN |
| Record a goods receipt | WAREHOUSE (PO's warehouse), SUPER_ADMIN |
| Record a supplier invoice | PROCUREMENT, FINANCE, SUPER_ADMIN |
| Approve a matched invoice / mark paid / reject | FINANCE, SUPER_ADMIN |
| Approve an exception invoice | SUPER_ADMIN |
| Record a customer return | WAREHOUSE (its warehouses), SUPER_ADMIN |
| Approve / reject a customer return | APRICART_EXECUTIVE (member of that warehouse), SUPER_ADMIN |
| Change the over-delivery tolerance | SUPER_ADMIN |

`PROCUREMENT` has no organization or branch, is created by Super Admin only
(`ROLE_LEVEL` 7), cannot be switched into or out of, and is confined by
`proxy.ts` to `/procurement` and `PROCUREMENT_API_RULES`. The warehouse uses its
own routes under `/api/v1/warehouse/procurement/*`, which select no cost
column; the executive uses `/api/v1/executive/returns*`. Finance's allowlist
gains the procurement reads and invoice actions.

A warehouse account's warehouses are its active `WAREHOUSE_OPERATOR`
memberships (`apricart_warehouse_memberships`); an executive's are its
`EXECUTIVE` memberships. Anything outside them is 404.

## Schema (migration `20261106120000`, additive)

* `roles` row `PROCUREMENT` (needed to create the account).
* `procurement_settings` (single row, id 1; absent = 20%).
* `procurement_suppliers`.
* `purchase_requisitions`, `purchase_requisition_lines`.
* `purchase_orders`, `purchase_order_lines` (`received_quantity` kept by the
  receipts under the PO's row lock).
* `goods_receipts`, `goods_receipt_lines` (append-only by trigger).
* `supplier_invoices`, `supplier_invoice_lines`.
* `customer_returns`, `customer_return_lines`.
* `stock_movements`: new types `PURCHASE_RECEIPT`, `CUSTOMER_RETURN` with
  `goods_receipt_id` / `customer_return_id`, one movement per document and
  product.

No existing table's rows change. The legacy org-scoped `suppliers` and
`restock_requests` tables (0 rows in production) are left alone.

## Audit

`CREATE_/UPDATE_PROCUREMENT_SUPPLIER`, `CREATE_/DECIDE_PURCHASE_REQUISITION`,
`CREATE_/UPDATE_/SUBMIT_/WITHDRAW_/APPROVE_/REJECT_/CANCEL_/CLOSE_PURCHASE_ORDER`,
`RECORD_GOODS_RECEIPT`, `RECORD_/APPROVE_/REJECT_/PAY_SUPPLIER_INVOICE`,
`RECORD_/APPROVE_/REJECT_CUSTOMER_RETURN`, `UPDATE_PROCUREMENT_SETTINGS`.
Every write is one transaction with its audit row.

## Rollout

1. Deploy. Nothing changes for any existing user.
2. Apply `20261106120000` (`npm run db:migrate:prod`, dry run then confirm).
3. Super Admin creates Procurement accounts (Users → Create → Procurement).
4. Receipts and returns start working once the stock switch is moved to
   `"warehouse"` (see the stock plan).

## Known limits

* No notifications yet; each queue is read on its page.
* One currency (PKR); tax per PO line as a rate.
* Returns to suppliers (debit notes) are not built.

## Tests

* `lib/procurement.test.ts` — transitions, totals, tolerance, match, returns.
* `lib/procurement-access.test.ts` — capability matrix, proxy allowlists, every
  listed handler checks the role, account shape.
* `tests/integration/procurement.test.ts` — end to end: requisition → PO →
  approval → partial and over receipts against the tolerance → stock →
  invoice match → approval → return; the role matrix; warehouse never sees cost;
  warehouse confined to its warehouse; concurrent receipts; global-mode refusal.
