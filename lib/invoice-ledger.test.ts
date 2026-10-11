import { describe, expect, it } from "vitest"

import {
  invoiceStatusAfterCredit,
  karachiDate,
  legacyPrintedDate,
  planCreditNote,
  planIssuedInvoice,
  refundTaxCents,
  reservedInvoiceNumber,
  UNITEMIZED_CREDIT_DESCRIPTION,
  type InvoiceSourceItem,
} from "./invoice-ledger"

const item = (overrides: Partial<InvoiceSourceItem> = {}): InvoiceSourceItem => ({
  orderItemId: 1,
  productName: "Tea",
  productCode: null,
  unit: "pcs",
  category: null,
  quantity: 2,
  priceCents: 1_180,
  taxRateBp: 1_800,
  taxCents: 360,
  ...overrides,
})

describe("karachiDate", () => {
  it("is the calendar date in Karachi, not UTC", () => {
    expect(karachiDate(new Date("2026-08-31T19:30:00Z"))).toBe("2026-09-01")
    expect(karachiDate(new Date("2026-08-31T18:59:59Z"))).toBe("2026-08-31")
  })
})

describe("reservedInvoiceNumber", () => {
  it("honours a number drawn at creation", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: " UBL-APR-000036 " }, "tid-1")).toBe("UBL-APR-000036")
  })

  it("never treats the TID fallback, a blank, or a non-string as a reservation", () => {
    expect(reservedInvoiceNumber({ invoiceNumber: "tid-1" }, "tid-1")).toBeNull()
    expect(reservedInvoiceNumber({ invoiceNumber: "  " }, "tid-1")).toBeNull()
    expect(reservedInvoiceNumber({ invoiceNumber: 36 }, "tid-1")).toBeNull()
    expect(reservedInvoiceNumber(null, "tid-1")).toBeNull()
    expect(reservedInvoiceNumber({ invoiceNumber: "X".repeat(41) }, "tid-1")).toBeNull()
  })
})

describe("planIssuedInvoice", () => {
  it("invoices every line untouched by refunds with the tax recorded at sale", () => {
    const plan = planIssuedInvoice({
      items: [item(), item({ orderItemId: 2, productName: "Sugar", quantity: 1, priceCents: 590, taxCents: 90 })],
      refundedByItem: new Map(),
      unitemizedRefundCents: 0,
    })
    expect(plan).toMatchObject({ netCents: 2_500, taxCents: 450, discountCents: 0, totalCents: 2_950 })
    expect(plan.lines.map((line) => [line.lineNo, line.netCents, line.taxCents, line.grossCents])).toEqual([[1, 2_000, 360, 2_360], [2, 500, 90, 590]])
  })

  it("takes away what refunds before delivery took, and drops a line refunded in full", () => {
    const plan = planIssuedInvoice({
      items: [item(), item({ orderItemId: 2, quantity: 1, priceCents: 590, taxCents: 90 })],
      refundedByItem: new Map([[1, { quantity: 1, grossCents: 1_180 }], [2, { quantity: 1, grossCents: 590 }]]),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines).toHaveLength(1)
    expect(plan.lines[0]).toMatchObject({ quantity: 1, grossCents: 1_180, taxCents: 180, netCents: 1_000, lineNo: 1 })
    expect(plan.totalCents).toBe(1_180)
  })

  it("splits a partly refunded line without a rate in the proportion recorded at sale", () => {
    const plan = planIssuedInvoice({
      items: [item({ taxRateBp: null, taxCents: 400, priceCents: 1_000 })],
      refundedByItem: new Map([[1, { quantity: 1, grossCents: 1_000 }]]),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines[0]).toMatchObject({ grossCents: 1_000, taxCents: 200, netCents: 800 })
  })

  it("turns an un-itemised refund into a discount, never more than is left", () => {
    const plan = planIssuedInvoice({ items: [item()], refundedByItem: new Map(), unitemizedRefundCents: 100 })
    expect(plan).toMatchObject({ discountCents: 100, totalCents: 2_260 })
    expect(plan.netCents + plan.taxCents - plan.discountCents).toBe(plan.totalCents)
    const capped = planIssuedInvoice({ items: [item()], refundedByItem: new Map(), unitemizedRefundCents: 99_999 })
    expect(capped).toMatchObject({ discountCents: 2_360, totalCents: 0 })
  })

  it("handles decimal quantities", () => {
    const plan = planIssuedInvoice({
      items: [item({ quantity: 1.5, priceCents: 1_000, taxCents: 229, taxRateBp: 1_800 })],
      refundedByItem: new Map([[1, { quantity: 0.5, grossCents: 500 }]]),
      unitemizedRefundCents: 0,
    })
    expect(plan.lines[0]).toMatchObject({ quantity: 1, grossCents: 1_000, taxCents: 153, netCents: 847 })
  })

  it("refuses a negative un-itemised refund", () => {
    expect(() => planIssuedInvoice({ items: [item()], refundedByItem: new Map(), unitemizedRefundCents: -1 })).toThrow()
  })
})

describe("planCreditNote", () => {
  const invoice = { taxCents: 450, totalCents: 2_950, creditedTotalCents: 0 }

  it("splits each refunded line at its own rate", () => {
    const plan = planCreditNote({
      refundAmountCents: 1_180,
      lines: [{ orderItemId: 1, invoiceLineId: 7, description: "Tea", quantity: 1, grossCents: 1_180, taxRateBp: 1_800 }],
      invoice,
    })
    expect(plan).toMatchObject({ netCents: 1_000, taxCents: 180, totalCents: 1_180 })
    expect(plan.lines[0]).toMatchObject({ lineNo: 1, invoiceLineId: 7, quantity: 1 })
  })

  it("puts what the refund did not itemise on one adjustment line, at the invoice's own proportion", () => {
    const plan = planCreditNote({ refundAmountCents: 1_000, lines: [], invoice })
    expect(plan.lines).toEqual([expect.objectContaining({
      description: UNITEMIZED_CREDIT_DESCRIPTION,
      quantity: null,
      grossCents: 1_000,
      taxCents: Math.round(450 * 1_000 / 2_950),
    })])
    expect(plan.netCents + plan.taxCents).toBe(plan.totalCents)
  })

  it("never credits more than the invoice has left", () => {
    expect(() => planCreditNote({ refundAmountCents: 1_000, lines: [], invoice: { ...invoice, creditedTotalCents: 2_000 } }))
      .toThrow("CREDIT_EXCEEDS_INVOICE")
    expect(() => planCreditNote({
      refundAmountCents: 10,
      lines: [{ orderItemId: 1, invoiceLineId: null, description: "Tea", quantity: 1, grossCents: 20, taxRateBp: 0 }],
      invoice,
    })).toThrow("CREDIT_LINES_EXCEED_REFUND")
  })

  it("refuses an empty credit note", () => {
    expect(() => planCreditNote({ refundAmountCents: 0, lines: [], invoice })).toThrow("CREDIT_NOTE_EMPTY")
  })

  it("splits a line with no rate in the invoice's proportion", () => {
    const plan = planCreditNote({
      refundAmountCents: 590,
      lines: [{ orderItemId: 2, invoiceLineId: null, description: "Sugar", quantity: 1, grossCents: 590, taxRateBp: null }],
      invoice,
    })
    expect(plan.taxCents).toBe(90)
  })
})

describe("invoiceStatusAfterCredit", () => {
  it("moves from issued to partly credited to credited", () => {
    expect(invoiceStatusAfterCredit(2_950, 0)).toBe("ISSUED")
    expect(invoiceStatusAfterCredit(2_950, 1)).toBe("PARTIALLY_CREDITED")
    expect(invoiceStatusAfterCredit(2_950, 2_950)).toBe("CREDITED")
  })
})

describe("refundTaxCents", () => {
  it("splits itemised lines at their rate and the rest in the order's proportion", () => {
    expect(refundTaxCents({
      refundAmountCents: 1_770,
      lines: [{ grossCents: 1_180, taxRateBp: 1_800 }],
      order: { taxCents: 450, totalCents: 2_950 },
    })).toBe(180 + 90)
  })

  it("is zero for an order without tax, and never exceeds the refund", () => {
    expect(refundTaxCents({ refundAmountCents: 500, lines: [], order: { taxCents: 0, totalCents: 1_000 } })).toBe(0)
    expect(refundTaxCents({ refundAmountCents: 5, lines: [], order: { taxCents: 1_000, totalCents: 1_000 } })).toBe(5)
  })
})

describe("legacyPrintedDate", () => {
  it("reads the MM/DD/YYYY snapshot date as ISO", () => {
    expect(legacyPrintedDate("08/24/2026")).toBe("2026-08-24")
    expect(legacyPrintedDate("8/4/2026")).toBe("2026-08-04")
  })

  it("rejects anything that is not a real date in that shape", () => {
    expect(legacyPrintedDate("02/30/2026")).toBeNull()
    expect(legacyPrintedDate("2026-08-24")).toBeNull()
    expect(legacyPrintedDate(null)).toBeNull()
  })
})
