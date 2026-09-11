import { describe, expect, it } from "vitest"

import {
  legacyPriceByInventoryId,
  planOrganizationPrices,
  summarizeOrganizationPrices,
  type CurrentOrgInventory,
} from "./ke-org-prices"
import type { ExistingProduct, ProductPlan } from "./ke-products"

function existing(overrides: Partial<ExistingProduct> = {}): ExistingProduct {
  return {
    normalizedName: "sugar",
    globalProductId: 500,
    organizationInventoryId: 1,
    legacyModalCents: 19_500,
    ...overrides,
  }
}

function productPlan(rows: ExistingProduct[]): ProductPlan {
  return { creates: [], existing: rows, priceDrift: [], skipped: [], categories: [] } as unknown as ProductPlan
}

function row(overrides: Partial<CurrentOrgInventory> = {}): CurrentOrgInventory {
  return {
    organizationInventoryId: 1,
    globalProductId: 500,
    productName: "Sugar",
    customPriceCents: 16_200,
    globalBasePriceCents: 16_200,
    isActive: true,
    ...overrides,
  }
}

describe("legacyPriceByInventoryId", () => {
  it("collapses agreeing duplicates from the two planProducts branches", () => {
    const { prices, ambiguous } = legacyPriceByInventoryId(productPlan([
      existing({ legacyModalCents: 19_500 }),
      existing({ legacyModalCents: 19_500 }),
    ]))
    expect(prices.get(1)).toBe(19_500)
    expect(ambiguous.size).toBe(0)
  })

  it("refuses to choose when the two sources disagree", () => {
    const { prices, ambiguous } = legacyPriceByInventoryId(productPlan([
      existing({ legacyModalCents: 19_500 }),
      existing({ legacyModalCents: 21_000 }),
    ]))
    expect(prices.has(1)).toBe(false)
    expect(ambiguous.get(1)).toEqual([19_500, 21_000])
  })
})

describe("planOrganizationPrices", () => {
  it("moves the organization price to legacy's", () => {
    const plan = planOrganizationPrices([row()], productPlan([existing()]))
    expect(plan.changes).toHaveLength(1)
    expect(plan.changes[0]).toMatchObject({
      organizationInventoryId: 1,
      fromCents: 16_200,
      toCents: 19_500,
      effectiveBeforeCents: 16_200,
    })
  })

  it("gives an inheriting row an explicit price, and reports what it paid before", () => {
    const plan = planOrganizationPrices(
      [row({ customPriceCents: null, globalBasePriceCents: 16_200 })],
      productPlan([existing()]),
    )
    expect(plan.changes[0]).toMatchObject({
      fromCents: null, toCents: 19_500, effectiveBeforeCents: 16_200,
    })
  })

  it("does not rewrite a row that already holds legacy's price", () => {
    const plan = planOrganizationPrices(
      [row({ customPriceCents: 19_500 })],
      productPlan([existing({ legacyModalCents: 19_500 })]),
    )
    expect(plan.changes).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  // Rule 1 — the two products legacy never prices.
  it("refuses to write a zero price", () => {
    const plan = planOrganizationPrices([row()], productPlan([existing({ legacyModalCents: 0 })]))
    expect(plan.changes).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("LEGACY_HAS_NO_PRICE")
  })

  it("refuses a negative price", () => {
    const plan = planOrganizationPrices([row()], productPlan([existing({ legacyModalCents: -1 })]))
    expect(plan.skipped[0].reason).toBe("LEGACY_HAS_NO_PRICE")
  })

  it("skips a row legacy knows nothing about", () => {
    const plan = planOrganizationPrices([row({ organizationInventoryId: 99 })], productPlan([existing()]))
    expect(plan.changes).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("NOT_IN_LEGACY")
  })

  it("skips a row whose legacy price is ambiguous rather than picking one", () => {
    const plan = planOrganizationPrices([row()], productPlan([
      existing({ legacyModalCents: 19_500 }),
      existing({ legacyModalCents: 21_000 }),
    ]))
    expect(plan.changes).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("AMBIGUOUS_LEGACY_PRICE")
  })

  it("plans an inactive row the same way — visibility is not pricing", () => {
    const plan = planOrganizationPrices([row({ isActive: false })], productPlan([existing()]))
    expect(plan.changes).toHaveLength(1)
  })

  it("is deterministic regardless of input order", () => {
    const rows = [
      row({ organizationInventoryId: 3, globalProductId: 3 }),
      row({ organizationInventoryId: 1, globalProductId: 1 }),
      row({ organizationInventoryId: 2, globalProductId: 2 }),
    ]
    const products = productPlan([
      existing({ organizationInventoryId: 1, globalProductId: 1 }),
      existing({ organizationInventoryId: 2, globalProductId: 2 }),
      existing({ organizationInventoryId: 3, globalProductId: 3 }),
    ])
    const forward = planOrganizationPrices(rows, products)
    const reversed = planOrganizationPrices([...rows].reverse(), products)
    expect(forward).toEqual(reversed)
    expect(forward.changes.map((c) => c.organizationInventoryId)).toEqual([1, 2, 3])
  })

  it("never reports a global product id it was not given", () => {
    const plan = planOrganizationPrices([row({ globalProductId: 500 })], productPlan([existing()]))
    for (const change of plan.changes) expect(change.globalProductId).toBe(500)
  })
})

describe("summarizeOrganizationPrices", () => {
  it("separates a rise from a fall in what the branch actually pays", () => {
    const plan = planOrganizationPrices(
      [
        row({ organizationInventoryId: 1, customPriceCents: 16_200 }),
        row({ organizationInventoryId: 2, customPriceCents: 30_000 }),
        row({ organizationInventoryId: 3, customPriceCents: null, globalBasePriceCents: 19_500 }),
      ],
      productPlan([
        existing({ organizationInventoryId: 1 }),
        existing({ organizationInventoryId: 2 }),
        existing({ organizationInventoryId: 3 }),
      ]),
    )
    const counts = summarizeOrganizationPrices(plan)
    expect(counts.effectiveIncreases).toBe(1)   // 16_200 -> 19_500
    expect(counts.effectiveDecreases).toBe(1)   // 30_000 -> 19_500
    expect(counts.effectiveUnchanged).toBe(1)   // inherited 19_500, now explicit
    expect(counts.fromInherited).toBe(1)
  })

  it("accounts for every row exactly once", () => {
    const plan = planOrganizationPrices(
      [
        row({ organizationInventoryId: 1 }),
        row({ organizationInventoryId: 2, customPriceCents: 19_500 }),
        row({ organizationInventoryId: 3 }),
      ],
      productPlan([
        existing({ organizationInventoryId: 1 }),
        existing({ organizationInventoryId: 2 }),
        existing({ organizationInventoryId: 3, legacyModalCents: 0 }),
      ]),
    )
    const counts = summarizeOrganizationPrices(plan)
    expect(counts.rowsConsidered).toBe(3)
    expect(counts.toChange + counts.unchanged + counts.skipped).toBe(3)
  })
})
