import { describe, expect, it } from "vitest"

import { buildConsolidatedInvoiceRow, type ConsolidatedInvoiceSource } from "./consolidated-invoice"
import {
  invoiceStatusAfterCredit,
  karachiDate,
  planCreditNote,
  planIssuedInvoice,
  refundTaxCents,
  reservedInvoiceNumber,
  type CreditSourceLine,
  type InvoiceSourceItem,
  type PlannedCreditNote,
  type RefundedLine,
} from "./invoice-ledger"
import { deriveInvoiceStatus } from "./invoice-status"
import { isPendingInvoiceOrder } from "./pending-invoice"
import { calculateLineCents } from "./quantity"
import { refundLineAmountCents } from "./refund-amount"
import { isUnpaidInvoiceOrder, orderStillOwes } from "./unpaid-invoice-block"
import { splitInclusiveCents } from "./tax"

/**
 * Edge cases of the invoice ledger's arithmetic (plans/OF-INVOICE-invoice-ledger.md)
 * beyond the worked examples in invoice-ledger.test.ts: rounding across
 * several documents, boundaries, and invariants checked over many inputs.
 *
 * Every defect these tests found has been fixed; the comments above each say
 * what used to happen (plans/OF-INVOICE-invoice-ledger.md, "Fixes after the
 * edge-case review").
 */

/** A line as order creation writes it: tax = the inclusive split of the line's gross. */
function line(overrides: Partial<InvoiceSourceItem> & { priceCents: number; quantity: number }): InvoiceSourceItem {
  const taxRateBp = overrides.taxRateBp === undefined ? 1_800 : overrides.taxRateBp
  const gross = calculateLineCents(overrides.priceCents, overrides.quantity)
  return {
    orderItemId: 1,
    productName: "Tea",
    productCode: null,
    unit: "pcs",
    category: null,
    taxCents: taxRateBp === null ? 0 : splitInclusiveCents(gross, taxRateBp).taxCents,
    ...overrides,
    taxRateBp,
  }
}

const noRefunds = () => new Map<number, RefundedLine>()

/** Deterministic pseudo-random numbers, so a failing case can be reproduced. */
function seeded(seed: number) {
  let state = seed >>> 0
  return (max: number) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % max
  }
}

/**
 * Credit an issued invoice note by note, the way lib/server/credit-notes.ts
 * does: each note is told what earlier notes credited on every invoice line,
 * and on the invoice as a whole.
 */
function creditInSequence(
  invoice: ReturnType<typeof planIssuedInvoice>,
  refunds: Array<Array<{ lineNo: number; grossCents: number }>>,
) {
  const creditedByLine = new Map<number, { grossCents: number; taxCents: number }>()
  let creditedTotalCents = 0
  let creditedTaxCents = 0
  const notes: PlannedCreditNote[] = []
  for (const refund of refunds) {
    const lines: CreditSourceLine[] = refund.map(({ lineNo, grossCents }) => {
      const invoiceLine = invoice.lines[lineNo - 1]
      const credited = creditedByLine.get(lineNo) ?? { grossCents: 0, taxCents: 0 }
      return {
        orderItemId: invoiceLine.orderItemId,
        invoiceLineId: lineNo,
        description: invoiceLine.productName,
        quantity: 1,
        grossCents,
        taxRateBp: invoiceLine.taxRateBp,
        invoiceLine: {
          grossCents: invoiceLine.grossCents,
          taxCents: invoiceLine.taxCents,
          creditedGrossCents: credited.grossCents,
          creditedTaxCents: credited.taxCents,
        },
      }
    })
    const note = planCreditNote({
      refundAmountCents: refund.reduce((sum, line) => sum + line.grossCents, 0),
      lines,
      invoice: { taxCents: invoice.taxCents, totalCents: invoice.totalCents, creditedTotalCents, creditedTaxCents },
    })
    note.lines.forEach((planned) => {
      const lineNo = Number(planned.invoiceLineId)
      const credited = creditedByLine.get(lineNo) ?? { grossCents: 0, taxCents: 0 }
      creditedByLine.set(lineNo, { grossCents: credited.grossCents + planned.grossCents, taxCents: credited.taxCents + planned.taxCents })
    })
    creditedTotalCents += note.totalCents
    creditedTaxCents += note.taxCents
    notes.push(note)
  }
  return { notes, creditedTotalCents, creditedTaxCents, creditedByLine }
}

/**
 * Cut every invoice line into random pieces and group them into refunds, each
 * naming a line at most once (as the refund routes require). Together the
 * refunds credit the whole invoice.
 */
function cutIntoRefunds(invoice: ReturnType<typeof planIssuedInvoice>, random: (max: number) => number) {
  const pieces: Array<{ lineNo: number; grossCents: number }> = []
  for (const invoiceLine of invoice.lines) {
    let left = invoiceLine.grossCents
    while (left > 0) {
      const piece = left === 1 ? 1 : 1 + random(left)
      pieces.push({ lineNo: invoiceLine.lineNo, grossCents: piece })
      left -= piece
    }
  }
  const refunds: Array<Array<{ lineNo: number; grossCents: number }>> = []
  while (pieces.length > 0) {
    const merged = new Map<number, number>()
    for (const piece of pieces.splice(0, 1 + random(3))) {
      merged.set(piece.lineNo, (merged.get(piece.lineNo) ?? 0) + piece.grossCents)
    }
    refunds.push([...merged].map(([lineNo, grossCents]) => ({ lineNo, grossCents })))
  }
  return refunds
}

describe("planIssuedInvoice — invariants over many orders", () => {
  it("every line reconciles, and the totals are the sums of the lines", () => {
    const random = seeded(42)
    for (let n = 0; n < 500; n += 1) {
      const items = Array.from({ length: 1 + random(5) }, (_, index) => line({
        orderItemId: index + 1,
        priceCents: 1 + random(500_000),
        quantity: 1 + random(20),
        taxRateBp: [0, 500, 1_700, 1_800, null][random(5)] as number | null,
      }))
      const plan = planIssuedInvoice({ items, refundedByItem: noRefunds(), unitemizedRefundCents: 0 })

      for (const planned of plan.lines) {
        expect(planned.netCents + planned.taxCents).toBe(planned.grossCents)
        expect(planned.netCents).toBeGreaterThanOrEqual(0)
        expect(planned.taxCents).toBeGreaterThanOrEqual(0)
      }
      expect(plan.lines.map((planned) => planned.lineNo)).toEqual(plan.lines.map((_, index) => index + 1))
      expect(plan.netCents + plan.taxCents - plan.discountCents).toBe(plan.totalCents)
      // With nothing refunded, the invoice is exactly what the order charged and recorded.
      expect(plan.totalCents).toBe(items.reduce((sum, item) => sum + calculateLineCents(item.priceCents, item.quantity), 0))
      expect(plan.taxCents).toBe(items.reduce((sum, item) => sum + item.taxCents, 0))
    }
  })

  it("never invoices more than the order charged less what was refunded", () => {
    const random = seeded(7)
    for (let n = 0; n < 500; n += 1) {
      const items = Array.from({ length: 1 + random(4) }, (_, index) => line({
        orderItemId: index + 1,
        priceCents: 100 + random(50_000),
        quantity: 2 + random(6),
      }))
      const refundedByItem = new Map<number, RefundedLine>()
      for (const item of items) {
        const quantity = random(item.quantity + 1)
        if (quantity > 0) refundedByItem.set(item.orderItemId, { quantity, grossCents: calculateLineCents(item.priceCents, quantity) })
      }
      const charged = items.reduce((sum, item) => sum + calculateLineCents(item.priceCents, item.quantity), 0)
      const refunded = [...refundedByItem.values()].reduce((sum, refund) => sum + refund.grossCents, 0)

      const plan = planIssuedInvoice({ items, refundedByItem, unitemizedRefundCents: 0 })
      expect(plan.totalCents).toBe(charged - refunded)
    }
  })

  it("caps an un-itemised refund at what is left, leaving the delivered line at zero", () => {
    const plan = planIssuedInvoice({
      items: [line({ priceCents: 1_180, quantity: 1 })],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 5_000,
    })
    expect(plan).toMatchObject({ discountCents: 0, totalCents: 0, taxCents: 0 })
    expect(plan.lines.map((planned) => [planned.quantity, planned.grossCents])).toEqual([[1, 0]])
  })

  it("leaves a zero-rated line without tax", () => {
    const plan = planIssuedInvoice({
      items: [line({ priceCents: 999, quantity: 3, taxRateBp: 0 })],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines[0]).toMatchObject({ netCents: 2_997, taxCents: 0, grossCents: 2_997 })
  })

  // A line used to be dropped whenever its gross was 0, so a free item that was
  // delivered never appeared on the tax invoice, and an order made only of free
  // items got no invoice while its status read "Issued". A line now leaves the
  // invoice only when refunds took all of its quantity.
  it("lists a zero-priced line that was delivered", () => {
    const plan = planIssuedInvoice({
      items: [
        line({ orderItemId: 1, priceCents: 1_180, quantity: 1 }),
        line({ orderItemId: 2, productName: "Free sample", priceCents: 0, quantity: 2 }),
      ],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines.map((planned) => planned.productName)).toContain("Free sample")
    expect(plan.lines.find((planned) => planned.productName === "Free sample")).toMatchObject({ quantity: 2, grossCents: 0, taxCents: 0, netCents: 0 })
  })

  it("invoices an order made only of free items, at zero", () => {
    const plan = planIssuedInvoice({
      items: [line({ priceCents: 0, quantity: 3 })],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines).toHaveLength(1)
    expect(plan).toMatchObject({ totalCents: 0, netCents: 0, taxCents: 0 })
  })

  // Refunds were priced round(price × qty) each, so three refunds of 0.1 at
  // 103 paisa took 10 + 10 + 10 = 30 of a line that charged 31, and the paisa
  // left was on no invoice and in no refund. The refund that takes a line's
  // last units now gives back what is left (lib/refund-amount.ts).
  it("every paisa a line charged is either refunded or invoiced", () => {
    const random = seeded(31)
    for (let n = 0; n < 300; n += 1) {
      const priceCents = 1 + random(50_000)
      const tenths = 2 + random(30)
      const item = line({ priceCents, quantity: tenths / 10 })
      // Refund some tenths before delivery, one refund at a time.
      let already = { quantity: 0, amountCents: 0 }
      for (let refunded = 0, count = random(tenths + 1); refunded < count; refunded += 1) {
        const amount = refundLineAmountCents({ priceCents, lineQuantity: item.quantity, already, refundQuantity: 0.1 })
        already = { quantity: already.quantity + 0.1, amountCents: already.amountCents + amount }
      }
      const plan = planIssuedInvoice({
        items: [item],
        refundedByItem: new Map([[1, { quantity: already.quantity, grossCents: already.amountCents }]]),
        unitemizedRefundCents: 0,
      })
      expect(plan.totalCents + already.amountCents).toBe(calculateLineCents(priceCents, item.quantity))
    }
  })

  // An un-itemised refund before delivery (legacy imports only) used to become
  // a header discount that kept every line's tax, so the invoice could state
  // more tax than it charged. It is now taken off the lines, which are re-split.
  it("never states more tax than the invoice charges", () => {
    const plan = planIssuedInvoice({
      items: [line({ priceCents: 10_000, quantity: 1 })],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 9_500,
    })
    expect(plan.totalCents).toBe(500)
    expect(plan.taxCents).toBeLessThanOrEqual(plan.totalCents)
  })

  // Seen from the refund: the tax recorded on it (`refunds.tax_refund_cents`,
  // from refundTaxCents) and the tax left on the invoice add back to the
  // order's tax, instead of the refund's tax being counted twice.
  it("the tax refunded before delivery and the tax invoiced add up to the order's tax", () => {
    const item = line({ priceCents: 10_000, quantity: 1 })
    const refundTax = refundTaxCents({ refundAmountCents: 4_000, lines: [], order: { taxCents: item.taxCents, totalCents: 10_000 } })
    const plan = planIssuedInvoice({ items: [item], refundedByItem: noRefunds(), unitemizedRefundCents: 4_000 })
    expect(plan.taxCents + refundTax).toBe(item.taxCents)
  })
})

describe("an un-itemised refund before delivery, over many orders", () => {
  it("is taken off the lines to the paisa, never past a line, and never leaves more tax than charge", () => {
    const random = seeded(77)
    for (let n = 0; n < 500; n += 1) {
      const items = Array.from({ length: 1 + random(5) }, (_, index) => line({
        orderItemId: index + 1,
        priceCents: random(80_000),
        quantity: 1 + random(6),
        taxRateBp: [0, 1_700, 1_800, null][random(4)] as number | null,
      }))
      const charged = items.reduce((sum, item) => sum + calculateLineCents(item.priceCents, item.quantity), 0)
      const unitemized = random(charged + 2)
      const plan = planIssuedInvoice({ items, refundedByItem: noRefunds(), unitemizedRefundCents: unitemized })

      expect(plan.discountCents).toBe(0)
      expect(plan.totalCents).toBe(Math.max(0, charged - unitemized))
      expect(plan.taxCents).toBeLessThanOrEqual(plan.totalCents)
      expect(plan.lines).toHaveLength(items.length)
      plan.lines.forEach((planned, index) => {
        expect(planned.grossCents).toBeLessThanOrEqual(calculateLineCents(items[index].priceCents, items[index].quantity))
        expect(planned.netCents + planned.taxCents).toBe(planned.grossCents)
        expect(planned.taxCents).toBeGreaterThanOrEqual(0)
      })
    }
  })

  it("takes from each line in proportion to what it charged", () => {
    const plan = planIssuedInvoice({
      items: [
        line({ orderItemId: 1, priceCents: 3_000, quantity: 1 }),
        line({ orderItemId: 2, priceCents: 1_000, quantity: 1 }),
      ],
      refundedByItem: noRefunds(),
      unitemizedRefundCents: 1_001,
    })
    expect(plan.lines.map((planned) => planned.grossCents)).toEqual([2_249, 750])
  })
})

describe("an invoice with nothing left to pay is not unpaid", () => {
  const delivered = { status: "FULFILLED", fulfillmentStatus: "DELIVERED", paymentStatus: "UNPAID", receiptData: {}, ledgerStatus: "ISSUED" }

  it("a free order's zero invoice raises no notice and blocks no ordering", () => {
    expect(orderStillOwes({ totalCents: 0, refundAmountCents: 0 })).toBe(false)
    expect(isPendingInvoiceOrder({ ...delivered, totalCents: 0 })).toBe(false)
    expect(isUnpaidInvoiceOrder({ ...delivered, totalCents: 0 })).toBe(false)
  })

  it("an invoice with money left on it still does", () => {
    expect(orderStillOwes({ totalCents: 2_360, refundAmountCents: 1_180 })).toBe(true)
    expect(isPendingInvoiceOrder({ ...delivered, totalCents: 2_360 })).toBe(true)
    expect(isUnpaidInvoiceOrder({ ...delivered, totalCents: 2_360 })).toBe(true)
  })

  it("an order read without its total is not judged on it", () => {
    expect(orderStillOwes({})).toBe(true)
  })
})

describe("planCreditNote — invariants over many refunds", () => {
  it("credits exactly the refund, every line reconciles, and over-crediting is refused at the boundary", () => {
    const random = seeded(99)
    for (let n = 0; n < 500; n += 1) {
      const totalCents = 1_000 + random(1_000_000)
      const taxCents = random(Math.floor(totalCents / 2))
      const creditedTotalCents = random(totalCents)
      const left = totalCents - creditedTotalCents
      const refundAmountCents = 1 + random(left)
      const itemized = random(refundAmountCents + 1)
      const lines = itemized > 0
        ? [{ orderItemId: 1, invoiceLineId: 1, description: "Tea", quantity: 1, grossCents: itemized, taxRateBp: [1_800, 0, null][random(3)] as number | null }]
        : []

      const plan = planCreditNote({ refundAmountCents, lines, invoice: { taxCents, totalCents, creditedTotalCents } })
      expect(plan.totalCents).toBe(refundAmountCents)
      expect(plan.netCents + plan.taxCents).toBe(plan.totalCents)
      for (const planned of plan.lines) {
        expect(planned.netCents + planned.taxCents).toBe(planned.grossCents)
        expect(planned.taxCents).toBeGreaterThanOrEqual(0)
        expect(planned.netCents).toBeGreaterThanOrEqual(0)
      }

      // Exactly what is left may be credited; one paisa more may not.
      expect(() => planCreditNote({ refundAmountCents: left, lines: [], invoice: { taxCents, totalCents, creditedTotalCents } })).not.toThrow()
      expect(() => planCreditNote({ refundAmountCents: left + 1, lines: [], invoice: { taxCents, totalCents, creditedTotalCents } }))
        .toThrow("CREDIT_EXCEEDS_INVOICE")
    }
  })

  it("refuses lines that add up to more than the refund", () => {
    expect(() => planCreditNote({
      refundAmountCents: 1_000,
      lines: [{ orderItemId: 1, invoiceLineId: 1, description: "Tea", quantity: 1, grossCents: 1_001, taxRateBp: 1_800 }],
      invoice: { taxCents: 900, totalCents: 5_900, creditedTotalCents: 0 },
    })).toThrow("CREDIT_LINES_EXCEED_REFUND")
  })

  it("splits each line of a mixed-rate refund at its own rate", () => {
    const plan = planCreditNote({
      refundAmountCents: 1_180 + 1_050,
      lines: [
        { orderItemId: 1, invoiceLineId: 1, description: "Standard", quantity: 1, grossCents: 1_180, taxRateBp: 1_800 },
        { orderItemId: 2, invoiceLineId: 2, description: "Reduced", quantity: 1, grossCents: 1_050, taxRateBp: 500 },
      ],
      invoice: { taxCents: 230, totalCents: 2_230, creditedTotalCents: 0 },
    })
    expect(plan.lines.map((planned) => [planned.description, planned.netCents, planned.taxCents])).toEqual([
      ["Standard", 1_000, 180],
      ["Reduced", 1_000, 50],
    ])
  })

  // Each credit note used to split its own gross (rounded per document) while
  // the invoice line was split once over the whole line: PKR 100.01 × 3
  // refunded a unit at a time credited 45.78 of tax against 45.77 invoiced.
  // A credit now takes the line's tax from what is left on the line.
  it("crediting a line in several refunds credits exactly the tax that was invoiced on it", () => {
    const invoice = planIssuedInvoice({ items: [line({ priceCents: 10_001, quantity: 3 })], refundedByItem: noRefunds(), unitemizedRefundCents: 0 })
    const unit = { lineNo: 1, grossCents: 10_001 }
    const { notes, creditedTotalCents, creditedTaxCents } = creditInSequence(invoice, [[unit], [unit], [unit]])

    expect(creditedTotalCents).toBe(invoice.totalCents)
    expect(creditedTaxCents).toBe(invoice.taxCents)
    expect(notes.map((note) => note.taxCents)).toEqual([1_526, 1_525, 1_526])
    // Each note on its own is still within a paisa of a fresh split of its gross.
    for (const note of notes) {
      expect(Math.abs(note.taxCents - splitInclusiveCents(10_001, 1_800).taxCents)).toBeLessThanOrEqual(1)
    }
  })

  it("credits every line to exactly its invoiced tax, however the refunds are cut", () => {
    const random = seeded(2026)
    for (let n = 0; n < 300; n += 1) {
      const items = Array.from({ length: 1 + random(3) }, (_, index) => line({
        orderItemId: index + 1,
        priceCents: 1 + random(200_000),
        quantity: 1 + random(9),
        taxRateBp: [500, 1_700, 1_800, 0][random(4)],
      }))
      const invoice = planIssuedInvoice({ items, refundedByItem: noRefunds(), unitemizedRefundCents: 0 })

      const { notes, creditedTotalCents, creditedTaxCents, creditedByLine } = creditInSequence(invoice, cutIntoRefunds(invoice, random))
      expect(creditedTotalCents).toBe(invoice.totalCents)
      expect(creditedTaxCents).toBe(invoice.taxCents)
      for (const invoiceLine of invoice.lines) {
        expect(creditedByLine.get(invoiceLine.lineNo)).toEqual({ grossCents: invoiceLine.grossCents, taxCents: invoiceLine.taxCents })
      }
      for (const note of notes) {
        for (const planned of note.lines) {
          expect(planned.taxCents).toBeGreaterThanOrEqual(0)
          expect(planned.taxCents).toBeLessThanOrEqual(planned.grossCents)
          expect(planned.netCents + planned.taxCents).toBe(planned.grossCents)
        }
      }
    }
  })

  it("never takes the invoice's credited tax past the tax it charged", () => {
    // A legacy invoice with no lines, credited by an un-itemised refund at the
    // invoice's own proportion, from a starting point already near its tax.
    const note = planCreditNote({
      refundAmountCents: 1_000,
      lines: [],
      invoice: { taxCents: 900, totalCents: 5_900, creditedTotalCents: 4_000, creditedTaxCents: 850 },
    })
    expect(note.taxCents).toBe(50)
    expect(note.netCents + note.taxCents).toBe(1_000)
  })

  it("the note that credits a legacy invoice in full takes exactly the tax left on it", () => {
    const note = planCreditNote({
      refundAmountCents: 1_900,
      lines: [],
      invoice: { taxCents: 900, totalCents: 5_900, creditedTotalCents: 4_000, creditedTaxCents: 611 },
    })
    expect(note.taxCents).toBe(289)
  })

  it("without the invoice's credited tax, splits each credit on its own as before", () => {
    const note = planCreditNote({
      refundAmountCents: 10_001,
      lines: [{ orderItemId: 1, invoiceLineId: 1, description: "Tea", quantity: 1, grossCents: 10_001, taxRateBp: 1_800 }],
      invoice: { taxCents: 4_577, totalCents: 30_003, creditedTotalCents: 20_002 },
    })
    expect(note.taxCents).toBe(splitInclusiveCents(10_001, 1_800).taxCents)
  })

  it("the rounding drift a per-note split would cause is common, not a corner case", () => {
    // How many prices between PKR 100 and PKR 200, bought three at a time and
    // refunded one at a time, credit a tax different from the one invoiced.
    let drifting = 0
    for (let priceCents = 10_000; priceCents < 20_000; priceCents += 1) {
      const invoiced = splitInclusiveCents(priceCents * 3, 1_800).taxCents
      const credited = 3 * splitInclusiveCents(priceCents, 1_800).taxCents
      if (invoiced !== credited) drifting += 1
    }
    expect(drifting).toBeGreaterThan(5_000)
  })
})

describe("the consolidated report on a fully credited invoice", () => {
  const source = (overrides: Partial<ConsolidatedInvoiceSource>): ConsolidatedInvoiceSource => ({
    orderId: 1,
    invoiceNumber: "UBL-APR-000001",
    date: "2026-10-11",
    orderStatus: "REFUNDED",
    refundAmountCents: 30_003,
    invoiceStatus: "CREDITED",
    paymentStatus: "PAID",
    department: "Alpha",
    approver: "Approver",
    costCenterId: null,
    quantity: 3,
    creditedQuantity: 3,
    taxRatesBp: [1_800],
    netCents: 25_426,
    taxCents: 4_577,
    totalCents: 30_003,
    creditedNetCents: 0,
    creditedTaxCents: 0,
    creditedTotalCents: 30_003,
    ...overrides,
  })

  it("reconciles when the credit notes credited exactly the invoiced tax", () => {
    const row = buildConsolidatedInvoiceRow("invoices", source({ creditedNetCents: 25_426, creditedTaxCents: 4_577 }), 1)
    expect([row.valueExclTaxCents, row.taxCents, row.totalCents]).toEqual([0, 0, 0])
  })

  // With per-note splitting, PKR 100.01 × 3 refunded one at a time credited
  // 254.25 net / 45.78 tax, and the row printed Value 0.01, Tax 0.00, Total
  // 0.00. With the credits the ledger now writes, it adds up.
  it("a fully credited invoice's row adds up", () => {
    const invoice = planIssuedInvoice({ items: [line({ priceCents: 10_001, quantity: 3 })], refundedByItem: noRefunds(), unitemizedRefundCents: 0 })
    const unit = { lineNo: 1, grossCents: 10_001 }
    const { creditedTotalCents, creditedTaxCents } = creditInSequence(invoice, [[unit], [unit], [unit]])
    const row = buildConsolidatedInvoiceRow("invoices", source({
      netCents: invoice.netCents,
      taxCents: invoice.taxCents,
      totalCents: invoice.totalCents,
      creditedNetCents: creditedTotalCents - creditedTaxCents,
      creditedTaxCents,
      creditedTotalCents,
    }), 1)
    expect([row.valueExclTaxCents, row.taxCents, row.totalCents]).toEqual([0, 0, 0])
  })
})

describe("invoice status — boundaries", () => {
  it("is credited at exactly the total, and partly credited one paisa short", () => {
    expect(invoiceStatusAfterCredit(2_950, 2_950)).toBe("CREDITED")
    expect(invoiceStatusAfterCredit(2_950, 2_949)).toBe("PARTIALLY_CREDITED")
    expect(invoiceStatusAfterCredit(2_950, 1)).toBe("PARTIALLY_CREDITED")
    expect(invoiceStatusAfterCredit(2_950, 0)).toBe("ISSUED")
  })

  // A refund approved before delivery is taken off the invoice when it is
  // issued, so the invoice row is ISSUED and no credit note exists. Reading
  // "supplied + refund > 0" from the order called it PARTIALLY_CREDITED; once
  // the invoice exists its own status is the answer.
  it("an order refunded before delivery and then delivered reads the same as its invoice row", () => {
    const issued = planIssuedInvoice({
      items: [line({ orderItemId: 1, priceCents: 1_180, quantity: 2 })],
      refundedByItem: new Map([[1, { quantity: 1, grossCents: 1_180 }]]),
      unitemizedRefundCents: 0,
    })
    const ledgerStatus = invoiceStatusAfterCredit(issued.totalCents, 0)
    const derived = deriveInvoiceStatus({ status: "APPROVED", fulfillmentStatus: "DELIVERED", refundAmountCents: 1_180, ledgerStatus })
    expect(derived).toBe("ISSUED")
  })

  it("the invoice row's status wins over anything derived from the order", () => {
    expect(deriveInvoiceStatus({ status: "FULFILLED", refundAmountCents: 500, ledgerStatus: "ISSUED" })).toBe("ISSUED")
    expect(deriveInvoiceStatus({ status: "REFUNDED", fulfillmentStatus: "DELIVERED", ledgerStatus: "CREDITED" })).toBe("CREDITED")
    expect(deriveInvoiceStatus({ status: "FULFILLED", ledgerStatus: " partially_credited " })).toBe("PARTIALLY_CREDITED")
  })

  it("ignores a missing or unknown ledger status and derives from the order", () => {
    expect(deriveInvoiceStatus({ status: "FULFILLED", refundAmountCents: 500, ledgerStatus: null })).toBe("PARTIALLY_CREDITED")
    expect(deriveInvoiceStatus({ status: "APPROVED", ledgerStatus: "PROFORMA_AVAILABLE" })).toBe("PROFORMA_AVAILABLE")
    expect(deriveInvoiceStatus({ status: "APPROVED", ledgerStatus: "PAID" })).toBe("PROFORMA_AVAILABLE")
  })
})

describe("reservedInvoiceNumber — boundaries", () => {
  it("accepts a number of exactly 40 characters and refuses 41", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: "A".repeat(40) }, "T1")).toBe("A".repeat(40))
    expect(reservedInvoiceNumber({ invoiceNumber: "A".repeat(41) }, "T1")).toBeNull()
  })

  it("compares the TID fallback after trimming both sides", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: " TID123 " }, "TID123")).toBeNull()
    expect(reservedInvoiceNumber({ invoiceNumber: "UBL-APR-000001" }, " TID123 ")).toBe("UBL-APR-000001")
  })

  it("reads a missing snapshot as no reservation", () => {
    expect(reservedInvoiceNumber(null, "T1")).toBeNull()
    expect(reservedInvoiceNumber(undefined, "T1")).toBeNull()
    expect(reservedInvoiceNumber({}, "T1")).toBeNull()
  })

  // A K-Electric import carries KE-LEGACY-<id> as both its TID and its invoice
  // number, so it is not a reservation: delivered, it is numbered from the
  // organization's own series like any order placed after the switch.
  it("does not honour a K-Electric import's legacy reference, which is also its TID", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: "KE-LEGACY-1234" }, "KE-LEGACY-1234")).toBeNull()
  })

  // Any other number drawn before the switch is honoured whatever its format,
  // so a customer who saw it on a proforma never sees a second one (D6).
  it("honours an older-format number drawn at creation", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: "INV-000123" }, "T1")).toBe("INV-000123")
  })
})

describe("karachiDate — calendar boundaries", () => {
  it("rolls into the next year and month at 19:00 UTC", () => {
    expect(karachiDate(new Date("2026-12-31T19:00:00Z"))).toBe("2027-01-01")
    expect(karachiDate(new Date("2026-12-31T18:59:59.999Z"))).toBe("2026-12-31")
  })

  it("knows the leap day", () => {
    expect(karachiDate(new Date("2028-02-28T19:00:00Z"))).toBe("2028-02-29")
  })
})
