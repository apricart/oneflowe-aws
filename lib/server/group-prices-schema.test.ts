import { describe, expect, it } from "vitest"

import { MAX_PRICE_CENTS } from "@/lib/price-ladder"
import {
  MAX_GROUP_PRICE_UPDATES,
  groupPricePropagationSchema,
  groupPricesUpdateSchema,
} from "@/lib/server/mutation-validation"

const price = (overrides: Record<string, unknown> = {}) => ({
  organizationInventoryId: 10,
  customPriceCents: 1_250,
  ...overrides,
})

const parse = (body: unknown) => groupPricesUpdateSchema.safeParse(body)

describe("group price update payloads", () => {
  it("accepts a set of prices", () => {
    const result = parse({ prices: [price(), price({ organizationInventoryId: 11 })] })
    expect(result.success).toBe(true)
  })

  it("accepts null as the instruction to clear an override", () => {
    const result = parse({ prices: [price({ customPriceCents: null })] })
    expect(result.success).toBe(true)
  })

  it("accepts zero, which is a price and not an absent one", () => {
    const result = parse({ prices: [price({ customPriceCents: 0 })] })
    expect(result.success).toBe(true)
  })

  it("rejects an empty batch", () => {
    expect(parse({ prices: [] }).success).toBe(false)
  })

  it("rejects a missing body", () => {
    expect(parse(null).success).toBe(false)
    expect(parse({}).success).toBe(false)
  })

  it("rejects the same product twice", () => {
    // Two prices for one product in one request have no defined winner; the
    // upsert would apply whichever the array happened to end on.
    const result = parse({
      prices: [price({ customPriceCents: 100 }), price({ customPriceCents: 200 })],
    })
    expect(result.success).toBe(false)
  })

  it.each([
    ["a negative price", -1],
    ["a fractional price", 12.5],
    ["a price above the storable range", MAX_PRICE_CENTS + 1],
    ["a string price", "1250"],
    ["an undefined price", undefined],
  ])("rejects %s", (_label, customPriceCents) => {
    expect(parse({ prices: [price({ customPriceCents })] }).success).toBe(false)
  })

  it.each([
    ["a missing product id", { organizationInventoryId: undefined }],
    ["a zero product id", { organizationInventoryId: 0 }],
    ["a negative product id", { organizationInventoryId: -3 }],
    ["a fractional product id", { organizationInventoryId: 1.5 }],
  ])("rejects %s", (_label, overrides) => {
    expect(parse({ prices: [price(overrides)] }).success).toBe(false)
  })

  it("rejects unknown fields rather than ignoring them", () => {
    // Strict parsing is what stops a client from smuggling, say, an
    // organizationId or groupId into a payload the route derives itself.
    expect(parse({ prices: [price({ groupId: 4 })] }).success).toBe(false)
    expect(parse({ prices: [price()], organizationId: 4 }).success).toBe(false)
  })

  it("caps how many prices one request may carry", () => {
    const within = Array.from({ length: MAX_GROUP_PRICE_UPDATES }, (_unused, index) =>
      price({ organizationInventoryId: index + 1 }))
    expect(parse({ prices: within }).success).toBe(true)

    const over = [...within, price({ organizationInventoryId: MAX_GROUP_PRICE_UPDATES + 1 })]
    expect(parse({ prices: over }).success).toBe(false)
  })

  it("coerces a numeric product id sent as a string", () => {
    // Ids arrive from query-string-shaped clients as strings; prices never do,
    // because a coerced price is how a typo becomes a charge.
    const result = parse({ prices: [price({ organizationInventoryId: "10" })] })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.prices[0].organizationInventoryId).toBe(10)
    }
  })
})

describe("group price propagation directives", () => {
  const parsePropagation = (body: unknown) => groupPricePropagationSchema.safeParse(body)

  it.each(["none", "all"])("accepts %s without a group list", (mode) => {
    expect(parsePropagation({ mode }).success).toBe(true)
  })

  it("accepts selected with a group list", () => {
    expect(parsePropagation({ mode: "selected", groupIds: [1, 2] }).success).toBe(true)
  })

  it("accepts selected with an empty list, which holds every group still", () => {
    expect(parsePropagation({ mode: "selected", groupIds: [] }).success).toBe(true)
  })

  it("rejects selected without a group list", () => {
    // Otherwise the server would have to guess, and guessing here silently
    // moves every unpriced group onto the new price.
    expect(parsePropagation({ mode: "selected" }).success).toBe(false)
  })

  it.each([
    ["an unknown mode", { mode: "everything" }],
    ["a missing mode", { groupIds: [1] }],
    ["a zero group id", { mode: "selected", groupIds: [0] }],
    ["a negative group id", { mode: "selected", groupIds: [-1] }],
    ["an unknown field", { mode: "all", applyToBranches: true }],
  ])("rejects %s", (_label, body) => {
    expect(parsePropagation(body).success).toBe(false)
  })
})
