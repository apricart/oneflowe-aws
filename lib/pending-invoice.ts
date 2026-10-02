/**
 * Order states in which an invoice is available and can still represent money
 * awaiting payment. A fully refunded order is deliberately absent: its invoice
 * remains available as a historical document, but it is no longer payable.
 */
export const PENDING_INVOICE_ORDER_STATUSES = [
  "APPROVED",
  "FULFILLED",
  "PARTIAL",
  "PARTIALLY_FULFILLED",
] as const

const pendingInvoiceStatuses = new Set<string>(PENDING_INVOICE_ORDER_STATUSES)

export type PendingInvoiceSummary = {
  orderId: number
  invoiceNumber: string
  orderReference: string
}

export type PendingInvoiceStatus = {
  hasPendingInvoice: boolean
  pendingInvoice: PendingInvoiceSummary | null
}

type PendingInvoiceOrder = {
  status?: string | null
  paymentStatus?: string | null
  receiptData?: unknown
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toUpperCase()
}

/**
 * The shared definition used by tests and mirrored by the small indexed query
 * in the status endpoint. An invoice must actually have a receipt snapshot,
 * be past approval, not be fully refunded, and still be marked unpaid.
 */
export function isPendingInvoiceOrder(order: PendingInvoiceOrder): boolean {
  return Boolean(order.receiptData)
    && pendingInvoiceStatuses.has(normalize(order.status))
    && normalize(order.paymentStatus) === "UNPAID"
}

/**
 * Treat a malformed response as a failed check instead of accidentally
 * bypassing the notice. The endpoint never needs to expose invoice amounts.
 */
export function parsePendingInvoiceStatus(value: unknown): PendingInvoiceStatus | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<PendingInvoiceStatus>
  if (typeof candidate.hasPendingInvoice !== "boolean") return null

  if (!candidate.hasPendingInvoice) {
    return candidate.pendingInvoice === null
      ? { hasPendingInvoice: false, pendingInvoice: null }
      : null
  }

  const invoice = candidate.pendingInvoice
  if (
    !invoice
    || !Number.isSafeInteger(invoice.orderId)
    || invoice.orderId <= 0
    || typeof invoice.invoiceNumber !== "string"
    || invoice.invoiceNumber.trim().length === 0
    || typeof invoice.orderReference !== "string"
    || invoice.orderReference.trim().length === 0
  ) {
    return null
  }

  return {
    hasPendingInvoice: true,
    pendingInvoice: {
      orderId: invoice.orderId,
      invoiceNumber: invoice.invoiceNumber,
      orderReference: invoice.orderReference,
    },
  }
}
