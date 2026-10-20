export const PAYMENT_STATUSES = ["UNPAID", "PAID"] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  UNPAID: "Unpaid",
  PAID: "Paid",
}

export function normalizePaymentStatus(status?: string | null): PaymentStatus {
  const normalized = String(status || "UNPAID").trim().toUpperCase()
  return PAYMENT_STATUSES.includes(normalized as PaymentStatus)
    ? (normalized as PaymentStatus)
    : "UNPAID"
}

/**
 * Parses the optional list filter without falling back invalid input to
 * Unpaid. A malformed filter must be rejected by the route rather than
 * silently narrowing a payment-sensitive order list.
 */
export function parsePaymentStatusFilter(value?: string | null):
  | { ok: true; status: PaymentStatus | null }
  | { ok: false; message: string } {
  if (value === null || value === undefined || value.trim() === "") {
    return { ok: true, status: null }
  }
  const normalized = value.trim().toUpperCase()
  if (PAYMENT_STATUSES.includes(normalized as PaymentStatus)) {
    return { ok: true, status: normalized as PaymentStatus }
  }
  return { ok: false, message: `paymentStatus must be one of: ${PAYMENT_STATUSES.join(", ")}` }
}
