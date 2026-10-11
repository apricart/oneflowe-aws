/**
 * The arithmetic of the invoice ledger (plans/OF-INVOICE-invoice-ledger.md),
 * kept free of any database import so every rule can be asserted directly.
 *
 * Money is integer cents throughout. Every line reconciles on its own
 * (net + tax = gross, split by `splitInclusiveCents`, the function order
 * creation uses), and every document's totals are the sums of its lines.
 */
import { calculateLineCents, roundQuantity } from "@/lib/quantity"
import { splitInclusiveCents } from "@/lib/tax"

const KARACHI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** The calendar date of an instant in Karachi, as `YYYY-MM-DD`. */
export function karachiDate(instant: Date): string {
  return KARACHI_DATE.format(instant)
}

/**
 * Whether an order already holds a number drawn before invoices were issued at
 * delivery (the transition reservation, D6). Such an order is issued with that
 * number, so a customer who saw it on the proforma never sees a second one.
 * The TID fallback written when the sequence table was missing is not a number
 * from the series, and is not honoured.
 */
export function reservedInvoiceNumber(receiptData: unknown, tid: string): string | null {
  const value = (receiptData as { invoiceNumber?: unknown } | null | undefined)?.invoiceNumber
  if (typeof value !== "string") return null
  const number = value.trim()
  if (!number || number === tid.trim()) return null
  return number.length <= 40 ? number : null
}

export type InvoiceSourceItem = {
  orderItemId: number
  productName: string
  productCode: string | null
  unit: string
  category: string | null
  quantity: number
  /** Tax-inclusive unit price the order was charged. */
  priceCents: number
  taxRateBp: number | null
  /** The tax recorded on the full line at sale time. */
  taxCents: number
}

/** What approved refunds took back from one order line before delivery. */
export type RefundedLine = { quantity: number; grossCents: number }

export type PlannedInvoiceLine = {
  lineNo: number
  orderItemId: number
  productName: string
  productCode: string | null
  unit: string
  category: string | null
  quantity: number
  unitPriceCents: number
  taxRateBp: number | null
  netCents: number
  taxCents: number
  grossCents: number
}

export type PlannedInvoice = {
  lines: PlannedInvoiceLine[]
  netCents: number
  taxCents: number
  discountCents: number
  totalCents: number
}

function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}

/**
 * Tax inside `grossCents` of a line: split at the line's own rate when it has
 * one, otherwise in the same proportion as the tax recorded on the full line.
 */
function taxWithin(grossCents: number, rateBp: number | null, fullGrossCents: number, fullTaxCents: number): number {
  if (grossCents === 0) return 0
  if (rateBp !== null) return splitInclusiveCents(grossCents, rateBp).taxCents
  if (fullGrossCents <= 0) return 0
  return Math.min(grossCents, Math.round((fullTaxCents * grossCents) / fullGrossCents))
}

/**
 * The tax invoice for what was delivered: every order line less what approved
 * refunds took back from it before delivery. A line refunded in full is not on
 * the invoice. A refund that named no lines (un-itemised) is a discount on the
 * invoice, capped at what is left to invoice.
 *
 * A line untouched by refunds carries exactly the tax recorded on it at sale.
 */
export function planIssuedInvoice(input: {
  items: InvoiceSourceItem[]
  refundedByItem: Map<number, RefundedLine>
  unitemizedRefundCents: number
}): PlannedInvoice {
  assertCents(input.unitemizedRefundCents, "unitemizedRefundCents")
  const lines: PlannedInvoiceLine[] = []

  for (const item of input.items) {
    const fullGross = calculateLineCents(item.priceCents, item.quantity)
    const fullTax = Math.min(Math.max(Number(item.taxCents) || 0, 0), fullGross)
    const refunded = input.refundedByItem.get(item.orderItemId) ?? { quantity: 0, grossCents: 0 }
    const grossCents = Math.max(0, fullGross - Math.round(refunded.grossCents))
    const quantity = roundQuantity(Number(item.quantity) - Number(refunded.quantity))
    if (grossCents === 0 || quantity <= 0) continue

    const taxCents = refunded.grossCents > 0
      ? taxWithin(grossCents, item.taxRateBp, fullGross, fullTax)
      : fullTax
    lines.push({
      lineNo: lines.length + 1,
      orderItemId: item.orderItemId,
      productName: item.productName,
      productCode: item.productCode,
      unit: item.unit,
      category: item.category,
      quantity,
      unitPriceCents: item.priceCents,
      taxRateBp: item.taxRateBp,
      netCents: grossCents - taxCents,
      taxCents,
      grossCents,
    })
  }

  const grossTotal = lines.reduce((sum, line) => sum + line.grossCents, 0)
  const netCents = lines.reduce((sum, line) => sum + line.netCents, 0)
  const taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0)
  const discountCents = Math.min(input.unitemizedRefundCents, grossTotal)
  return { lines, netCents, taxCents, discountCents, totalCents: grossTotal - discountCents }
}

export type CreditSourceLine = {
  orderItemId: number
  invoiceLineId: number | null
  description: string
  quantity: number
  grossCents: number
  taxRateBp: number | null
}

export type PlannedCreditLine = {
  lineNo: number
  orderItemId: number | null
  invoiceLineId: number | null
  description: string
  quantity: number | null
  taxRateBp: number | null
  netCents: number
  taxCents: number
  grossCents: number
}

export type PlannedCreditNote = {
  lines: PlannedCreditLine[]
  netCents: number
  taxCents: number
  totalCents: number
}

export const UNITEMIZED_CREDIT_DESCRIPTION = "Adjustment"

/**
 * A credit note for one approved refund against an issued invoice.
 *
 * Each refunded line is split at its own rate. Whatever the refund did not
 * itemise becomes one adjustment line, split in the invoice's own tax-to-total
 * proportion. The note may never credit more than the invoice has left.
 */
export function planCreditNote(input: {
  refundAmountCents: number
  lines: CreditSourceLine[]
  invoice: { taxCents: number; totalCents: number; creditedTotalCents: number }
}): PlannedCreditNote {
  assertCents(input.refundAmountCents, "refundAmountCents")
  const itemizedGross = input.lines.reduce((sum, line) => sum + line.grossCents, 0)
  if (itemizedGross > input.refundAmountCents) throw new Error("CREDIT_LINES_EXCEED_REFUND")

  const proportionalTax = (gross: number) => input.invoice.totalCents > 0
    ? Math.min(gross, Math.round((input.invoice.taxCents * gross) / input.invoice.totalCents))
    : 0

  const lines: PlannedCreditLine[] = input.lines
    .filter((line) => line.grossCents > 0)
    .map((line, index) => {
      assertCents(line.grossCents, "grossCents")
      const taxCents = line.taxRateBp !== null
        ? splitInclusiveCents(line.grossCents, line.taxRateBp).taxCents
        : proportionalTax(line.grossCents)
      return {
        lineNo: index + 1,
        orderItemId: line.orderItemId,
        invoiceLineId: line.invoiceLineId,
        description: line.description,
        quantity: line.quantity > 0 ? roundQuantity(line.quantity) : null,
        taxRateBp: line.taxRateBp,
        netCents: line.grossCents - taxCents,
        taxCents,
        grossCents: line.grossCents,
      }
    })

  const unitemized = input.refundAmountCents - itemizedGross
  if (unitemized > 0) {
    const taxCents = proportionalTax(unitemized)
    lines.push({
      lineNo: lines.length + 1,
      orderItemId: null,
      invoiceLineId: null,
      description: UNITEMIZED_CREDIT_DESCRIPTION,
      quantity: null,
      taxRateBp: null,
      netCents: unitemized - taxCents,
      taxCents,
      grossCents: unitemized,
    })
  }

  const totalCents = lines.reduce((sum, line) => sum + line.grossCents, 0)
  if (totalCents <= 0) throw new Error("CREDIT_NOTE_EMPTY")
  if (input.invoice.creditedTotalCents + totalCents > input.invoice.totalCents) {
    throw new Error("CREDIT_EXCEEDS_INVOICE")
  }
  return {
    lines,
    netCents: lines.reduce((sum, line) => sum + line.netCents, 0),
    taxCents: lines.reduce((sum, line) => sum + line.taxCents, 0),
    totalCents,
  }
}

/** An invoice's status once `creditedTotalCents` of its `totalCents` has been credited. */
export function invoiceStatusAfterCredit(totalCents: number, creditedTotalCents: number): "ISSUED" | "PARTIALLY_CREDITED" | "CREDITED" {
  if (creditedTotalCents <= 0) return "ISSUED"
  return creditedTotalCents >= totalCents ? "CREDITED" : "PARTIALLY_CREDITED"
}

/**
 * The tax part of a refund approved before delivery, when no credit note is
 * issued: each itemised line split at its rate, the rest in the order's own
 * tax-to-total proportion. Recorded on `refunds.tax_refund_cents`.
 */
export function refundTaxCents(input: {
  refundAmountCents: number
  lines: Array<{ grossCents: number; taxRateBp: number | null }>
  order: { taxCents: number; totalCents: number }
}): number {
  const proportional = (gross: number) => input.order.totalCents > 0
    ? Math.min(gross, Math.round((input.order.taxCents * gross) / input.order.totalCents))
    : 0
  let itemized = 0
  let tax = 0
  for (const line of input.lines) {
    if (line.grossCents <= 0) continue
    itemized += line.grossCents
    tax += line.taxRateBp !== null ? splitInclusiveCents(line.grossCents, line.taxRateBp).taxCents : proportional(line.grossCents)
  }
  const rest = Math.max(0, input.refundAmountCents - itemized)
  return Math.min(input.refundAmountCents, tax + proportional(rest))
}

/**
 * The printed date of a legacy snapshot (`MM/DD/YYYY`) as `YYYY-MM-DD`, or
 * null when it is not in that shape or not a real date.
 */
export function legacyPrintedDate(value: unknown): string | null {
  if (typeof value !== "string") return null
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, month, day, year] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}
