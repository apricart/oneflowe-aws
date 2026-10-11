import { describe, expect, it } from "vitest"

import { buildInvoiceLines, buildInvoiceTotals } from "./invoice-lines"
import {
  creditNoteDocument,
  displayedInvoiceNumber,
  frozenInvoiceDocument,
  isProformaDocument,
} from "./invoice-ledger-document"

const invoice = {
  number: "UBL-APR-000036",
  issueDate: "2026-09-03",
  status: "PARTIALLY_CREDITED",
  buyer: {
    organizationName: "UBL",
    ntn: "0801164-8",
    strn: "3277876123456",
    buyerName: "Compliance",
    buyerAddress: "I.I. Chundrigar Road",
    deliveryAddressLabel: "Head office",
  },
  participants: { placedByName: "Rajesh Ramesh", placedByPhone: "0300", approvedByName: "Farruk Khalil" },
  netCents: 2_500,
  taxCents: 450,
  discountCents: 0,
  deliveryChargesCents: 0,
  totalCents: 2_950,
}

const lines = [
  { productName: "Tea", unit: "pcs", quantity: 2, unitPriceCents: 1_180, taxRateBp: 1_800, netCents: 2_000, taxCents: 360, grossCents: 2_360 },
  { productName: "Sugar", unit: "kg", quantity: 1, unitPriceCents: 590, taxRateBp: null, netCents: 500, taxCents: 90, grossCents: 590 },
]

describe("frozenInvoiceDocument", () => {
  const document = frozenInvoiceDocument({
    invoice,
    lines,
    order: { id: 1782, tid: "TID-1782", paymentStatus: "UNPAID" },
    creditNotes: [{ id: 4, number: "UBL-CN-000004", issueDate: "2026-09-10", totalCents: 590, reason: "Damaged" }],
  })

  it("prints only what the invoice recorded at issue", () => {
    expect(document).toMatchObject({
      frozen: true,
      invoiceNumber: "UBL-APR-000036",
      date: "2026-09-03",
      orderId: 1782,
      buyerName: "Compliance",
      buyerAddress: "I.I. Chundrigar Road",
      organizationName: "UBL",
      organizationNtn: "0801164-8",
      organizationStrn: "3277876123456",
      placedByName: "Rajesh Ramesh",
      approvedByName: "Farruk Khalil",
      invoiceStatus: "PARTIALLY_CREDITED",
      documentTitle: "INVOICE",
      refund: 0,
      totalAmount: 29.5,
    })
    expect(document).not.toHaveProperty("fulfilledByName")
    expect(document.creditNotes).toEqual([{ id: 4, number: "UBL-CN-000004", date: "2026-09-10", total: 5.9 }])
  })

  it("reconciles through the invoice template's own line and total rules", () => {
    const printed = buildInvoiceLines(document)
    expect(printed.map((line) => [line.description, line.quantity, line.amount, line.tax, line.taxPercent]))
      .toEqual([["Tea", 2, 20, 3.6, 18], ["Sugar", 1, 5, 0.9, 18]])
    const totals = buildInvoiceTotals(document, printed, 0)
    expect(totals).toMatchObject({ subTotal: 25, taxAmount: 4.5, total: 29.5, rounding: 0 })
  })
})

describe("creditNoteDocument", () => {
  it("names the credit note and the invoice it credits", () => {
    const document = creditNoteDocument({
      creditNote: { id: 4, number: "UBL-CN-000004", issueDate: "2026-09-10", totalCents: 1_180, netCents: 1_000, taxCents: 180, reason: "Damaged" },
      lines: [{ description: "Adjustment", quantity: null, taxRateBp: null, netCents: 1_000, taxCents: 180, grossCents: 1_180 }],
      invoice: { number: "UBL-APR-000036", issueDate: "2026-09-03", buyer: invoice.buyer },
      order: { id: 1782, tid: "TID-1782" },
    })
    expect(document).toMatchObject({
      documentKind: "CREDIT_NOTE",
      documentTitle: "CREDIT NOTE",
      creditNote: { number: "UBL-CN-000004", invoiceNumber: "UBL-APR-000036", invoiceDate: "2026-09-03", reason: "Damaged" },
      subtotal: 10,
      tax: 1.8,
      totalAmount: 11.8,
    })
    expect(buildInvoiceLines(document)[0]).toMatchObject({ quantity: 1, amount: 10 })
  })
})

describe("displayedInvoiceNumber", () => {
  it("shows a tax invoice's number", () => {
    expect(displayedInvoiceNumber({ invoiceNumber: "UBL-APR-000036", invoiceStatus: "ISSUED" })).toBe("UBL-APR-000036")
    expect(displayedInvoiceNumber({ invoiceNumber: "UBL-APR-000036" })).toBe("UBL-APR-000036")
    expect(displayedInvoiceNumber({})).toBe("N/A")
  })

  it("says when a proforma's invoice will be issued", () => {
    expect(displayedInvoiceNumber({ invoiceStatus: "PROFORMA_AVAILABLE" })).toBe("Issued on delivery")
    expect(displayedInvoiceNumber({ invoiceStatus: "PROFORMA_AVAILABLE", invoiceNumber: "UBL-APR-000040" })).toBe("UBL-APR-000040 (on delivery)")
    expect(displayedInvoiceNumber({ invoiceStatus: "CANCELLED", invoiceNumber: "UBL-APR-000040" })).toBe("UBL-APR-000040 (not issued)")
    expect(displayedInvoiceNumber({ invoiceStatus: "NOT_ISSUED" })).toBe("Not issued")
  })

  it("knows a proforma from a tax invoice", () => {
    expect(isProformaDocument({ invoiceStatus: "PROFORMA_AVAILABLE" })).toBe(true)
    expect(isProformaDocument({ invoiceStatus: "CREDITED" })).toBe(false)
    expect(isProformaDocument({})).toBe(false)
  })
})
