export const PRODUCT_PERFORMANCE_RANKINGS = [
  "netValue",
  "fulfilledQty",
  "orderCount",
] as const

export type ProductPerformanceRankBy = typeof PRODUCT_PERFORMANCE_RANKINGS[number]

export type ProductPerformanceRankingRow = {
  productName?: string | null
  revenueGeneratedCents?: number | null
  qtyOrdered?: number | null
  qtyFulfilled?: number | null
  qtyRefunded?: number | null
  totalOrders?: number | null
}

const numericValue = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseProductPerformanceRankBy(
  value: unknown,
): ProductPerformanceRankBy {
  return PRODUCT_PERFORMANCE_RANKINGS.includes(value as ProductPerformanceRankBy)
    ? value as ProductPerformanceRankBy
    : "netValue"
}

export function parseProductPerformanceLimit(value: unknown, maximum = 100) {
  if (value === null || value === undefined || value === "") return undefined

  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) return undefined
  return Math.min(Math.max(parsed, 1), maximum)
}

export function productPerformanceMetric(
  row: ProductPerformanceRankingRow,
  rankBy: ProductPerformanceRankBy,
) {
  if (rankBy === "fulfilledQty") return numericValue(row.qtyFulfilled)
  if (rankBy === "orderCount") return numericValue(row.totalOrders)
  return numericValue(row.revenueGeneratedCents)
}

export function rankProductPerformanceRows<T extends ProductPerformanceRankingRow>(
  rows: T[],
  {
    requestedRankBy,
    pricesHidden,
    limit,
    includeZeroActivity = false,
  }: {
    requestedRankBy: ProductPerformanceRankBy
    pricesHidden: boolean
    limit?: number
    includeZeroActivity?: boolean
  },
) {
  const rankBy: ProductPerformanceRankBy =
    pricesHidden && requestedRankBy === "netValue"
      ? "fulfilledQty"
      : requestedRankBy

  const ranked = rows
    .filter((row) => includeZeroActivity || (
      numericValue(row.totalOrders) > 0
      || numericValue(row.qtyOrdered) > 0
      || numericValue(row.qtyFulfilled) > 0
      || numericValue(row.qtyRefunded) > 0
      || numericValue(row.revenueGeneratedCents) > 0
    ))
    .sort((left, right) => {
      const primaryDifference =
        productPerformanceMetric(right, rankBy)
        - productPerformanceMetric(left, rankBy)
      if (primaryDifference !== 0) return primaryDifference

      if (rankBy !== "fulfilledQty") {
        const fulfilledDifference =
          productPerformanceMetric(right, "fulfilledQty")
          - productPerformanceMetric(left, "fulfilledQty")
        if (fulfilledDifference !== 0) return fulfilledDifference
      }

      if (rankBy !== "orderCount") {
        const orderDifference =
          productPerformanceMetric(right, "orderCount")
          - productPerformanceMetric(left, "orderCount")
        if (orderDifference !== 0) return orderDifference
      }

      return (left.productName || "").localeCompare(right.productName || "")
    })

  return {
    data: limit ? ranked.slice(0, limit) : ranked,
    rankBy,
  }
}
