export const PRODUCT_PRICE_HISTORY_RANGE_KEYS = ["90d", "180d", "1y", "all"] as const

export type ProductPriceHistoryRangeKey = (typeof PRODUCT_PRICE_HISTORY_RANGE_KEYS)[number]
export type ProductPriceHistoryRole = "SUPER_ADMIN" | "HEAD_OFFICE"

export type ProductPriceHistoryRange = {
  key: ProductPriceHistoryRangeKey
  label: string
  startAt: Date | null
}

export type ProductPriceHistoryProduct = {
  id: number
  productCode: string
  name: string
  unit: string
  status: string
  snapshotCount: number
  firstRecordedAt: string | null
  lastRecordedAt: string | null
}

export type ProductPriceHistoryFilterOption = {
  id: number
  name: string
  organizationId?: number
  organizationName?: string
  groupId?: number | null
}

export type ProductPriceHistoryPoint = {
  orderItemId: number
  orderId: number
  orderReference: string
  orderedAt: string
  chargedPriceCents: number
  quantity: number
  organizationId: number
  organizationName: string
  groupId: number | null
  groupName: string | null
  branchId: number
  branchName: string
}

export type ProductPriceHistoryResponse = {
  role: ProductPriceHistoryRole
  products: ProductPriceHistoryProduct[]
  selectedProduct: ProductPriceHistoryProduct | null
  options: {
    organizations: ProductPriceHistoryFilterOption[]
    groups: ProductPriceHistoryFilterOption[]
    branches: ProductPriceHistoryFilterOption[]
  }
  selection: {
    organizationId: number | null
    groupId: number | null
    branchId: number | null
  }
  range: {
    key: ProductPriceHistoryRangeKey
    label: string
    startAt: string | null
  }
  points: ProductPriceHistoryPoint[]
  truncated: boolean
  source: {
    description: string
    excludes: string[]
  }
}

export function isProductPriceHistoryRange(value: string | null): value is ProductPriceHistoryRangeKey {
  return PRODUCT_PRICE_HISTORY_RANGE_KEYS.includes(value as ProductPriceHistoryRangeKey)
}

export function resolveProductPriceHistoryRange(
  key: ProductPriceHistoryRangeKey,
  now = new Date(),
): ProductPriceHistoryRange {
  if (key === "all") return { key, label: "All time", startAt: null }

  const startAt = new Date(now)
  if (key === "90d") {
    startAt.setUTCDate(startAt.getUTCDate() - 90)
    return { key, label: "Last 90 days", startAt }
  }
  if (key === "180d") {
    startAt.setUTCDate(startAt.getUTCDate() - 180)
    return { key, label: "Last 6 months", startAt }
  }

  startAt.setUTCFullYear(startAt.getUTCFullYear() - 1)
  return { key, label: "Last 12 months", startAt }
}

/**
 * PostgreSQL aggregate values can be strings on some pg/Drizzle paths even
 * when their static selection type is Date. Normalize them at the API edge.
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value as string | number)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
