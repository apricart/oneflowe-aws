import { formatQuantity, roundQuantity } from "@/lib/quantity"

/**
 * The rules of per-warehouse stock, with no database.
 * See plans/OF-STOCK-per-warehouse-stock.md.
 *
 * Each Apricart warehouse holds an **on hand** figure per product
 * (`warehouse_stock`). What an open order has promised is **reserved**, and is
 * never stored: it is the sum of the lines of every order that is pending, or
 * approved and not yet In Process, whose warehouse is that warehouse *now* —
 * the transfer's warehouse, else the branch's (`branchWarehouseSql`). So a
 * transfer, a route, a rule or a branch's new city moves the reservation with
 * the order, and nothing has to be put right afterwards.
 *
 *   available = on hand − reserved
 *
 * An order whose branch is in no warehouse yet is checked against every active
 * warehouse together: all their stock, less every open order's lines.
 */

export const STOCK_MOVEMENT_TYPES = ["OPENING", "ADJUSTMENT", "ORDER_ISSUE"] as const
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number]

export const STOCK_ADJUSTMENT_MODES = ["set", "add", "remove"] as const
export type StockAdjustmentMode = (typeof STOCK_ADJUSTMENT_MODES)[number]

/** The largest on-hand figure the column holds (`numeric(12,3)`). */
export const MAX_STOCK_QUANTITY = 999_999_999
export const STOCK_ADJUSTMENT_REASON_MAX_LENGTH = 500

export type StockLine = { globalProductId: number; quantity: number; productName: string }

export type StockShortfall = {
  globalProductId: number
  productName: string
  requested: number
  available: number
}

/** One quantity per product: an order may carry a product on more than one line. */
export function quantitiesByProduct(lines: readonly StockLine[]): Map<number, { quantity: number; productName: string }> {
  const byProduct = new Map<number, { quantity: number; productName: string }>()
  for (const line of lines) {
    const previous = byProduct.get(line.globalProductId)
    byProduct.set(line.globalProductId, {
      quantity: roundQuantity((previous?.quantity ?? 0) + Number(line.quantity)),
      productName: previous?.productName ?? line.productName,
    })
  }
  return byProduct
}

export function availableQuantity(onHand: number, reserved: number): number {
  return roundQuantity(Number(onHand) - Number(reserved))
}

/**
 * Every product the lines ask for more of than is available, in line order.
 * `onHand` and `reserved` are per product; a product missing from `onHand` has
 * none. `reserved` must leave out the order being checked (an edit).
 */
export function planStockShortfalls(
  lines: readonly StockLine[],
  onHand: ReadonlyMap<number, number>,
  reserved: ReadonlyMap<number, number>,
): StockShortfall[] {
  const shortfalls: StockShortfall[] = []
  for (const [globalProductId, line] of quantitiesByProduct(lines)) {
    const available = availableQuantity(onHand.get(globalProductId) ?? 0, reserved.get(globalProductId) ?? 0)
    if (line.quantity > available) {
      shortfalls.push({ globalProductId, productName: line.productName, requested: line.quantity, available: Math.max(0, available) })
    }
  }
  return shortfalls
}

/**
 * The customer-facing refusal, worded exactly as the global check words it, so
 * every caller that already recognises "Insufficient stock" answers it the same
 * way it always has.
 */
export function stockShortfallMessage(shortfall: StockShortfall): string {
  return `Insufficient stock for ${shortfall.productName}. Available: ${formatQuantity(shortfall.available)}, Requested: ${formatQuantity(shortfall.requested)}`
}

export const NO_STOCK_WAREHOUSE_MESSAGE =
  "This order's branch is not assigned to a warehouse yet. Assign the branch to a warehouse on Warehouse Team, or transfer the order to one, before marking it In Process."

/** Why an order could not be marked In Process: its warehouse is short of these products. */
export function stockShortageMessage(shortfalls: readonly StockShortfall[]): string {
  return `The warehouse does not have enough stock to process this order: ${listShortfalls(shortfalls, "on hand")}. Add stock on Warehouse Stock, or transfer the order to another warehouse.`
}

function listShortfalls(shortfalls: readonly StockShortfall[], label: string): string {
  const listed = shortfalls
    .slice(0, 5)
    .map((shortfall) => `${shortfall.productName} (${label} ${formatQuantity(shortfall.available)}, needed ${formatQuantity(shortfall.requested)})`)
    .join("; ")
  return shortfalls.length > 5 ? `${listed}; and ${shortfalls.length - 5} more` : listed
}

/** The transfer warning: the target is short, and the move is still allowed once confirmed. */
export function transferStockShortfallMessage(shortfalls: readonly StockShortfall[]): string {
  return `That warehouse does not have enough stock for this order: ${listShortfalls(shortfalls, "available")}. Confirm the transfer to move it anyway.`
}

/**
 * What issuing an order takes from its warehouse: every product's whole
 * quantity, refused for each product the shelf does not hold. Reservations of
 * other orders do not refuse it — the goods are there, and this order is the
 * one being packed.
 */
export function planOrderIssue(
  lines: readonly StockLine[],
  onHand: ReadonlyMap<number, number>,
): { ok: true; moves: Array<{ globalProductId: number; quantity: number; balanceAfter: number }> } | { ok: false; shortfalls: StockShortfall[] } {
  const moves: Array<{ globalProductId: number; quantity: number; balanceAfter: number }> = []
  const shortfalls: StockShortfall[] = []
  for (const [globalProductId, line] of quantitiesByProduct(lines)) {
    const shelf = Number(onHand.get(globalProductId) ?? 0)
    if (line.quantity > shelf) {
      shortfalls.push({ globalProductId, productName: line.productName, requested: line.quantity, available: shelf })
      continue
    }
    moves.push({ globalProductId, quantity: line.quantity, balanceAfter: roundQuantity(shelf - line.quantity) })
  }
  return shortfalls.length > 0 ? { ok: false, shortfalls } : { ok: true, moves }
}

export type StockAdjustmentPlan =
  | { ok: true; delta: number; onHandAfter: number }
  | { ok: false; error: string }

/**
 * Super Admin's change to one warehouse's figure: set it to a counted number,
 * or add or remove a quantity. Never below zero, never past the column, and a
 * quantity that is not a whole number only for a product sold in fractions.
 */
export function planStockAdjustment(input: {
  mode: StockAdjustmentMode
  quantity: number
  onHand: number
  allowDecimalQuantity: boolean
}): StockAdjustmentPlan {
  const quantity = Number(input.quantity)
  if (!Number.isFinite(quantity) || quantity < 0) return { ok: false, error: "Quantity must be zero or more" }
  if (roundQuantity(quantity) !== quantity) return { ok: false, error: "Quantity may have at most three decimal places" }
  if (!input.allowDecimalQuantity && !Number.isInteger(quantity)) {
    return { ok: false, error: "This product is counted in whole units" }
  }
  if (input.mode !== "set" && quantity === 0) return { ok: false, error: "Enter a quantity greater than zero" }

  const onHand = Number(input.onHand)
  const onHandAfter = input.mode === "set"
    ? quantity
    : roundQuantity(input.mode === "add" ? onHand + quantity : onHand - quantity)
  if (onHandAfter < 0) {
    return { ok: false, error: `Only ${formatQuantity(onHand)} on hand; cannot remove ${formatQuantity(quantity)}` }
  }
  if (onHandAfter > MAX_STOCK_QUANTITY) return { ok: false, error: "Quantity is too large" }
  const delta = roundQuantity(onHandAfter - onHand)
  if (delta === 0) return { ok: false, error: "The quantity on hand is already that figure" }
  return { ok: true, delta, onHandAfter }
}

export type OpeningBalanceInput = {
  warehouses: ReadonlyArray<{ id: number; code: string; status: string }>
  /** Every product not deleted, with today's global figure. */
  products: ReadonlyArray<{ id: number; stockQuantity: number }>
  /** What every open order not yet In Process holds, per product, across every branch. */
  openQuantityByProduct: ReadonlyMap<number, number>
  /** (warehouse, product) pairs that already have a stock row. */
  existing: ReadonlySet<string>
}

export type OpeningBalancePlan = {
  rows: Array<{ warehouseId: number; globalProductId: number; onHand: number }>
  skippedExisting: number
  refusals: string[]
}

export const stockKey = (warehouseId: number, globalProductId: number) => `${warehouseId}:${globalProductId}`

/**
 * Today's figure into each named warehouse, without taking anything from any
 * customer.
 *
 * The global figure is already net of every open order (the global model takes
 * stock when an order is created), and those same orders are reserved again
 * the moment stock is counted per warehouse. So each warehouse opens with
 * today's figure **plus** what open orders hold: its available figure is then
 * exactly today's, and every open order can be packed at whichever warehouse
 * ends up fulfilling it. A pair that already has a row is never touched.
 */
export function planOpeningBalances(input: OpeningBalanceInput): OpeningBalancePlan {
  const refusals: string[] = []
  for (const warehouse of input.warehouses) {
    if (warehouse.status !== "ACTIVE") refusals.push(`Warehouse ${warehouse.code} is not active`)
  }
  const rows: OpeningBalancePlan["rows"] = []
  let skippedExisting = 0
  for (const warehouse of input.warehouses) {
    for (const product of input.products) {
      if (input.existing.has(stockKey(warehouse.id, product.id))) {
        skippedExisting += 1
        continue
      }
      const onHand = roundQuantity(Math.max(0, Number(product.stockQuantity)) + (input.openQuantityByProduct.get(product.id) ?? 0))
      if (onHand > MAX_STOCK_QUANTITY) refusals.push(`Product ${product.id} would open above the largest figure the column holds`)
      if (onHand > 0) rows.push({ warehouseId: warehouse.id, globalProductId: product.id, onHand })
    }
  }
  return { rows, skippedExisting, refusals }
}
