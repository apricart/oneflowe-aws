type OrderStatusSource = {
  status?: string | null
  refundAmountCents?: number | null
}

export type OrderStatusContext = "default" | "fulfilled" | "refunded"
export type OrderSplitFilter = "all" | "partial" | "full"
export const ORDER_STATUS_FILTERS = [
  "all",
  "pending",
  "approved",
  "fulfilled",
  "rejected",
  "refunded",
] as const
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number]
export const PENDING_ORDERS_REVIEW_HREF = "/orders?status=pending"

export function getPendingOrderReviewHref(
  orderId: number | null | undefined,
  pendingOrderCount: number,
): string {
  return pendingOrderCount === 1 && Number.isInteger(orderId) && Number(orderId) > 0
    ? `/orders/${orderId}`
    : PENDING_ORDERS_REVIEW_HREF
}

export type DerivedOrderStatusKey =
  | "pending"
  | "approved"
  | "fulfilled"
  | "partially_fulfilled"
  | "refunded"
  | "partially_refunded"
  | "rejected"
  | "cancelled"
  | "unknown"

function normalizeStatus(status?: string | null) {
  return (status || "").trim().toUpperCase()
}

export function getOrderStatusFilter(value?: string | null): OrderStatusFilter {
  const normalized = (value || "").trim().toLowerCase()
  return ORDER_STATUS_FILTERS.includes(normalized as OrderStatusFilter)
    ? (normalized as OrderStatusFilter)
    : "all"
}

export function getOrderRefundVariant(order: OrderStatusSource): Exclude<OrderSplitFilter, "all"> | "none" {
  const status = normalizeStatus(order.status)
  const refundAmountCents = Number(order.refundAmountCents || 0)

  if (status === "REFUNDED") return "full"
  if (refundAmountCents > 0) return "partial"
  return "none"
}

export function hasPartialRefund(order: OrderStatusSource): boolean {
  const status = normalizeStatus(order.status)
  return (
    (status === "FULFILLED" || status === "PARTIAL" || status === "PARTIALLY_FULFILLED") &&
    Number(order.refundAmountCents || 0) > 0
  )
}

export function getOrderFulfillmentVariant(order: OrderStatusSource): Exclude<OrderSplitFilter, "all"> | "none" {
  const status = normalizeStatus(order.status)

  if (status === "PARTIAL" || status === "PARTIALLY_FULFILLED") return "full"
  if (status === "FULFILLED") return "full"
  return "none"
}

function getBaseStatusKey(order: OrderStatusSource): DerivedOrderStatusKey {
  const status = normalizeStatus(order.status)

  switch (status) {
    case "PENDING":
      return "pending"
    case "APPROVED":
      return "approved"
    case "FULFILLED":
      return "fulfilled"
    case "PARTIAL":
    case "PARTIALLY_FULFILLED":
      return "fulfilled"
    case "REFUNDED":
      return "refunded"
    case "REJECTED":
      return "rejected"
    case "CANCELLED":
      return "cancelled"
    default:
      return "unknown"
  }
}

export function getOrderDerivedStatus(
  order: OrderStatusSource,
  context: OrderStatusContext = "default"
): { key: DerivedOrderStatusKey; label: string } {
  const refundVariant = getOrderRefundVariant(order)
  const fulfillmentVariant = getOrderFulfillmentVariant(order)

  if (context === "refunded") {
    if (refundVariant === "partial") return { key: "partially_refunded", label: "Partially Refunded" }
    if (refundVariant === "full") return { key: "refunded", label: "Refunded" }
  }

  if (context === "fulfilled") {
    if (fulfillmentVariant === "partial") return { key: "partially_fulfilled", label: "Partially Fulfilled" }
    if (fulfillmentVariant === "full") return { key: "fulfilled", label: "Fulfilled" }
  }

  if (refundVariant === "full") return { key: "refunded", label: "Refunded" }

  const key = getBaseStatusKey(order)

  switch (key) {
    case "pending":
      return { key, label: "Pending Approval" }
    case "approved":
      return { key, label: "Active" }
    case "fulfilled":
      return { key, label: "Fulfilled" }
    case "rejected":
      return { key, label: "Rejected" }
    case "cancelled":
      return { key, label: "Cancelled" }
    default:
      return {
        key,
        label: normalizeStatus(order.status)
          .toLowerCase()
          .replace(/_/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase()) || "Unknown",
      }
  }
}
