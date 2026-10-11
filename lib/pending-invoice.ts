import { deriveInvoiceStatus, type InvoiceStatus } from "@/lib/invoice-status"

/**
 * Invoice statuses that still represent money awaiting payment: a tax invoice
 * issued at delivery, whole or partly credited. A proforma is not an invoice
 * (nothing is owed until the goods are supplied), and a fully credited invoice
 * is no longer payable. See plans/OF-INVOICE-invoice-ledger.md (D7), which
 * narrowed this from "approved onwards".
 */
export const PENDING_INVOICE_STATUSES = ["ISSUED", "PARTIALLY_CREDITED"] as const satisfies readonly InvoiceStatus[]

const pendingInvoiceStatuses = new Set<InvoiceStatus>(PENDING_INVOICE_STATUSES)

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
  fulfillmentStatus?: string | null
  statusAtRefund?: string | null
  refundAmountCents?: number | string | null
  paymentStatus?: string | null
  receiptData?: unknown
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toUpperCase()
}

/**
 * The shared definition used by tests and mirrored by the status endpoint's
 * query (through `invoiceStatusSql`). The order must have a snapshot, a tax
 * invoice that is not fully credited, and still be marked unpaid.
 */
export function isPendingInvoiceOrder(order: PendingInvoiceOrder): boolean {
  return Boolean(order.receiptData)
    && pendingInvoiceStatuses.has(deriveInvoiceStatus(order))
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
