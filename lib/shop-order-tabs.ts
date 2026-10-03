import { getOrderStatusesForFilter } from "@/lib/order-status"

/**
 * The order tabs of the Order Portal store, in display order. Every order
 * lands in exactly one of them, so a pending order is never listed beside a
 * fulfilled one.
 */
export const SHOP_ORDER_TABS = ["pending", "active", "fulfilled", "rejected", "refunded"] as const
export type ShopOrderTab = (typeof SHOP_ORDER_TABS)[number]

export const SHOP_ORDER_TAB_LABELS: Readonly<Record<ShopOrderTab, string>> = {
  pending: "Pending Approval",
  active: "Active",
  fulfilled: "Fulfilled",
  rejected: "Rejected",
  refunded: "Refunded",
}

export const SHOP_ORDER_TAB_EMPTY_LABELS: Readonly<Record<ShopOrderTab, string>> = {
  pending: "No orders awaiting approval",
  active: "No active orders",
  fulfilled: "No fulfilled orders",
  rejected: "No rejected orders",
  refunded: "No refunded orders",
}

export type ShopOrderTabSource = {
  status?: string | null
  totalCents?: number | null
  refundAmountCents?: number | null
  orderItems?: ReadonlyArray<{ quantity: number; quantityRefunded?: number | null }>
}

/** True when any part of the order has been refunded, in full or in part. */
export function hasAnyRefund(order: ShopOrderTabSource): boolean {
  if ((order.status || "").trim().toUpperCase() === "REFUNDED") return true
  if (order.orderItems?.length) {
    return order.orderItems.some((item) => (item.quantityRefunded || 0) > 0)
  }
  return Number(order.refundAmountCents || 0) > 0
}

const statusesOf = (filter: Parameters<typeof getOrderStatusesForFilter>[0]) =>
  new Set(getOrderStatusesForFilter(filter))

const APPROVED_STATUSES = statusesOf("approved")
const FULFILLED_STATUSES = statusesOf("fulfilled")
const REJECTED_STATUSES = statusesOf("rejected")

/**
 * The tab an order belongs on. A refund, full or partial, takes precedence —
 * that is where the store has always listed refunded orders. Otherwise the
 * status decides, using the same status groups as the admin order filters.
 * PENDING, and any status not recognised, is listed as pending rather than
 * hidden.
 */
export function shopOrderTabOf(order: ShopOrderTabSource): ShopOrderTab {
  if (hasAnyRefund(order)) return "refunded"
  const status = (order.status || "").trim().toUpperCase()
  if (APPROVED_STATUSES.has(status)) return "active"
  if (FULFILLED_STATUSES.has(status)) return "fulfilled"
  if (REJECTED_STATUSES.has(status)) return "rejected"
  return "pending"
}

export function isShopOrderTab(value: unknown): value is ShopOrderTab {
  return typeof value === "string" && (SHOP_ORDER_TABS as readonly string[]).includes(value)
}

/** Order counts per tab, every tab present even when empty. */
export function countShopOrdersByTab(
  orders: ReadonlyArray<ShopOrderTabSource> | null | undefined,
): Record<ShopOrderTab, number> {
  const counts: Record<ShopOrderTab, number> = { pending: 0, active: 0, fulfilled: 0, rejected: 0, refunded: 0 }
  for (const order of orders ?? []) counts[shopOrderTabOf(order)] += 1
  return counts
}
