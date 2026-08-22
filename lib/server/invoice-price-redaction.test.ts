import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

import { redactReceiptPrices } from "@/lib/receipt-redaction"
import { buildInvoiceLines, buildInvoiceTotals } from "@/lib/invoice-lines"

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8")

/**
 * The invoice now prints tax-exclusive figures alongside the gross ones. Those
 * are money too, so a price-restricted role must not receive any of them —
 * leaving one behind would hand back the price the redaction exists to hide.
 */
describe("invoice price redaction", () => {
  const snapshot = {
    subtotal: 1_000,
    tax: 180,
    discount: 0,
    deliveryCharges: 0,
    totalAmount: 1_180,
    items: [{
      mainCategoryName: "Pantry",
      subCategories: [{
        subCategoryName: "Tea",
        items: [{
          description: "Tapal Danedar",
          quantity: 2,
          unit: "pcs",
          rate: 590,
          total: 1_180,
          netRate: 500,
          netAmount: 1_000,
          tax: 180,
          taxPercent: 18,
        }],
      }],
    }],
  }

  const redactedLine = () => {
    const redacted: any = redactReceiptPrices(snapshot)
    return redacted.items[0].subCategories[0].items[0]
  }

  it("nulls every monetary field on a line, gross and net alike", () => {
    const line = redactedLine()

    expect(line.rate).toBeNull()
    expect(line.total).toBeNull()
    expect(line.netRate).toBeNull()
    expect(line.netAmount).toBeNull()
    expect(line.tax).toBeNull()
  })

  it("keeps the tax rate, which discloses no amount", () => {
    expect(redactedLine().taxPercent).toBe(18)
  })

  it("leaves nothing an invoice could reconstruct a price from", () => {
    const redacted: any = redactReceiptPrices(snapshot)
    const lines = buildInvoiceLines(redacted)
    const totals = buildInvoiceTotals(redacted, lines, 0)

    expect(lines[0].rate).toBeNull()
    expect(lines[0].amount).toBeNull()
    expect(lines[0].tax).toBeNull()
    expect(totals.subTotal).toBeNull()
    expect(totals.taxAmount).toBeNull()
    expect(totals.total).toBeNull()
  })

  it("also redacts a snapshot whose items are not nested under sub-categories", () => {
    const flat: any = redactReceiptPrices({
      items: [{ categoryName: "General", items: [{ description: "Sugar", netAmount: 500, tax: 90 }] }],
    })

    expect(flat.items[0].items[0].netAmount).toBeNull()
    expect(flat.items[0].items[0].tax).toBeNull()
  })
})

/**
 * Access control for invoices is decided in one place. This change is
 * presentational, so that authority and the download's price gate must both
 * still be exactly where they were.
 */
describe("invoice access is unchanged", () => {
  it("still routes every invoice read through the single authorization helper", () => {
    const source = read("app/api/v1/receipts/[orderId]/route.ts")

    expect(source).toContain("authorizeInvoiceRequest(orderId)")
    expect(source).toContain("if (!access.ok)")
    expect(source).toContain("redactReceiptPrices(finalReceiptData)")
  })

  it("still refuses the PDF download outright when prices are hidden", () => {
    const source = read("app/api/v1/receipts/[orderId]/download/route.ts")

    expect(source).toContain("authorizeInvoiceRequest(orderId)")
    expect(source).toContain("Invoice download is unavailable while prices are hidden")
  })
})
