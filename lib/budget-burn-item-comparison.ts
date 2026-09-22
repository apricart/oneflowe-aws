import { growthPct } from "@/lib/executive-analytics"

/** Maximum number of product/unit groups read for either month. */
export const BUDGET_BURN_ITEM_ROW_CAP = 500

export type ProductWindowRow = {
  productId: number | null
  productName: string
  unit: string
  quantity: number
  valueCents: number
  orderCount: number
}

export type ItemComparisonRow = {
  productId: number | null
  productName: string
  unit: string
  currentQuantity: number
  priorQuantity: number
  deltaQuantity: number
  /** Null when the prior window has no quantity baseline. */
  deltaPct: number | null
  currentSpendCents: number
  priorSpendCents: number
  currentOrderCount: number
  priorOrderCount: number
}

function productUnitKey(row: Pick<ProductWindowRow, "productId" | "unit">): string {
  return `${row.productId ?? "null"}\u0000${row.unit}`
}

/**
 * Full outer merge of the two windows at product + unit grain.
 *
 * A product present in only one month remains visible with zeroes on the
 * other side: a new purchase or one that stopped is exactly the deviation the
 * reader is looking for. Quantities are never combined across units.
 */
export function buildItemComparison(
  current: readonly ProductWindowRow[],
  prior: readonly ProductWindowRow[],
): ItemComparisonRow[] {
  const currentByKey = new Map(current.map((row) => [productUnitKey(row), row]))
  const priorByKey = new Map(prior.map((row) => [productUnitKey(row), row]))
  const keys = new Set([...currentByKey.keys(), ...priorByKey.keys()])

  return Array.from(keys, (key) => {
    const currentRow = currentByKey.get(key)
    const priorRow = priorByKey.get(key)
    const currentQuantity = Math.max(0, Number(currentRow?.quantity) || 0)
    const priorQuantity = Math.max(0, Number(priorRow?.quantity) || 0)

    return {
      productId: currentRow?.productId ?? priorRow?.productId ?? null,
      productName: currentRow?.productName ?? priorRow?.productName ?? "Unknown product",
      unit: currentRow?.unit ?? priorRow?.unit ?? "",
      currentQuantity,
      priorQuantity,
      deltaQuantity: currentQuantity - priorQuantity,
      deltaPct: growthPct(currentQuantity, priorQuantity),
      currentSpendCents: Math.max(0, Number(currentRow?.valueCents) || 0),
      priorSpendCents: Math.max(0, Number(priorRow?.valueCents) || 0),
      currentOrderCount: Math.max(0, Number(currentRow?.orderCount) || 0),
      priorOrderCount: Math.max(0, Number(priorRow?.orderCount) || 0),
    }
  }).sort((left, right) => (
    Math.abs(right.deltaQuantity) - Math.abs(left.deltaQuantity)
    || right.currentQuantity - left.currentQuantity
    || left.productName.localeCompare(right.productName)
    || left.unit.localeCompare(right.unit)
  ))
}
