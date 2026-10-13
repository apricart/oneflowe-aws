/**
 * Turning ledger records into the document the invoice template prints
 * (plans/OF-INVOICE-invoice-ledger.md, D4). Pure, so the shape is asserted
 * directly; the screen and the PDF both render what this returns.
 *
 * A tax invoice issued at supply is printed from its own rows and nothing
 * else: no live branch address, NTN, order status or refund reaches it, so
 * every reprint is the document that was issued. The only things that move are
 * outside its body — the PAID stamp, its invoice status, and the list of credit
 * notes issued against it.
 */
import {
  INVOICE_STATUS_LABELS,
  isTaxInvoiceStatus,
  toInvoiceStatus,
  type InvoiceStatus,
} from "@/lib/invoice-status"

export const PROFORMA_NOTE = "Proforma only. Not a tax invoice: the tax invoice is issued when the order is processed."
export const CREDIT_NOTE_TITLE = "CREDIT NOTE"

export type LedgerInvoiceRecord = {
  number: string
  issueDate: string
  status: string
  buyer: Record<string, unknown>
  participants: Record<string, unknown>
  netCents: number
  taxCents: number
  discountCents: number
  deliveryChargesCents: number
  totalCents: number
}

export type LedgerInvoiceLineRecord = {
  productName: string
  productCode?: string | null
  unit: string
  category?: string | null
  quantity: number
  unitPriceCents: number
  taxRateBp: number | null
  netCents: number
  taxCents: number
  grossCents: number
}

export type CreditNoteSummary = {
  id: number
  number: string
  issueDate: string
  totalCents: number
  reason: string | null
}

export type CreditNoteRecord = CreditNoteSummary & {
  netCents: number
  taxCents: number
}

export type CreditNoteLineRecord = {
  description: string
  quantity: number | null
  taxRateBp: number | null
  netCents: number
  taxCents: number
  grossCents: number
}

const money = (cents: number) => Math.round(Number(cents)) / 100
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

/** One printable line in the snapshot shape `buildInvoiceLines` reads. */
function printableLine(input: {
  description: string
  quantity: number
  unit: string
  grossCents: number
  netCents: number
  taxCents: number
  taxRateBp: number | null
}) {
  const quantity = Number(input.quantity) > 0 ? Number(input.quantity) : 1
  return {
    description: input.description,
    quantity,
    unit: input.unit,
    rate: money(input.grossCents) / quantity,
    total: money(input.grossCents),
    netRate: money(input.netCents) / quantity,
    netAmount: money(input.netCents),
    tax: money(input.taxCents),
    ...(input.taxRateBp === null ? {} : { taxPercent: input.taxRateBp / 100 }),
  }
}

function asItems(lines: ReturnType<typeof printableLine>[]) {
  return [{ mainCategoryName: "Items", subCategories: [{ subCategoryName: "", items: lines }] }]
}

/** The buyer, as frozen on the document. */
function buyerFields(buyer: Record<string, unknown>) {
  return {
    buyerName: text(buyer.buyerName) ?? text(buyer.branchName) ?? "",
    buyerAddress: text(buyer.buyerAddress) ?? "",
    deliveryAddressLabel: text(buyer.deliveryAddressLabel),
    organizationName: text(buyer.organizationName) ?? "",
    organizationNtn: text(buyer.ntn),
    organizationStrn: text(buyer.strn),
  }
}

/**
 * A tax invoice issued at supply, as the template prints it. `paymentStatus`
 * and `creditNotes` are the live parts; everything else is the issued record.
 */
export function frozenInvoiceDocument(input: {
  invoice: LedgerInvoiceRecord
  lines: LedgerInvoiceLineRecord[]
  order: { id: number; tid: string; paymentStatus: string | null }
  creditNotes: CreditNoteSummary[]
}) {
  const { invoice } = input
  const status: InvoiceStatus = toInvoiceStatus(invoice.status) ?? "ISSUED"
  return {
    frozen: true,
    invoiceNumber: invoice.number,
    date: invoice.issueDate,
    orderId: input.order.id,
    orderTid: input.order.tid,
    paymentStatus: input.order.paymentStatus,
    ...buyerFields(invoice.buyer),
    poNumber: text(invoice.buyer.poNumber),
    placedByName: text(invoice.participants.placedByName) ?? "N/A",
    placedByPhone: text(invoice.participants.placedByPhone) ?? null,
    approvedByName: text(invoice.participants.approvedByName) ?? "N/A",
    items: asItems(input.lines.map((line) => printableLine({
      description: line.productName,
      quantity: line.quantity,
      unit: line.unit,
      grossCents: line.grossCents,
      netCents: line.netCents,
      taxCents: line.taxCents,
      taxRateBp: line.taxRateBp,
    }))),
    subtotal: money(invoice.netCents),
    tax: money(invoice.taxCents),
    discount: money(invoice.discountCents),
    deliveryCharges: money(invoice.deliveryChargesCents),
    refund: 0,
    refundedItems: [],
    totalAmount: money(invoice.totalCents),
    invoiceStatus: status,
    invoiceStatusLabel: INVOICE_STATUS_LABELS[status],
    documentTitle: "INVOICE" as const,
    creditNotes: input.creditNotes.map(creditNoteReference),
  }
}

/** How a credit note is listed against its invoice. */
export function creditNoteReference(note: CreditNoteSummary) {
  return { id: note.id, number: note.number, date: note.issueDate, total: money(note.totalCents) }
}

/** A credit note, as the template prints it. */
export function creditNoteDocument(input: {
  creditNote: CreditNoteRecord
  lines: CreditNoteLineRecord[]
  invoice: { number: string; issueDate: string; buyer: Record<string, unknown> }
  order: { id: number; tid: string }
}) {
  const { creditNote } = input
  return {
    frozen: true,
    documentKind: "CREDIT_NOTE" as const,
    documentTitle: CREDIT_NOTE_TITLE,
    invoiceNumber: creditNote.number,
    date: creditNote.issueDate,
    orderId: input.order.id,
    orderTid: input.order.tid,
    creditNote: {
      number: creditNote.number,
      date: creditNote.issueDate,
      invoiceNumber: input.invoice.number,
      invoiceDate: input.invoice.issueDate,
      reason: creditNote.reason ?? "",
    },
    ...buyerFields(input.invoice.buyer),
    items: asItems(input.lines.map((line) => printableLine({
      description: line.description,
      quantity: line.quantity ?? 1,
      unit: "",
      grossCents: line.grossCents,
      netCents: line.netCents,
      taxCents: line.taxCents,
      taxRateBp: line.taxRateBp,
    }))),
    subtotal: money(creditNote.netCents),
    tax: money(creditNote.taxCents),
    discount: 0,
    deliveryCharges: 0,
    refund: 0,
    refundedItems: [],
    totalAmount: money(creditNote.totalCents),
  }
}

/**
 * The invoice number as a document shows it. A proforma has no tax invoice
 * number of its own: it shows the number reserved for it (drawn when the order
 * was placed, before the ledger) or says when one will be issued — when the
 * order is processed (plans/OF-INVOICE-issue-at-processing.md).
 */
export function displayedInvoiceNumber(receiptData: unknown): string {
  const data = (receiptData ?? {}) as { invoiceNumber?: unknown; invoiceStatus?: unknown }
  const number = text(data.invoiceNumber)
  const status = toInvoiceStatus(data.invoiceStatus)
  if (status === null || isTaxInvoiceStatus(status)) return number ?? "N/A"
  if (status === "PROFORMA_AVAILABLE") return number ? `${number} (when processed)` : "Issued when processed"
  return number ? `${number} (not issued)` : "Not issued"
}

/** Whether a document is a proforma, which then carries `PROFORMA_NOTE`. */
export function isProformaDocument(receiptData: unknown): boolean {
  const status = toInvoiceStatus((receiptData as { invoiceStatus?: unknown } | null)?.invoiceStatus)
  return status !== null && !isTaxInvoiceStatus(status)
}
