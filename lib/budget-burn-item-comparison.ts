import {
  BUDGET_BURN_THRESHOLDS,
  monthOverMonth,
  type BudgetBurnThresholds,
} from "@/lib/budget-burn-risk"

/** Maximum number of product/unit groups read for any one month. */
export const BUDGET_BURN_ITEM_ROW_CAP = 500

export type ProductWindowRow = {
  productId: number | null
  productName: string
  unit: string
  quantity: number
  valueCents: number
  orderCount: number
}

/** One product, at one unit, in one month of the pattern. */
export type ItemMonth = {
  month: string
  quantity: number
  spendCents: number
  orderCount: number
}

export type ItemPatternRow = {
  productId: number | null
  productName: string
  unit: string
  /** One entry per pattern month, oldest first; zero-filled where nothing was bought. */
  months: ItemMonth[]
  /**
   * Spend growth of the newest month over the one before it, decided by the
   * same rule and the same thresholds as the requester row this panel
   * explains — so a product can never contradict the percentage that was
   * clicked to open it.
   */
  momPct: number | null
  momFlagged: boolean
}

function productUnitKey(row: Pick<ProductWindowRow, "productId" | "unit">): string {
  return `${row.productId ?? "null"}\u0000${row.unit}`
}

function emptyItemMonth(month: string): ItemMonth {
  return { month, quantity: 0, spendCents: 0, orderCount: 0 }
}

/**
 * The months a product was bought in, merged across every bucket at product +
 * unit grain.
 *
 * A product present in only one month keeps its row with zeroes elsewhere: a
 * purchase that started, or one that stopped, is exactly the deviation the
 * reader came for. Quantities are never combined across units, because a ream
 * and a box are not the same thing.
 *
 * `months` and `buckets` are parallel and oldest first; a bucket with no rows
 * is a month in which this requester bought nothing, not a missing month.
 */
export function buildItemPattern(
  months: readonly string[],
  buckets: readonly (readonly ProductWindowRow[])[],
  thresholds: Pick<BudgetBurnThresholds, "momSpikePct" | "momMinBaselineCents"> = BUDGET_BURN_THRESHOLDS,
): ItemPatternRow[] {
  const byKey = new Map<string, ItemPatternRow>()

  months.forEach((month, index) => {
    for (const row of buckets[index] ?? []) {
      const key = productUnitKey(row)
      const entry = byKey.get(key) ?? {
        productId: row.productId,
        productName: row.productName,
        unit: row.unit,
        months: months.map(emptyItemMonth),
        momPct: null,
        momFlagged: false,
      }
      entry.months[index] = {
        month,
        quantity: Math.max(0, Number(row.quantity) || 0),
        spendCents: Math.max(0, Number(row.valueCents) || 0),
        orderCount: Math.max(0, Number(row.orderCount) || 0),
      }
      // The newest name wins, so a product renamed mid-window reads as it does today.
      entry.productName = row.productName
      byKey.set(key, entry)
    }
  })

  const rows = Array.from(byKey.values(), (entry) => {
    const { momPct, momFlagged } = monthOverMonth(
      entry.months.map((month) => ({
        month: month.month,
        spendCents: month.spendCents,
        pendingCents: 0,
        consumedCents: month.spendCents,
      })),
      thresholds,
    )
    return { ...entry, momPct, momFlagged }
  })

  return rows.sort((left, right) => (
    Number(right.momFlagged) - Number(left.momFlagged)
    || newestSpend(right) - newestSpend(left)
    || left.productName.localeCompare(right.productName)
    || left.unit.localeCompare(right.unit)
  ))
}

/** The newest month's spend — what the rest of the table sorts by once highlights are placed. */
function newestSpend(row: ItemPatternRow): number {
  return row.months.at(-1)?.spendCents ?? 0
}

/** The panel's per-month footers: what this requester consumed in each month, across every product. */
export function itemPatternTotals(months: readonly string[], rows: readonly ItemPatternRow[]): ItemMonth[] {
  return months.map((month, index) => rows.reduce<ItemMonth>((total, row) => {
    const entry = row.months[index]
    if (!entry) return total
    return {
      month,
      quantity: total.quantity + entry.quantity,
      spendCents: total.spendCents + entry.spendCents,
      orderCount: total.orderCount + entry.orderCount,
    }
  }, emptyItemMonth(month)))
}
