import { deriveInvoiceStatus, isOrderSupplied, type InvoiceStatus } from "@/lib/invoice-status"
import { orderStillOwes } from "@/lib/unpaid-invoice-block"

/**
 * Invoice statuses that still represent money awaiting payment: a tax invoice,
 * whole or partly credited. A proforma is not an invoice, and a fully credited
 * invoice is no longer payable. See plans/OF-INVOICE-invoice-ledger.md (D7),
 * which narrowed this from "approved onwards".
 *
 * The tax invoice is issued when processing starts
 * (plans/OF-INVOICE-issue-at-processing.md), but nothing is owed until the
 * goods are supplied, so `isPendingInvoiceOrder` also requires that.
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
  /** `invoices.status`, when the order's tax invoice has been issued. */
  ledgerStatus?: string | null
  paymentStatus?: string | null
  receiptData?: unknown
  totalCents?: number | string | null
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toUpperCase()
}

/**
 * The shared definition used by tests and mirrored by the status endpoint's
 * query (through `invoiceStatusSql` and `orderSuppliedSql`). The order must
 * have a snapshot, a tax invoice that is not fully credited, goods that were
 * supplied, and still be marked unpaid.
 */
export function isPendingInvoiceOrder(order: PendingInvoiceOrder): boolean {
  return Boolean(order.receiptData)
    && pendingInvoiceStatuses.has(deriveInvoiceStatus(order))
    && isOrderSupplied(order)
    && normalize(order.paymentStatus) === "UNPAID"
    && orderStillOwes(order)
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
