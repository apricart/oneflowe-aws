import "server-only"

import { and, asc, eq } from "drizzle-orm"

import { creditNoteLines, creditNotes, invoiceLines, invoices } from "@/db/schema"
import { db } from "@/lib/db"
import {
  creditNoteReference,
  frozenInvoiceDocument,
  type CreditNoteLineRecord,
  type CreditNoteRecord,
  type LedgerInvoiceLineRecord,
  type LedgerInvoiceRecord,
} from "@/lib/invoice-ledger-document"

/**
 * Reads of the invoice ledger for one order. They take the order id the caller
 * has already been authorized against (`authorizeInvoiceRequest`, or the
 * warehouse's branch reach) and add the organization it belongs to as a
 * second predicate, so a ledger row can only ever be read through its own
 * order.
 */
export type LedgerInvoice = {
  invoice: LedgerInvoiceRecord & { id: number; origin: string }
  lines: LedgerInvoiceLineRecord[]
  creditNotes: CreditNoteRecord[]
}

export async function loadLedgerInvoiceForOrder(
  order: { id: number; organizationId: number | null },
): Promise<LedgerInvoice | null> {
  if (order.organizationId === null) return null
  const [invoice] = await db.select({
    id: invoices.id,
    origin: invoices.origin,
    number: invoices.number,
    issueDate: invoices.issueDate,
    status: invoices.status,
    buyer: invoices.buyer,
    participants: invoices.participants,
    netCents: invoices.netCents,
    taxCents: invoices.taxCents,
    discountCents: invoices.discountCents,
    deliveryChargesCents: invoices.deliveryChargesCents,
    totalCents: invoices.totalCents,
  }).from(invoices)
    .where(and(eq(invoices.orderId, order.id), eq(invoices.organizationId, order.organizationId)))
    .limit(1)
  if (!invoice) return null

  const [lines, notes] = await Promise.all([
    db.select({
      productName: invoiceLines.productName,
      productCode: invoiceLines.productCode,
      unit: invoiceLines.unit,
      category: invoiceLines.category,
      quantity: invoiceLines.quantity,
      unitPriceCents: invoiceLines.unitPriceCents,
      taxRateBp: invoiceLines.taxRateBp,
      netCents: invoiceLines.netCents,
      taxCents: invoiceLines.taxCents,
      grossCents: invoiceLines.grossCents,
    }).from(invoiceLines)
      .where(and(eq(invoiceLines.invoiceId, invoice.id), eq(invoiceLines.organizationId, order.organizationId)))
      .orderBy(asc(invoiceLines.lineNo)),
    db.select({
      id: creditNotes.id,
      number: creditNotes.number,
      issueDate: creditNotes.issueDate,
      reason: creditNotes.reason,
      netCents: creditNotes.netCents,
      taxCents: creditNotes.taxCents,
      totalCents: creditNotes.totalCents,
    }).from(creditNotes)
      .where(and(eq(creditNotes.invoiceId, invoice.id), eq(creditNotes.organizationId, order.organizationId)))
      .orderBy(asc(creditNotes.id)),
  ])

  return {
    invoice: {
      ...invoice,
      buyer: invoice.buyer ?? {},
      participants: invoice.participants ?? {},
    },
    lines,
    creditNotes: notes,
  }
}

export type LedgerCreditNote = {
  creditNote: CreditNoteRecord
  lines: CreditNoteLineRecord[]
  invoice: { number: string; issueDate: string; buyer: Record<string, unknown> }
}

/** One credit note, only if it was issued against this order's invoice. */
export async function loadCreditNoteForOrder(
  order: { id: number; organizationId: number | null },
  creditNoteId: number,
): Promise<LedgerCreditNote | null> {
  if (order.organizationId === null) return null
  const [row] = await db.select({
    id: creditNotes.id,
    number: creditNotes.number,
    issueDate: creditNotes.issueDate,
    reason: creditNotes.reason,
    netCents: creditNotes.netCents,
    taxCents: creditNotes.taxCents,
    totalCents: creditNotes.totalCents,
    invoiceNumber: invoices.number,
    invoiceIssueDate: invoices.issueDate,
    buyer: invoices.buyer,
  }).from(creditNotes)
    .innerJoin(invoices, and(eq(invoices.id, creditNotes.invoiceId), eq(invoices.organizationId, creditNotes.organizationId)))
    .where(and(
      eq(creditNotes.id, creditNoteId),
      eq(creditNotes.organizationId, order.organizationId),
      eq(invoices.orderId, order.id),
    ))
    .limit(1)
  if (!row) return null

  const lines = await db.select({
    description: creditNoteLines.description,
    quantity: creditNoteLines.quantity,
    taxRateBp: creditNoteLines.taxRateBp,
    netCents: creditNoteLines.netCents,
    taxCents: creditNoteLines.taxCents,
    grossCents: creditNoteLines.grossCents,
  }).from(creditNoteLines)
    .where(and(eq(creditNoteLines.creditNoteId, row.id), eq(creditNoteLines.organizationId, order.organizationId)))
    .orderBy(asc(creditNoteLines.lineNo))

  return {
    creditNote: {
      id: row.id,
      number: row.number,
      issueDate: row.issueDate,
      reason: row.reason,
      netCents: row.netCents,
      taxCents: row.taxCents,
      totalCents: row.totalCents,
    },
    lines,
    invoice: { number: row.invoiceNumber, issueDate: row.invoiceIssueDate, buyer: row.buyer ?? {} },
  }
}

/**
 * The document an order's invoice reads as, for the preview and the PDF alike.
 *
 * An invoice issued at supply is printed from its ledger rows alone
 * (`frozenInvoiceDocument`). Anything else — a proforma, or a legacy invoice
 * copied into the ledger by the backfill — keeps the snapshot-based document
 * the caller built, exactly as it has always printed, plus the credit notes
 * issued against it since.
 */
export async function invoiceDocumentForOrder<T extends Record<string, unknown> | null>(
  order: { id: number; tid: string; organizationId: number | null; paymentStatus: string | null },
  legacyDocument: T,
): Promise<T | ReturnType<typeof frozenInvoiceDocument>> {
  const ledger = await loadLedgerInvoiceForOrder(order)
  if (!ledger) return legacyDocument
  if (ledger.invoice.origin === "ISSUED_AT_SUPPLY") {
    return frozenInvoiceDocument({
      invoice: ledger.invoice,
      lines: ledger.lines,
      order: { id: order.id, tid: order.tid, paymentStatus: order.paymentStatus },
      creditNotes: ledger.creditNotes,
    })
  }
  return legacyDocument === null
    ? legacyDocument
    : { ...legacyDocument, creditNotes: ledger.creditNotes.map(creditNoteReference) }
}
