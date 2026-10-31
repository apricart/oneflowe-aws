/**
 * Where an order's stock is counted. See plans/OF-STOCK-per-warehouse-stock.md.
 *
 *   - "global" — one figure per product, `global_products.stock_quantity`,
 *     taken when an order is created and given back when it is rejected,
 *     cancelled or deleted. What production ran before this change, and still
 *     runs.
 *   - "warehouse" — a figure per Apricart warehouse (`warehouse_stock`). An
 *     order reserves at its branch's warehouse when it is created (at every
 *     active warehouse together while its branch has none), and the goods leave
 *     that warehouse's stock when the order is marked In Process. Nothing is
 *     given back on a rejection, because nothing was taken.
 *
 * A code constant, deliberately not an environment variable (like
 * `WAREHOUSE_ORDER_OWNERSHIP`): moving it is a reviewed deploy, taken only after
 * migration `20261105120000` is applied and `npm run open:warehouse-stock` has
 * committed the opening figures, and undone by redeploying the previous value.
 */

export const STOCK_LEDGER_MODES = ["global", "warehouse"] as const
export type StockLedgerMode = (typeof STOCK_LEDGER_MODES)[number]

export const STOCK_LEDGER_MODE: StockLedgerMode = "global"

/** Whether stock is counted per warehouse rather than in the global figure. */
export function usesWarehouseStock(mode: StockLedgerMode = STOCK_LEDGER_MODE): boolean {
  return mode === "warehouse"
}
