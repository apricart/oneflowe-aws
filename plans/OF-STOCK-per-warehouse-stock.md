# OF-STOCK — Stock per Apricart warehouse

## Goal

Count stock separately at each Apricart warehouse instead of in one global
figure, so procurement (`OF-PROCUREMENT`, next) can receive goods into the
warehouse a purchase order names, and so the warehouse that actually fulfils an
order is the one whose stock goes down — including after Super Admin transfers
the order to another warehouse.

Decided by the business, 2026-10-28:

1. Separate stock for each warehouse; never a global figure.
2. Today's (dummy) global quantities go into both KARACHI-001 and LAHORE-001 so
   customers keep ordering; Super Admin can change any figure later.
3. A branch with no warehouse is **not** refused an order; Super Admin assigns
   a warehouse later.
4. A transfer to a warehouse short of stock is **allowed with a warning**.

## Findings (production, read-only, 2026-10-28)

* 114 migrations applied, the same as `drizzle/meta/_journal.json`.
* Warehouses: KARACHI-001 and LAHORE-001, one active operator each; 55 route
  rules, no manual routes.
* 911 active branches: 213 resolve to KARACHI-001, 204 to LAHORE-001, **494 to
  no warehouse**. Rule 3 is therefore load-bearing, not an edge case.
* 21 open orders not yet In Process (pending, or approved and not started),
  5 of them at branches with no warehouse; 0 transferred orders.
* 215 products, 138 active, 25 at zero; no product sold in fractions; largest
  figure 10,001.
* No open order has an approved refund.

Before this change stock is `global_products.stock_quantity`: **taken when an
order is created** (four paths) and given back when it is rejected, cancelled or
deleted (four paths). Nothing logs a movement. Fulfilment never touches it.

## Design

### Two numbers per warehouse

* **On hand** — `warehouse_stock.on_hand_quantity`, per (warehouse, product).
  Changed only by an opening, Super Admin's adjustment, and an order being
  marked In Process, each with an append-only `stock_movements` row.
* **Reserved** — never stored. The sum of the lines of every *open* order
  (pending, or approved and Not Started) whose warehouse is that warehouse
  **now**: `COALESCE(orders.fulfillment_warehouse_id, branchWarehouseSql())`.
* **Available = on hand − reserved.** What a customer may order.

Reserved is computed, not counted, because an order's warehouse is decided live
(plans/OF-WAREHOUSE-order-ownership-and-transfer.md: routes and rules are
evaluated at read time and orders are never stamped). A stored counter would
have to be corrected by every transfer, route, rule and city change — eight
paths write branches — and would drift. Computed, a transfer or a route change
moves the reservation with the order and nothing needs correcting.

### The order's life

| Event | Stock |
|---|---|
| Created (shop, group portal, Order Desk) | Checked against the branch's warehouse and reserved by existing. Refused "Insufficient stock …" exactly as before. |
| Edited (pending) | Checked again; what the order already reserves counts as available to it. |
| Rejected / cancelled / deleted | Nothing to give back — nothing was taken. |
| Transferred | Reservation moves with it. A target short of stock is a warning Super Admin confirms; the shortfall is kept in the audit row. |
| **Marked In Process** | **Goods leave the shelf** of the warehouse working the order at that moment, in the transaction that issues the tax invoice. A short shelf refuses the step (409) and rolls it back. Once per order (`stock_movements_order_issue_uq`). |

Issuing at In Process, not at creation, is what lets a transferred order take
its goods from the warehouse that really packs them. After In Process an order
cannot be cancelled (it holds its tax invoice), so an issue never has to be
reversed by a cancel.

### A branch with no warehouse

Its order is checked against **every active warehouse together**: all their on
hand, less every open order's lines anywhere. It is accepted, and its
reservation lands on a warehouse the moment Super Admin routes the branch or
transfers the order. It cannot be marked In Process until then (409, "assign a
warehouse first") — there is no shelf to take the goods from.

### Concurrency

Each check, issue and adjustment takes the `warehouse_stock` rows it reads
`FOR UPDATE`, ordered by (warehouse, product); order creation has already
locked the product rows. Two orders for the last units therefore serialize, and
the second sees the first's committed lines. (Integration test: two concurrent
orders for the last ten — exactly one succeeds.)

### The switch

`STOCK_LEDGER_MODE` in `lib/stock-ledger-policy.ts`, a code constant like
`WAREHOUSE_ORDER_OWNERSHIP`. **Ships `"global"`: every path runs exactly the
code it ran before**, and nothing reads the new tables. `"warehouse"` turns all
of the above on at once. Every order path asks `usesWarehouseStock()`;
`lib/server/warehouse-stock-contract.test.ts` lists every path and fails if one
is added without the switch.

### Readers

* Customer-facing figures — the shop listing (`/api/v1/branch/inventory`), the
  Order Desk picker — show the branch's own available figure; the group
  storefront shows the least any selected branch can order (each branch orders
  against its own warehouse). Read fresh, never from the listing cache.
* Display-only lists — Super Admin's product list, the warehouse's catalogue,
  catalogue analytics, the branch export — show total on hand across active
  warehouses (`productStockDisplaySql`).
* Super Admin's product form hides the global stock field and points at
  Warehouse Stock.

### Warehouse Stock page

`/warehouse-stock`, Super Admin only (`lib/warehouse-stock-access.ts`; proxy,
layout and every endpoint check). Per warehouse: on hand, reserved, available,
search and paging; **change a figure** — set to a counted number, add, or
remove, with a reason (`POST /api/v1/admin/warehouse-stock/adjustments`, audited
`ADJUST_WAREHOUSE_STOCK`, never below zero); and each product's movement
history. Endpoints answer 503 with a clear message until the migration is
applied.

### Opening figures

`npm run open:warehouse-stock -- --warehouses=KARACHI-001,LAHORE-001`: dry run,
digest-gated commit, rollback. Each named warehouse opens, per product, at
**today's global figure plus what open orders hold of it**. The global figure is
already net of those orders and they are reserved again under the new count, so
each warehouse's *available* figure opens at exactly today's, and every open
order can be packed at whichever warehouse fulfils it. (This doubles total
sellable stock, as decided — the figures are dummy; replace them with real
counts on Warehouse Stock.) A pair that already has a row is never touched.
Rollback removes exactly its rows, only if none has moved since.

## Schema (migration `20261105120000`, additive)

* `warehouse_stock (id, warehouse_id → apricart_warehouses, global_product_id →
  global_products, on_hand_quantity numeric(12,3) ≥ 0, updated_by_user_id,
  timestamps)`, unique (warehouse, product).
* `stock_movements (id, warehouse_id, global_product_id, movement_type ∈
  OPENING|ADJUSTMENT|ORDER_ISSUE, quantity_delta ≠ 0, balance_after ≥ 0,
  order_id (iff ORDER_ISSUE; no FK), reason, batch_id, actor_user_id (no FK),
  actor_role, created_at)`; trigger refuses UPDATE always and DELETE except the
  opening script's own rollback batch and test cleanup in a `%test%` database.

No existing table, column or row changes.

## Rollout

1. Deploy this code (mode `"global"`): nothing changes for anyone. The
   Warehouse Stock page answers "apply migration first" until step 2.
2. Apply `20261105120000` to production (`npm run db:migrate:prod`, dry run then
   `--confirm=<digest>`).
3. `npm run open:warehouse-stock -- --warehouses=KARACHI-001,LAHORE-001` (dry
   run), then commit with the printed digest. Review the figures on Warehouse
   Stock.
4. Move `STOCK_LEDGER_MODE` to `"warehouse"` (and its test line) and deploy.
5. Rollback: redeploy `"global"`. The global figure was frozen while the mode
   was `"warehouse"`, so set it again before relying on it.

## Known limits

* An approved partial refund before In Process does not reduce the reservation
  or the quantity issued (production has none today).
* A refund never returns stock (unchanged); customer returns are a later phase.
* The K-Electric sync's `--stock` still writes the global figure, which is not
  read in `"warehouse"` mode.

## Tests

* `lib/warehouse-stock.test.ts` — availability, the two-customer case, issue,
  adjustment, opening plan.
* `lib/server/warehouse-stock-contract.test.ts` — every stock writer is behind
  the switch; every order-line writer checks a warehouse; issue happens only at
  In Process; only `lib/server/warehouse-stock.ts` writes `warehouse_stock`.
* `lib/stock-ledger-policy.test.ts` — the shipped value is `"global"`.
* `tests/integration/warehouse-stock.test.ts` (mode mocked to `"warehouse"`) —
  the race, transfers, unassigned branches, issue/refusals, adjustments with
  the role matrix, the transfer warning, append-only movements. Every other
  integration suite runs with the shipped `"global"` switch.
