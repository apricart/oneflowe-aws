import { stringifyPrimitive } from "./stringify-primitive"
export const MAX_BUSINESS_QUANTITY = 1_000_000

export const ORDER_STATUS_TRANSITIONS = {
  PENDING: ["APPROVED", "REJECTED", "REFUNDED"],
  APPROVED: ["FULFILLED", "REFUNDED"],
  FULFILLED: ["REFUNDED"],
  REJECTED: [],
  REFUNDED: [],
} as const

export type OrderStatus = keyof typeof ORDER_STATUS_TRANSITIONS

export function normalizeOrderStatus(status: unknown): string {
  return stringifyPrimitive(status).trim().toUpperCase()
}

export function canTransitionOrderStatus(from: unknown, to: unknown): boolean {
  const current = normalizeOrderStatus(from) as OrderStatus
  const next = normalizeOrderStatus(to)
  const allowed = ORDER_STATUS_TRANSITIONS[current] as readonly string[] | undefined
  return Boolean(allowed?.includes(next))
}

export function isRefundEligibleOrderStatus(status: unknown): boolean {
  const normalized = normalizeOrderStatus(status)
  return normalized === "PENDING" || normalized === "APPROVED" || normalized === "FULFILLED"
}

export function isOrderPortalRefundEligible(
  orderStatus: unknown,
  fulfillmentStatus: unknown,
): boolean {
  return normalizeOrderStatus(orderStatus) === "FULFILLED"
    && stringifyPrimitive(fulfillmentStatus).trim().toUpperCase() === "DELIVERED"
}

/**
 * Whether an order's Paid / Unpaid flag may be changed: any approved order —
 * `APPROVED` at any delivery stage, or `FULFILLED` — and nothing pending,
 * rejected, cancelled or refunded (plans/OF-FINANCE-finance-role.md). The
 * delivery stage is no longer part of the rule; the parameter is kept so the
 * callers and the atomic claim in `transitionOrderPaymentStatusColumn` read
 * the same inputs.
 */
export function isPaymentStatusUpdateEligible(
  orderStatus: unknown,
  _fulfillmentStatus?: unknown,
): boolean {
  const status = normalizeOrderStatus(orderStatus)
  return status === "APPROVED" || status === "FULFILLED"
}

export function isUniquePositiveIdList(ids: number[]): boolean {
  return ids.length === new Set(ids).size
}
