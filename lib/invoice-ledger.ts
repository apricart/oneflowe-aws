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
 * Share `amount` across `weights` in proportion, in whole cents, so the shares
 * add up to `amount` exactly (largest remainder; ties to the earlier line) and
 * no share exceeds its weight. `amount` must not exceed the sum of the weights.
 */
function shareInProportion(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (amount <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map((weight) => (amount * weight) / total)
  const shares = exact.map(Math.floor)
  let left = amount - shares.reduce((sum, share) => sum + share, 0)
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of byRemainder) {
    if (left <= 0) break
    if (shares[index] < weights[index]) {
      shares[index] += 1
      left -= 1
    }
  }
  return shares
}

/**
 * The tax invoice for what was delivered: every order line less what approved
 * refunds took back from it before delivery.
 *
 * A line leaves the invoice only when refunds took all of its quantity. A
 * line delivered free of charge is a supply like any other and is listed at
 * zero (plans/OF-INVOICE-invoice-ledger.md, "Fixes after the edge-case review").
 *
 * A refund that named no lines (un-itemised, only ever a legacy import) is
 * taken off the lines in proportion to their gross, to the paisa, and each line
 * it touches is re-split on what it still charges. It used to be a discount on
 * the header that left every line's tax in place, so the invoice could state
 * more tax than it charged. `discountCents` is therefore always 0 now.
 *
 * A line untouched by refunds carries exactly the tax recorded on it at sale.
 */
export function planIssuedInvoice(input: {
  items: InvoiceSourceItem[]
  refundedByItem: Map<number, RefundedLine>
  unitemizedRefundCents: number
}): PlannedInvoice {
  assertCents(input.unitemizedRefundCents, "unitemizedRefundCents")

  const kept = input.items.flatMap((item) => {
    const fullGross = calculateLineCents(item.priceCents, item.quantity)
    const fullTax = Math.min(Math.max(Number(item.taxCents) || 0, 0), fullGross)
    const refunded = input.refundedByItem.get(item.orderItemId) ?? { quantity: 0, grossCents: 0 }
    const quantity = roundQuantity(Number(item.quantity) - Number(refunded.quantity))
    if (quantity <= 0) return []
    const grossCents = Math.max(0, fullGross - Math.round(refunded.grossCents))
    return [{ item, fullGross, fullTax, quantity, grossCents, touched: refunded.grossCents > 0 }]
  })

  const grossBefore = kept.reduce((sum, line) => sum + line.grossCents, 0)
  const shares = shareInProportion(Math.min(input.unitemizedRefundCents, grossBefore), kept.map((line) => line.grossCents))

  const lines: PlannedInvoiceLine[] = kept.map((line, index) => {
    const grossCents = line.grossCents - shares[index]
    const taxCents = line.touched || shares[index] > 0
      ? taxWithin(grossCents, line.item.taxRateBp, line.fullGross, line.fullTax)
      : line.fullTax
    return {
      lineNo: index + 1,
      orderItemId: line.item.orderItemId,
      productName: line.item.productName,
      productCode: line.item.productCode,
      unit: line.item.unit,
      category: line.item.category,
      quantity: line.quantity,
      unitPriceCents: line.item.priceCents,
      taxRateBp: line.item.taxRateBp,
      netCents: grossCents - taxCents,
      taxCents,
      grossCents,
    }
  })

  const totalCents = lines.reduce((sum, line) => sum + line.grossCents, 0)
  const netCents = lines.reduce((sum, line) => sum + line.netCents, 0)
  const taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0)
  return { lines, netCents, taxCents, discountCents: 0, totalCents }
}

/** An invoice line as it stands before a credit note: its figures, and what earlier notes credited on it. */
export type CreditedInvoiceLine = {
  grossCents: number
  taxCents: number
  creditedGrossCents: number
  creditedTaxCents: number
}

export type CreditSourceLine = {
  orderItemId: number
  invoiceLineId: number | null
  description: string
  quantity: number
  grossCents: number
  taxRateBp: number | null
  /**
   * The invoice line this credits. With it, the line's tax is credited from
   * what is left on that line, so the credits on a line add up to exactly the
   * tax it was invoiced with. Without it (a legacy invoice that has no lines),
   * the credit is split on its own.
   */
  invoiceLine?: CreditedInvoiceLine | null
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

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * The tax a credit takes from an invoice line: what the line has left, less
 * what the line would carry on the gross that remains after this credit.
 *
 * Splitting each credit on its own rounds once per note, while the line was
 * rounded once for its whole gross, so three one-unit credits of PKR 100.01 at
 * 18% would credit 45.78 of tax against 45.77 invoiced. Working from what is
 * left makes the last credit on a line take exactly the tax that remains.
 */
function creditTaxFromLine(
  grossCents: number,
  rateBp: number | null,
  line: CreditedInvoiceLine,
  creditedSoFar: { grossCents: number; taxCents: number },
): number {
  const lineGross = Math.max(0, Number(line.grossCents))
  const lineTax = clamp(Number(line.taxCents), 0, lineGross)
  const remainingGross = Math.max(0, lineGross - creditedSoFar.grossCents)
  const remainingTax = Math.max(0, lineTax - creditedSoFar.taxCents)
  const grossAfter = Math.max(0, remainingGross - grossCents)

  let taxAfter = 0
  if (grossAfter > 0) {
    taxAfter = rateBp !== null
      ? splitInclusiveCents(grossAfter, rateBp).taxCents
      : (lineGross > 0 ? Math.round((lineTax * grossAfter) / lineGross) : 0)
  }
  return clamp(remainingTax - Math.min(taxAfter, remainingTax), 0, grossCents)
}

/**
 * Move `delta` paisa of tax onto (or off) the note's lines, last line first,
 * keeping every line's tax within 0..gross. Whatever does not fit is dropped.
 */
function shiftTax(lines: PlannedCreditLine[], delta: number): void {
  let left = delta
  for (let index = lines.length - 1; index >= 0 && left !== 0; index -= 1) {
    const line = lines[index]
    const next = clamp(line.taxCents + left, 0, line.grossCents)
    left -= next - line.taxCents
    line.taxCents = next
    line.netCents = line.grossCents - next
  }
}

/**
 * A credit note for one approved refund against an issued invoice.
 *
 * Each refunded line is credited at its own rate, from what is left on the
 * invoice line it credits (`creditTaxFromLine`). Whatever the refund did not
 * itemise becomes one adjustment line, split in the invoice's own tax-to-total
 * proportion. The note may never credit more than the invoice has left.
 *
 * When the invoice's credited tax is known, the note never takes the
 * invoice's credited tax past the tax it charged, and the note that credits
 * the invoice in full takes exactly the tax left on it — so a fully credited
 * invoice nets to zero tax as well as zero total.
 */
export function planCreditNote(input: {
  refundAmountCents: number
  lines: CreditSourceLine[]
  invoice: { taxCents: number; totalCents: number; creditedTotalCents: number; creditedTaxCents?: number }
}): PlannedCreditNote {
  assertCents(input.refundAmountCents, "refundAmountCents")
  const itemizedGross = input.lines.reduce((sum, line) => sum + line.grossCents, 0)
  if (itemizedGross > input.refundAmountCents) throw new Error("CREDIT_LINES_EXCEED_REFUND")

  const proportionalTax = (gross: number) => input.invoice.totalCents > 0
    ? Math.min(gross, Math.round((input.invoice.taxCents * gross) / input.invoice.totalCents))
    : 0

  // What this note has already taken from each invoice line, should a refund
  // name the same line twice.
  const creditedByInvoiceLine = new Map<number, { grossCents: number; taxCents: number }>()

  const lines: PlannedCreditLine[] = input.lines
    .filter((line) => line.grossCents > 0)
    .map((line, index) => {
      assertCents(line.grossCents, "grossCents")
      let taxCents: number
      if (line.invoiceLine && line.invoiceLineId !== null) {
        const soFar = creditedByInvoiceLine.get(line.invoiceLineId) ?? {
          grossCents: Math.max(0, Number(line.invoiceLine.creditedGrossCents)),
          taxCents: Math.max(0, Number(line.invoiceLine.creditedTaxCents)),
        }
        taxCents = creditTaxFromLine(line.grossCents, line.taxRateBp, line.invoiceLine, soFar)
        creditedByInvoiceLine.set(line.invoiceLineId, {
          grossCents: soFar.grossCents + line.grossCents,
          taxCents: soFar.taxCents + taxCents,
        })
      } else {
        taxCents = line.taxRateBp !== null
          ? splitInclusiveCents(line.grossCents, line.taxRateBp).taxCents
          : proportionalTax(line.grossCents)
      }
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

  if (input.invoice.creditedTaxCents !== undefined) {
    const remainingTax = Math.max(0, Number(input.invoice.taxCents) - Number(input.invoice.creditedTaxCents))
    const noteTax = lines.reduce((sum, line) => sum + line.taxCents, 0)
    const completes = input.invoice.creditedTotalCents + totalCents === input.invoice.totalCents
    const target = completes ? Math.min(remainingTax, totalCents) : Math.min(noteTax, remainingTax)
    if (target !== noteTax) shiftTax(lines, target - noteTax)
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
