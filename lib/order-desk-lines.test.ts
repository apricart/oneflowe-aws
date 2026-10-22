import { describe, expect, it } from "vitest"

import { MAX_PRICE_CENTS } from "@/lib/price-ladder"
import { splitInclusiveCents } from "@/lib/tax"

import {
  DeskLineRefusal,
  isActiveDeskProduct,
  priceDeskOrderLines,
  type DeskLineLineage,
  type DeskLineProduct,
} from "./order-desk-lines"

const product = (overrides: Partial<DeskLineProduct> & Pick<DeskLineProduct, "id" | "name">): DeskLineProduct => ({
  productCode: `P-${overrides.id}`,
  unit: "piece",
  status: "active",
  deletedAt: null,
  allowDecimalQuantity: false,
  quantityStep: 1,
  taxRateBp: null,
  ...overrides,
})

const rice = product({ id: 1, name: "Rice", unit: "kg", allowDecimalQuantity: true, quantityStep: 0.5, taxRateBp: 1_800 })
const boxes = product({ id: 2, name: "Boxes" })
const tape = product({ id: 3, name: "Tape", taxRateBp: 0 })

const context = (
  products: DeskLineProduct[],
  lineage: [number, DeskLineLineage][] = [],
  organizationTaxRateBp = 1_700,
) => ({
  productById: new Map(products.map((row) => [row.id, row])),
  lineageByProductId: new Map(lineage),
  organizationTaxRateBp,
})

describe("pricing an Order Desk order's lines", () => {
  it("charges the entered price, tax-inclusive, and splits the tax out of it", () => {
    const priced = priceDeskOrderLines(
      [{ globalProductId: 1, quantity: 1.5, unitPriceCents: 23_600 }],
      context([rice]),
    )
    // 1.5 × 236.00 = 354.00 gross; the product's own 18% is inside it.
    expect(priced.totalCents).toBe(35_400)
    const split = splitInclusiveCents(35_400, 1_800)
    expect(priced.items[0]).toMatchObject({ priceCents: 23_600, taxRateBp: 1_800, taxCents: split.taxCents })
    expect(priced.subtotalCents).toBe(split.netCents)
    expect(priced.taxCents).toBe(split.taxCents)
  })

  it.each([0, 500, 1_700, 1_800, 2_500])("never adds tax on top: net + tax is the gross at %i bp", (rate) => {
    const priced = priceDeskOrderLines(
      [{ globalProductId: 2, quantity: 7, unitPriceCents: 10_001 }],
      context([boxes], [], rate),
    )
    expect(priced.totalCents).toBe(7 * 10_001)
    expect(priced.subtotalCents + priced.taxCents).toBe(priced.totalCents)
    expect(priced.items[0].taxRateBp).toBe(rate)
  })

  it("falls back to the organization's rate only when the product has none", () => {
    const priced = priceDeskOrderLines(
      [
        { globalProductId: 2, quantity: 1, unitPriceCents: 1_000 },
        { globalProductId: 3, quantity: 1, unitPriceCents: 1_000 },
      ],
      context([boxes, tape], [], 1_700),
    )
    expect(priced.items.map((line) => line.taxRateBp)).toEqual([1_700, 0])
  })

  it("records a product the branch does not carry with no lineage and no reference price", () => {
    const [line] = priceDeskOrderLines([{ globalProductId: 3, quantity: 2, unitPriceCents: 7_500 }], context([tape])).items
    expect(line).toMatchObject({
      organizationInventoryId: null,
      globalProductId: 3,
      priceCents: 7_500,
      priceEnteredManually: true,
      cataloguePriceCents: null,
      productName: "Tape",
      productCode: "P-3",
    })
  })

  it("records the branch's catalogue entry and price beside an entered price that differs", () => {
    const [line] = priceDeskOrderLines(
      [{ globalProductId: 2, quantity: 1, unitPriceCents: 900 }],
      context([boxes], [[2, { organizationInventoryId: 22, cataloguePriceCents: 1_000 }]]),
    ).items
    expect(line).toMatchObject({ organizationInventoryId: 22, priceCents: 900, priceEnteredManually: true, cataloguePriceCents: 1_000 })
  })

  it("does not flag an entered price equal to the branch's own, but keeps the lineage", () => {
    const [line] = priceDeskOrderLines(
      [{ globalProductId: 2, quantity: 1, unitPriceCents: 1_000 }],
      context([boxes], [[2, { organizationInventoryId: 22, cataloguePriceCents: 1_000 }]]),
    ).items
    expect(line).toMatchObject({ organizationInventoryId: 22, priceCents: 1_000, priceEnteredManually: false, cataloguePriceCents: null })
  })

  it.each([
    ["a missing product", 99, /no longer available/],
    ["an inactive product", 4, /no longer available/],
    ["a deleted product", 5, /no longer available/],
  ])("refuses %s", (_label, globalProductId, message) => {
    const products = [
      boxes,
      product({ id: 4, name: "Retired", status: "inactive" }),
      product({ id: 5, name: "Gone", deletedAt: new Date("2026-10-01") }),
    ]
    expect(() => priceDeskOrderLines([{ globalProductId, quantity: 1, unitPriceCents: 100 }], context(products)))
      .toThrow(message)
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["a fraction of a paisa", 10.5],
    ["over the ceiling", MAX_PRICE_CENTS + 1],
  ])("refuses a price that is %s, naming the product", (_label, unitPriceCents) => {
    expect(() => priceDeskOrderLines([{ globalProductId: 2, quantity: 1, unitPriceCents }], context([boxes])))
      .toThrow(new DeskLineRefusal("Enter a price above zero for Boxes"))
  })

  it("holds each product to its own quantity rules", () => {
    expect(() => priceDeskOrderLines([{ globalProductId: 2, quantity: 1.5, unitPriceCents: 100 }], context([boxes])))
      .toThrow(DeskLineRefusal)
    expect(priceDeskOrderLines([{ globalProductId: 1, quantity: 2.5, unitPriceCents: 100 }], context([rice])).items[0].quantity).toBe(2.5)
  })

  it("refuses the same product twice", () => {
    expect(() => priceDeskOrderLines(
      [{ globalProductId: 2, quantity: 1, unitPriceCents: 100 }, { globalProductId: 2, quantity: 2, unitPriceCents: 200 }],
      context([boxes]),
    )).toThrow("Each product can only appear once in an order")
  })

  it("adds the lines up exactly", () => {
    const priced = priceDeskOrderLines(
      [
        { globalProductId: 1, quantity: 0.5, unitPriceCents: 33_333 },
        { globalProductId: 2, quantity: 3, unitPriceCents: 1_001 },
        { globalProductId: 3, quantity: 1, unitPriceCents: 1 },
      ],
      context([rice, boxes, tape]),
    )
    expect(priced.totalCents).toBe(16_667 + 3_003 + 1)
    expect(priced.subtotalCents + priced.taxCents).toBe(priced.totalCents)
    expect(priced.items.reduce((sum, line) => sum + line.taxCents, 0)).toBe(priced.taxCents)
  })
})

describe("which products the desk may order", () => {
  it("is every active product that is not deleted", () => {
    expect(isActiveDeskProduct(boxes)).toBe(true)
    expect(isActiveDeskProduct({ status: "inactive", deletedAt: null })).toBe(false)
    expect(isActiveDeskProduct({ status: "active", deletedAt: "2026-10-01" })).toBe(false)
    expect(isActiveDeskProduct(undefined)).toBe(false)
  })
})
