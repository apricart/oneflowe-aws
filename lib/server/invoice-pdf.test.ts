// @vitest-environment node
import { describe, expect, it } from "vitest"

import { renderInvoicePdf } from "@/lib/server/invoice-pdf"
import { INVOICE_SYSTEM_GENERATED_NOTE } from "@/lib/invoice-format"

/**
 * The downloaded invoice is the document a buyer files, so what it prints is
 * asserted against the rendered PDF itself rather than against the code that
 * draws it. jsPDF writes its content streams uncompressed, so every printed
 * string is recoverable from the bytes.
 */
const receiptData = {
  invoiceNumber: "APR-000004",
  orderId: 41288,
  orderTid: "TXN-01J8F4K2QW",
  paymentStatus: "UNPAID",
  poNumber: "PO-2026-0148",
  date: "07/29/2026",
  status: "Fulfilled",
  statusKey: "fulfilled",
  buyerName: "ASU-CPU Central Processing Unit",
  buyerAddress: "Ground Floor, Mai Kolachi Road, Karachi, Sindh",
  organizationName: "United Bank Limited",
  organizationNtn: "0801164-8",
  placedByName: "Rajesh Ramesh",
  placedByPhone: "0300-2185120",
  approvedByName: "Muhammad Faisal Siddiqui",
  fulfilledByName: "Sana Iqbal",
  items: [{
    mainCategoryName: "Pantry",
    subCategories: [{
      subCategoryName: "Tea",
      items: [{
        description: "Tapal Danedar Teabags 600pcs Catering Box, Imported Ceylon Blend (PRD-LONG-NAME-0001)",
        quantity: 5,
        unit: "pcs",
        rate: 3_400,
        total: 17_000,
        netRate: 2_881.35,
        netAmount: 14_406.75,
        tax: 2_593.22,
        taxPercent: 18,
      }],
    }],
  }],
  subtotal: 14_406.75,
  tax: 2_593.22,
  discount: 0,
  deliveryCharges: 0,
  refund: 0,
  refundedItems: [],
  totalAmount: 16_999.97,
}

function printedText(data: unknown = receiptData) {
  return Buffer.from(renderInvoicePdf(data)).toString("latin1")
}

describe("the downloaded invoice", () => {
  it("names the fulfiller alongside the initiator and the approver", () => {
    const pdf = printedText()

    expect(pdf).toContain("Initiator:")
    expect(pdf).toContain("Rajesh Ramesh")
    expect(pdf).toContain("Approver:")
    expect(pdf).toContain("Fulfiller:")
    expect(pdf).toContain("Sana Iqbal")
  })

  it("reports no fulfiller rather than an empty field when none was recorded", () => {
    const { fulfilledByName, ...withoutFulfiller } = receiptData

    expect(printedText(withoutFulfiller)).toContain("Fulfiller:")
  })

  it("keeps the subtotal out of the header", () => {
    expect(printedText()).not.toContain("Subtotal")
  })

  it("prints no purchase order reference, even when the order carries one", () => {
    const pdf = printedText()

    expect(pdf).not.toContain("P.O.#")
    expect(pdf).not.toContain("PO-2026-0148")
  })

  it("prints the quantity without a unit", () => {
    const pdf = printedText()

    expect(pdf).toContain("5.00")
    expect(pdf).not.toContain("5.00 pcs")
  })

  it("closes with the system-generated note instead of signature blocks", () => {
    const pdf = printedText()

    expect(pdf).toContain(INVOICE_SYSTEM_GENERATED_NOTE)
    expect(pdf).not.toContain("AUTHORIZED SIGN")
    expect(pdf).not.toContain("ACCOUNTANT")
  })

  it("still prints the figures the invoice is reconciled against", () => {
    const pdf = printedText()

    expect(pdf).toContain("APR-000004")
    expect(pdf).toContain("29 Jul 2026")
    expect(pdf).toContain("Sub Total")
    expect(pdf).toContain("14,406.75")
    expect(pdf).toContain("16,999.97")
  })

  it("prints the order reference under the invoice date", () => {
    const pdf = printedText()

    expect(pdf).toContain("Order ID")
    expect(pdf).toContain("41288")
    expect(pdf).not.toContain("TXN-01J8F4K2QW")
    expect(pdf.indexOf("Invoice Date")).toBeLessThan(pdf.indexOf("Order ID"))
  })

  it("reports a missing order reference rather than an empty field", () => {
    const { orderId, ...withoutOrderReference } = receiptData

    expect(printedText(withoutOrderReference)).toContain("Order ID")
    expect(printedText(withoutOrderReference)).toContain("N/A")
  })
})

/**
 * A product name is the record of what was charged for, so it is printed in
 * full. jsPDF writes one text-drawing operation per line, so a wrapped name
 * arrives in the file as several fragments rather than one long string.
 */
describe("a product name too long for its column", () => {
  it("wraps onto further lines instead of being cut short", () => {
    const pdf = printedText()

    expect(pdf).not.toContain("...")
    expect(pdf).toContain("Tapal Danedar Teabags")
    expect(pdf).toContain("PRD-LONG-NAME-0001")
  })

  it("grows the row so a wrapped name cannot overlap the line beneath it", () => {
    const twoLongLines = {
      ...receiptData,
      items: [{
        mainCategoryName: "Pantry",
        subCategories: [{
          subCategoryName: "Tea",
          items: [
            { ...receiptData.items[0].subCategories[0].items[0] },
            { ...receiptData.items[0].subCategories[0].items[0], description: "Short Name" },
          ],
        }],
      }],
    }

    // A taller first row pushes everything after it down the page, so the
    // document is longer than the same invoice with two short names.
    const wrapped = Buffer.from(renderInvoicePdf(twoLongLines)).byteLength
    const short = Buffer.from(renderInvoicePdf({
      ...twoLongLines,
      items: [{
        mainCategoryName: "Pantry",
        subCategories: [{
          subCategoryName: "Tea",
          items: [
            { ...receiptData.items[0].subCategories[0].items[0], description: "Short Name" },
            { ...receiptData.items[0].subCategories[0].items[0], description: "Short Name" },
          ],
        }],
      }],
    })).byteLength

    expect(wrapped).toBeGreaterThan(short)
  })
})

describe("the paid stamp", () => {
  it("marks an invoice the order records as settled", () => {
    expect(printedText({ ...receiptData, paymentStatus: "PAID" })).toContain("PAID")
  })

  it("is absent from an unpaid invoice", () => {
    expect(printedText()).not.toContain("PAID")
  })

  it("treats an unrecognised payment status as unpaid", () => {
    expect(printedText({ ...receiptData, paymentStatus: null })).not.toContain("PAID")
    expect(printedText({ ...receiptData, paymentStatus: "SOMETHING_ELSE" })).not.toContain("PAID")
  })
})

describe("the invoice status and title", () => {
  it("keeps the plain INVOICE heading when no status is supplied", () => {
    const text = printedText()
    expect(text).toContain("(INVOICE)")
    expect(text).not.toContain("PROFORMA")
    expect(text).not.toContain("Invoice Status")
  })

  it("titles an issued invoice INVOICE and prints its status", () => {
    const text = printedText({ ...receiptData, invoiceStatus: "PARTIALLY_CREDITED" })
    expect(text).toContain("(INVOICE)")
    expect(text).toContain("Invoice Status")
    expect(text).toContain("Partially credited")
  })

  it("titles anything not yet a tax invoice PROFORMA INVOICE", () => {
    const text = printedText({ ...receiptData, invoiceStatus: "PROFORMA_AVAILABLE" })
    expect(text).toContain("PROFORMA INVOICE")
    expect(text).toContain("Proforma available")
  })

  it("ignores a status outside the known set rather than printing it", () => {
    const text = printedText({ ...receiptData, invoiceStatus: "PAID_IN_FULL" })
    expect(text).toContain("(INVOICE)")
    expect(text).not.toContain("PAID_IN_FULL")
  })
})

describe("the customer's STRN", () => {
  it("is printed under Bill To beside the NTN when supplied", () => {
    const text = printedText({ ...receiptData, organizationStrn: "3277876123456" })
    expect(text).toContain("STRN:")
    expect(text).toContain("3277876123456")
  })

  it("prints only Apricart's own STRN when the customer has none", () => {
    expect(printedText().match(/STRN:/g)).toHaveLength(1)
  })
})
