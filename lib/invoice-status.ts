/**
 * The status of an order's invoice (plans/OF-INVOICE-invoice-ledger.md, D2).
 *
 * Derived from the order on every read and never stored: roughly ten paths
 * move an order (approve, deliver, fulfil, auto-fulfil, both refund routes,
 * desk and group cancel, admin delete), and a stored copy would have to be
 * kept in step by every one of them.
 *
 * The tax invoice exists once the goods are supplied — delivered, or fulfilled,
 * which requires delivery. Before that an approved order has only a proforma.
 * A credit can only follow an issued invoice: refunding goods that were never
 * delivered cancels the proforma rather than crediting an invoice.
 *
 * `invoiceStatusSql` (lib/server/invoice-status-sql.ts) is the SQL twin of
 * `deriveInvoiceStatus`; an integration test holds the two to the same answer
 * for every combination of inputs.
 */

export const INVOICE_STATUSES = [
  "NOT_ISSUED",
  "PROFORMA_AVAILABLE",
  "ISSUED",
  "PARTIALLY_CREDITED",
  "CREDITED",
  "CANCELLED",
] as const

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  NOT_ISSUED: "Not issued",
  PROFORMA_AVAILABLE: "Proforma available",
  ISSUED: "Issued",
  PARTIALLY_CREDITED: "Partially credited",
  CREDITED: "Credited",
  CANCELLED: "Cancelled",
}

/** Order statuses that can only be reached once the goods were supplied. */
export const SUPPLIED_ORDER_STATUSES = ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"] as const

const SUPPLIED = new Set<string>(SUPPLIED_ORDER_STATUSES)

export type InvoiceStatusSource = {
  status?: string | null
  fulfillmentStatus?: string | null
  statusAtRefund?: string | null
  refundAmountCents?: number | string | null
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : ""
}

/** Whether the goods behind this order were supplied, so a tax invoice exists. */
export function isOrderSupplied(order: InvoiceStatusSource): boolean {
  return SUPPLIED.has(normalize(order.status))
    || normalize(order.fulfillmentStatus) === "DELIVERED"
    || SUPPLIED.has(normalize(order.statusAtRefund))
}

export function deriveInvoiceStatus(order: InvoiceStatusSource): InvoiceStatus {
  const status = normalize(order.status)

  if (status === "PENDING" || status === "REJECTED") return "NOT_ISSUED"
  if (status === "CANCELLED") return "CANCELLED"

  if (isOrderSupplied(order)) {
    if (status === "REFUNDED") return "CREDITED"
    return Number(order.refundAmountCents || 0) > 0 ? "PARTIALLY_CREDITED" : "ISSUED"
  }

  if (status === "REFUNDED") return "CANCELLED"
  if (status === "APPROVED") return "PROFORMA_AVAILABLE"
  return "NOT_ISSUED"
}

/** True once a tax invoice exists, whatever has been credited against it since. */
export function isTaxInvoiceStatus(status: InvoiceStatus): boolean {
  return status === "ISSUED" || status === "PARTIALLY_CREDITED" || status === "CREDITED"
}

/**
 * The heading an invoice document prints. Anything that is not yet a tax
 * invoice says so, because a proforma that looks like an invoice is exactly
 * what gets booked by mistake.
 */
export function invoiceDocumentTitle(status: InvoiceStatus): "INVOICE" | "PROFORMA INVOICE" {
  return isTaxInvoiceStatus(status) ? "INVOICE" : "PROFORMA INVOICE"
}

/**
 * What an invoice document adds to its snapshot for the status: the status,
 * its label, and the title to print.
 *
 * The customer's STRN is added only to a document that is not yet a tax
 * invoice. A proforma is read live, so it shows the STRN as it is now; an
 * invoice already issued keeps printing what it printed before the STRN
 * existed, until invoices are frozen at issue
 * (plans/OF-INVOICE-invoice-ledger.md, D9).
 */
export function describeInvoiceStatus(
  order: InvoiceStatusSource,
  organizationStrn?: string | null,
): {
  status: InvoiceStatus
  fields: {
    invoiceStatus: InvoiceStatus
    invoiceStatusLabel: string
    documentTitle: "INVOICE" | "PROFORMA INVOICE"
    organizationStrn?: string
  }
} {
  const status = deriveInvoiceStatus(order)
  const strn = typeof organizationStrn === "string" ? organizationStrn.trim() : ""
  return {
    status,
    fields: {
      invoiceStatus: status,
      invoiceStatusLabel: INVOICE_STATUS_LABELS[status],
      documentTitle: invoiceDocumentTitle(status),
      ...(strn && !isTaxInvoiceStatus(status) ? { organizationStrn: strn } : {}),
    },
  }
}

export type InvoiceStatusFilterParse =
  | { ok: true; filter: InvoiceStatus | null }
  | { ok: false; message: string }

/**
 * Parses the Orders-page invoice-status filter. An unknown value is refused
 * rather than ignored, which would return more rows than were asked for.
 */
export function parseInvoiceStatusFilter(raw: string | null | undefined): InvoiceStatusFilterParse {
  if (raw === null || raw === undefined || raw.trim() === "") return { ok: true, filter: null }
  const normalized = raw.trim().toUpperCase()
  return (INVOICE_STATUSES as readonly string[]).includes(normalized)
    ? { ok: true, filter: normalized as InvoiceStatus }
    : { ok: false, message: `invoiceStatus must be one of: ${INVOICE_STATUSES.join(", ")}` }
}

/** Reads a value the server computed back into the closed set, or null. */
export function toInvoiceStatus(value: unknown): InvoiceStatus | null {
  const normalized = normalize(value)
  return (INVOICE_STATUSES as readonly string[]).includes(normalized) ? normalized as InvoiceStatus : null
}
