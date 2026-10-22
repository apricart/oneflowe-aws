import { describe, expect, it } from "vitest"

import { MAX_PRICE_CENTS } from "@/lib/price-ladder"

import {
  enteredPriceLines,
  isValidEnteredUnitPriceCents,
  MIN_ENTERED_UNIT_PRICE_CENTS,
  resolveOrderLinePrice,
} from "./order-line-price"

describe("the price an order line is charged", () => {
  it("is the catalogue price when nothing was entered, as every order always was", () => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000 })).toEqual({
      ok: true,
      priceCents: 6_000,
      priceEnteredManually: false,
      cataloguePriceCents: null,
    })
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000, enteredPriceCents: null }).ok).toBe(true)
  })

  it("keeps a free catalogue price free", () => {
    // A zero catalogue price is the ladder's answer, not the desk's, so it stands.
    expect(resolveOrderLinePrice({ cataloguePriceCents: 0 })).toMatchObject({ ok: true, priceCents: 0, priceEnteredManually: false })
  })

  it("is the entered price when the desk typed one, recording what it replaced", () => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000, enteredPriceCents: 5_500 })).toEqual({
      ok: true,
      priceCents: 5_500,
      priceEnteredManually: true,
      cataloguePriceCents: 6_000,
    })
    // Above the catalogue price too: the agreed price is the agreed price.
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000, enteredPriceCents: 7_000 })).toMatchObject({
      priceCents: 7_000,
      priceEnteredManually: true,
    })
  })

  it("does not flag an entered price equal to the catalogue's", () => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000, enteredPriceCents: 6_000 })).toEqual({
      ok: true,
      priceCents: 6_000,
      priceEnteredManually: false,
      cataloguePriceCents: null,
    })
  })

  it("prices a product the catalogue has no price for, only when one is entered", () => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: null })).toEqual({ ok: false, reason: "no-price" })
    expect(resolveOrderLinePrice({ cataloguePriceCents: undefined })).toEqual({ ok: false, reason: "no-price" })
    expect(resolveOrderLinePrice({ cataloguePriceCents: null, enteredPriceCents: 900 })).toEqual({
      ok: true,
      priceCents: 900,
      priceEnteredManually: true,
      cataloguePriceCents: null,
    })
  })

  it("treats a corrupt catalogue figure as no price", () => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: -1 })).toEqual({ ok: false, reason: "no-price" })
    expect(resolveOrderLinePrice({ cataloguePriceCents: 1.5 })).toEqual({ ok: false, reason: "no-price" })
    expect(resolveOrderLinePrice({ cataloguePriceCents: -1, enteredPriceCents: 100 })).toMatchObject({
      priceCents: 100,
      cataloguePriceCents: null,
    })
  })

  it.each([
    ["zero", 0],
    ["a negative price", -100],
    ["a fraction of a paisa", 10.5],
    ["more than the ladder's ceiling", MAX_PRICE_CENTS + 1],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("refuses an entered price of %s", (_label, entered) => {
    expect(resolveOrderLinePrice({ cataloguePriceCents: 6_000, enteredPriceCents: entered })).toEqual({
      ok: false,
      reason: "invalid-entered-price",
    })
  })

  it("accepts the bounds themselves", () => {
    expect(isValidEnteredUnitPriceCents(MIN_ENTERED_UNIT_PRICE_CENTS)).toBe(true)
    expect(isValidEnteredUnitPriceCents(MAX_PRICE_CENTS)).toBe(true)
    expect(isValidEnteredUnitPriceCents("100")).toBe(false)
  })
})

describe("the audit trail of entered prices", () => {
  it("lists only the hand-priced lines, with both figures", () => {
    expect(enteredPriceLines([
      { organizationInventoryId: 1, productName: "Rice", priceCents: 5_500, priceEnteredManually: true, cataloguePriceCents: 6_000 },
      { organizationInventoryId: 2, productName: "Boxes", priceCents: 1_000, priceEnteredManually: false, cataloguePriceCents: null },
      { organizationInventoryId: 3, productName: "Tape", priceCents: 900, priceEnteredManually: true, cataloguePriceCents: null },
      { productName: "Legacy line", priceCents: 100 },
    ])).toEqual([
      { organizationInventoryId: 1, productName: "Rice", priceCents: 5_500, cataloguePriceCents: 6_000 },
      { organizationInventoryId: 3, productName: "Tape", priceCents: 900, cataloguePriceCents: null },
    ])
  })
})
