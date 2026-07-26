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
  return String(status || "").trim().toUpperCase()
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

export function isPaidForRefund(paymentStatus: unknown): boolean {
  return String(paymentStatus || "").trim().toUpperCase() === "PAID"
}

export function isUniquePositiveIdList(ids: number[]): boolean {
  return ids.length === new Set(ids).size
}
