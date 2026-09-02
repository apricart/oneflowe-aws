import { describe, expect, it } from "vitest"

import {
  buildInvoiceLines,
  buildInvoiceTotals,
  formatInvoiceMoney,
  formatInvoiceQuantity,
  formatInvoiceTaxPercent,
  getInvoiceTaxLabel,
} from "./invoice-lines"

/** A snapshot written since tax was recorded, carrying the net figures. */
const currentSnapshot = {
  subtotal: 62_914.96,
  tax: 11_324.69,
  discount: 0,
  deliveryCharges: 0,
  totalAmount: 74_239.65,
  items: [
    {
      mainCategoryName: "Pantry",
      subCategories: [
        {
          subCategoryName: "Tea",
          items: [
            {
              description: "Tapal Danedar Teabags - 600pcs box",
              quantity: 5,
              unit: "pcs",
              rate: 3_400,
              total: 17_000,
              netRate: 2_881.35,
              netAmount: 14_406.75,
              tax: 2_593.22,
              taxPercent: 18,
            },
            {
              description: "Tapal Green Tea Lemon - 30Teabags",
              quantity: 3,
              unit: "pcs",
              rate: 260,
              total: 780,
              netRate: 220.33,
              netAmount: 660.99,
              tax: 118.98,
              taxPercent: 18,
            },
          ],
        },
      ],
    },
  ],
}

/**
 * A snapshot written before tax existed: gross rate and total only, no net
 * fields, no per-line tax. Invoices like this are already issued and filed, so
 * what they print must not move.
 */
const legacySnapshot = {
  subtotal: 5_000,
  tax: 0,
  discount: 0,
  deliveryCharges: 0,
  totalAmount: 5_000,
  items: [
    {
      categoryName: "General",
      items: [
        { description: "Sugar 1kg", quantity: 30, unit: "kg", rate: 100, total: 3_000, tax: 0 },
        { description: "Nescafe Coffee - 200gm", quantity: 4, unit: "pcs", rate: 500, total: 2_000, tax: 0 },
      ],
    },
  ],
}

describe("invoice lines", () => {
  it("flattens the category nesting into one numbered list", () => {
    const lines = buildInvoiceLines(currentSnapshot)

    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.serial)).toEqual([1, 2])
    expect(lines[0].description).toBe("Tapal Danedar Teabags - 600pcs box")
  })

  it("prints the tax-exclusive rate and amount", () => {
    const [line] = buildInvoiceLines(currentSnapshot)

    expect(line.rate).toBe(2_881.35)
    expect(line.amount).toBe(14_406.75)
    expect(line.tax).toBe(2_593.22)
    expect(line.taxPercent).toBe(18)
  })

  it("keeps rate x quantity reconciling to the amount", () => {
    const [line] = buildInvoiceLines(currentSnapshot)

    expect(Number(((line.rate as number) * line.quantity).toFixed(2))).toBe(line.amount)
  })

  it("handles a snapshot with no items at all", () => {
    expect(buildInvoiceLines(null)).toEqual([])
    expect(buildInvoiceLines({})).toEqual([])
    expect(buildInvoiceLines({ items: [] })).toEqual([])
  })
})

/**
 * The compatibility guarantee: an invoice issued before this feature shows the
 * same figures it always has. Only the column layout changed.
 */
describe("invoices issued before tax was recorded", () => {
  it("falls back to the stored gross rate and total", () => {
    const lines = buildInvoiceLines(legacySnapshot)

    expect(lines[0].rate).toBe(100)
    expect(lines[0].amount).toBe(3_000)
    expect(lines[1].rate).toBe(500)
    expect(lines[1].amount).toBe(2_000)
  })

  it("shows no tax rate rather than inventing one", () => {
    const lines = buildInvoiceLines(legacySnapshot)

    expect(lines[0].taxPercent).toBeNull()
    expect(lines[0].tax).toBe(0)
    expect(getInvoiceTaxLabel(lines)).toBe("Sales Tax")
  })

  it("still balances, with nothing pushed into rounding", () => {
    const lines = buildInvoiceLines(legacySnapshot)
    const totals = buildInvoiceTotals(legacySnapshot, lines, 0)

    expect(totals.subTotal).toBe(5_000)
    expect(totals.taxAmount).toBe(0)
    expect(totals.total).toBe(5_000)
    expect(totals.rounding).toBe(0)
  })
})

describe("invoice totals", () => {
  it("names the tax row after the single rate charged", () => {
    const lines = buildInvoiceLines(currentSnapshot)

    expect(getInvoiceTaxLabel(lines)).toBe("Standard Rate (18%)")
  })

  it("falls back to a plain label when rates differ across lines", () => {
    const mixed = buildInvoiceLines({
      items: [{
        items: [
          { description: "A", quantity: 1, netAmount: 100, tax: 18, taxPercent: 18 },
          { description: "B", quantity: 1, netAmount: 100, tax: 5, taxPercent: 5 },
        ],
      }],
    })

    expect(getInvoiceTaxLabel(mixed)).toBe("Sales Tax")
  })

  it("reconciles the components to the recorded total", () => {
    const lines = buildInvoiceLines(currentSnapshot)
    const totals = buildInvoiceTotals(currentSnapshot, lines, 0)

    expect(totals.subTotal).toBe(62_914.96)
    expect(totals.taxAmount).toBe(11_324.69)
    expect(totals.total).toBe(74_239.65)
    expect(totals.rounding).toBe(0)
  })

  it("absorbs a discrepancy into rounding rather than printing an invoice that disagrees with itself", () => {
    const uneven = { ...currentSnapshot, totalAmount: 74_240 }
    const totals = buildInvoiceTotals(uneven, buildInvoiceLines(uneven), 0)

    expect(totals.rounding).toBe(0.35)
  })

  it("accounts for a refund without unbalancing the invoice", () => {
    const refunded = { ...currentSnapshot, totalAmount: 64_239.65 }
    const totals = buildInvoiceTotals(refunded, buildInvoiceLines(refunded), 10_000)

    expect(totals.refund).toBe(10_000)
    expect(totals.rounding).toBe(0)
  })
})

/**
 * Price-restricted roles receive the invoice with its money fields nulled, so
 * every reader has to survive nulls without turning them into zeros — a
 * printed 0.00 would read as a genuine amount.
 */
describe("prices hidden for the role", () => {
  const redacted = {
    subtotal: null,
    tax: null,
    totalAmount: null,
    discount: 0,
    deliveryCharges: 0,
    items: [{
      items: [{
        description: "Sugar 1kg",
        quantity: 30,
        unit: "kg",
        rate: null,
        total: null,
        netRate: null,
        netAmount: null,
        tax: null,
        taxPercent: 18,
      }],
    }],
  }

  it("keeps the quantity but reports no amounts", () => {
    const [line] = buildInvoiceLines(redacted)

    expect(line.quantity).toBe(30)
    expect(line.rate).toBeNull()
    expect(line.amount).toBeNull()
    expect(line.tax).toBeNull()
  })

  it("reports no totals and no rounding", () => {
    const lines = buildInvoiceLines(redacted)
    const totals = buildInvoiceTotals(redacted, lines, 0)

    expect(totals.subTotal).toBeNull()
    expect(totals.total).toBeNull()
    expect(totals.rounding).toBeNull()
  })

  it("renders a dash rather than a zero", () => {
    expect(formatInvoiceMoney(null)).toBe("—")
    expect(formatInvoiceTaxPercent(null)).toBe("—")
  })
})

describe("invoice formatting", () => {
  it("prints money and quantities to two decimals", () => {
    expect(formatInvoiceMoney(14_406.75)).toBe("14,406.75")
    expect(formatInvoiceMoney(0)).toBe("0.00")
    expect(formatInvoiceQuantity(5)).toBe("5.00")
    expect(formatInvoiceQuantity(30)).toBe("30.00")
    expect(formatInvoiceTaxPercent(18)).toBe("18.00")
  })
})
