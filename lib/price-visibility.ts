import { eq, and, inArray } from "drizzle-orm"
import { organizationSettings } from "@/db/schema"
import { coalesceInFlight, scopedCacheKey } from "@/lib/cache-utils"
import { db } from "@/lib/db"

export const LEGACY_HIDE_PRICES_SETTING_KEY = "hide_prices_for_branch_and_order_portal"
export const HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY = "hide_prices_for_branch_admin"
export const HIDE_ORDER_PORTAL_PRICES_SETTING_KEY = "hide_prices_for_order_portal"

export const PRICE_VISIBILITY_SETTING_KEYS = [
  LEGACY_HIDE_PRICES_SETTING_KEY,
  HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
  HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
] as const

export function isPriceVisibilitySettingKey(key: unknown) {
  return typeof key === "string" && (PRICE_VISIBILITY_SETTING_KEYS as readonly string[]).includes(key)
}

const PRICE_RESTRICTED_ROLES = new Set(["BRANCH_ADMIN", "ORDER_PORTAL"])
const ROLE_PRICE_SETTING_KEYS: Record<string, string> = {
  BRANCH_ADMIN: HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
  ORDER_PORTAL: HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
}

export function isPriceRestrictedRole(role: unknown) {
  return typeof role === "string" && PRICE_RESTRICTED_ROLES.has(role)
}

export async function shouldHidePricesForRole(role: unknown, organizationId: unknown) {
  const roleSettingKey = typeof role === "string" ? ROLE_PRICE_SETTING_KEYS[role] : undefined
  if (!roleSettingKey) return false

  const orgId = Number(organizationId)
  if (!Number.isFinite(orgId) || orgId <= 0) return false

  // Coalesce only simultaneous reads for the same organization. This is not a
  // persisted cache: price-visibility changes remain observable on the next
  // request, while a burst cannot issue hundreds of identical settings reads.
  const settings = await coalesceInFlight(
    scopedCacheKey("inflight:settings:price-visibility", { orgId }),
    () => db
      .select({ key: organizationSettings.key, value: organizationSettings.value })
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, orgId),
          inArray(organizationSettings.key, PRICE_VISIBILITY_SETTING_KEYS)
        )
      )
      .limit(PRICE_VISIBILITY_SETTING_KEYS.length),
  )

  const roleSetting = settings.find((setting) => setting.key === roleSettingKey)
  if (roleSetting) return roleSetting.value === true

  const legacySetting = settings.find((setting) => setting.key === LEGACY_HIDE_PRICES_SETTING_KEY)
  return legacySetting?.value === true
}

function redactReceiptItems(items: any[] | undefined) {
  if (!Array.isArray(items)) return items

  return items.map((category) => ({
    ...category,
    items: Array.isArray(category.items)
      ? category.items.map((item: any) => ({ ...item, rate: null, total: null }))
      : category.items,
    subCategories: Array.isArray(category.subCategories)
      ? category.subCategories.map((subCategory: any) => ({
        ...subCategory,
        items: Array.isArray(subCategory.items)
          ? subCategory.items.map((item: any) => ({ ...item, rate: null, total: null }))
          : subCategory.items,
      }))
      : category.subCategories,
  }))
}

export function redactReceiptPrices(receiptData: any) {
  if (!receiptData) return receiptData

  return {
    ...receiptData,
    subtotal: null,
    tax: null,
    discount: null,
    deliveryCharges: null,
    refund: null,
    totalAmount: null,
    refundedItems: Array.isArray(receiptData.refundedItems)
      ? receiptData.refundedItems.map((item: any) => ({ ...item, amount: null }))
      : receiptData.refundedItems,
    items: redactReceiptItems(receiptData.items),
  }
}

const ANALYTICS_MONEY_KEYS = new Set([
  "addon",
  "allocated",
  "amount",
  "amountCents",
  "amountAllocatedCents",
  "amountCreditedCents",
  "amountHeldCents",
  "amountSpentCents",
  "avgSales",
  "avgRevenuePerGroup",
  "approvedAmountCents",
  "baseline",
  "baselineAmount",
  "baselineBudgetCents",
  "basePriceCents",
  "compareRevenue",
  "compareTotalSpentCents",
  "compSpent",
  "compSales",
  "credited",
  "grossRevenue",
  "grossRevenueCents",
  "held",
  "heldCents",
  "fulfilledProductRevenueCents",
  "fulfilledRevenueCents",
  "itemRefundCents",
  "leakage",
  "netRevenue",
  "netTotalCents",
  "orderTotalCents",
  "pendingAmountCents",
  "prevRevenue",
  "price",
  "priceCents",
  "remaining",
  "remainingCents",
  "refundAmount",
  "refundAmountCents",
  "refundedValue",
  "refundLossCents",
  "refunds",
  "refundedProductRevenueCents",
  "refundedRevenueCents",
  "revenue",
  "revenueCents",
  "revenueGeneratedCents",
  "sales",
  "spent",
  "spentCents",
  "subtotalCents",
  "taxCents",
  "taxRefundCents",
  "totalAllocated",
  "totalAmount",
  "totalAmountCents",
  "totalBudget",
  "totalCents",
  "totalCredited",
  "totalHeld",
  "totalNetSales",
  "totalProductRevenueCents",
  "totalRefundCents",
  "totalRefunded",
  "totalRefundedCents",
  "totalRefunds",
  "totalRemaining",
  "totalRejected",
  "totalRevenue",
  "totalRevenueCents",
  "totalSales",
  "totalSpentCents",
  "totalSubtotal",
  "totalTax",
  "unitPriceCents",
  "unitRateCents",
  "valueDeliveredCents",
  "valueFulfilledCents",
  "valuePendingCents",
  "valueRefundedCents",
  "valueRejectedCents",
])

export function redactAnalyticsPrices<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactAnalyticsPrices(item)) as T
  }

  if (!value || typeof value !== "object") return value
  if (value instanceof Date) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      ANALYTICS_MONEY_KEYS.has(key) ? null : redactAnalyticsPrices(entry),
    ])
  ) as T
}
