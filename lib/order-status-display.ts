import {
  getOrderDerivedStatus,
  hasPartialRefund,
  type OrderStatusContext,
} from "@/lib/order-status"
import {
  FULFILLMENT_STATUS_LABELS,
  normalizeFulfillmentStatus,
} from "@/lib/fulfillment-status"
import {
  PAYMENT_STATUS_LABELS,
  normalizePaymentStatus,
} from "@/lib/payment-status"

export type OrderStatusDisplaySource = {
  status?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  refundAmountCents?: number | null
}

export function shouldShowOrderFulfillmentStatus(order: OrderStatusDisplaySource): boolean {
  const status = String(order.status || "").trim().toLowerCase()
  return status === "approved" || status === "fulfilled"
}

export function shouldShowOrderPaymentStatus(order: OrderStatusDisplaySource): boolean {
  const status = String(order.status || "").trim().toLowerCase()
  return status !== "rejected" && status !== "cancelled"
}

/**
 * Provides the canonical labels rendered by the orders table and its downloads.
 * A null secondary status means that badge is intentionally not shown in the UI.
 */
export function getOrderStatusDisplay(
  order: OrderStatusDisplaySource,
  context: OrderStatusContext = "default",
) {
  const orderStatus = getOrderDerivedStatus(order, context)

  return {
    orderStatus,
    fulfillmentStatus: shouldShowOrderFulfillmentStatus(order)
      ? FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)]
      : null,
    paymentStatus: shouldShowOrderPaymentStatus(order)
      ? PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]
      : null,
    refundStatus: orderStatus.key === "refunded"
      ? "Full Refund"
      : hasPartialRefund(order)
        ? "Partial Refund"
        : null,
  }
}
