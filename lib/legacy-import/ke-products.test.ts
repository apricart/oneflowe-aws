import { describe, expect, it } from "vitest"

import {
  normalizeProductName,
  planProducts,
  priceToCents,
  summarizeProducts,
  type CurrentProductMapping,
  type LegacyCategory,
  type LegacyItem,
} from "./ke-products"

function item(overrides: Partial<LegacyItem> & { ID: number; Name: string }): LegacyItem {
  return {
    CategoryID: 1,
    CategoryName: "Grocery",
    Description: null,
    Barcode: null,
    SKU: null,
    Price: 100,
    Unit: null,
    StatusID: 1,
    ...overrides,
  }
}

function category(id: number, locationId: number | null): LegacyCategory {
  return { ID: id, LocationID: locationId, Name: `cat ${id}` }
}

function mapping(overrides: Partial<CurrentProductMapping> & { normalizedName: string }): CurrentProductMapping {
  return { globalProductId: 1, organizationInventoryId: 1, basePriceCents: 10_000, ...overrides }
}

describe("normalizeProductName", () => {
  it("case folds, trims and collapses whitespace", () => {
    expect(normalizeProductName("  Olper   MILK (1 Litre) ")).toBe("olper milk (1 litre)")
  })

  it("applies NFKC so a full-width spelling joins the ASCII one", () => {
    expect(normalizeProductName("Ｓｕｇａｒ")).toBe("sugar")
  })

  it("returns empty for absent names rather than throwing", () => {
    expect(normalizeProductName(null)).toBe("")
    expect(normalizeProductName(undefined)).toBe("")
  })

  // Regression: these two legacy spellings must collapse to one product. When
  // they did not, nine August orders failed to import as PRODUCT_AMBIGUOUS
  // because the order line matched both catalogue entries.
  it("treats spacing inside brackets as the same product", () => {
    expect(normalizeProductName("Lipton Tea Bags ( 100 PCS )"))
      .toBe(normalizeProductName("Lipton Tea Bags (100 PCS)"))
  })
})

describe("catalogue and order import agree on the join key", () => {
  it("plans exactly one product for two bracket spellings of one name", () => {
    const plan = planProducts(
      [
        item({ ID: 1, Name: "Lipton Tea Bags ( 100 PCS )", CategoryID: 10, Price: 900 }),
        item({ ID: 2, Name: "Lipton Tea Bags (100 PCS)", CategoryID: 11, Price: 900 }),
      ],
      [category(10, 100), category(11, 101)],
      [],
    )
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].sourceCodes).toEqual(["1", "2"])
  })
})

describe("priceToCents", () => {
  it("converts whole currency units to integer cents", () => {
    expect(priceToCents(1550)).toBe(155_000)
    expect(priceToCents("320")).toBe(32_000)
  })

  it("rounds the way the order importer does, so a line total cannot drift", () => {
    expect(priceToCents(0.07)).toBe(7)
    expect(priceToCents(1.005)).toBe(101)
  })

  it("rejects absent and negative values", () => {
    expect(priceToCents(null)).toBeNull()
    expect(priceToCents("")).toBeNull()
    expect(priceToCents("abc")).toBeNull()
    expect(priceToCents(-5)).toBeNull()
  })
})

describe("planProducts", () => {
  it("collapses one row per location into a single product", () => {
    const items = [
      item({ ID: 1, Name: "Olper Milk (1 Litre)", CategoryID: 10, Price: 355 }),
      item({ ID: 2, Name: "olper milk (1 litre)", CategoryID: 11, Price: 355 }),
      item({ ID: 3, Name: "OLPER MILK (1 LITRE)", CategoryID: 12, Price: 355 }),
    ]
    const plan = planProducts(items, [category(10, 100), category(11, 101), category(12, 102)], [])

    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].normalizedName).toBe("olper milk (1 litre)")
    expect(plan.creates[0].basePriceCents).toBe(35_500)
    expect(plan.creates[0].branchCount).toBe(3)
    expect(plan.creates[0].sourceCodes).toEqual(["1", "2", "3"])
  })

  it("keeps the legacy spelling verbatim as the source name", () => {
    const plan = planProducts([item({ ID: 1, Name: "Olper Milk (1 Litre)" })], [category(1, 100)], [])
    expect(plan.creates[0].sourceName).toBe("Olper Milk (1 Litre)")
  })

  it("takes the modal price and reports every branch that disagrees", () => {
    const items = [
      item({ ID: 1, Name: "Candi", CategoryID: 10, Price: 320 }),
      item({ ID: 2, Name: "Candi", CategoryID: 11, Price: 320 }),
      item({ ID: 3, Name: "Candi", CategoryID: 12, Price: 320 }),
      item({ ID: 4, Name: "Candi", CategoryID: 13, Price: 390 }),
    ]
    const plan = planProducts(
      items,
      [category(10, 100), category(11, 101), category(12, 102), category(13, 103)],
      [],
    )

    expect(plan.creates[0].basePriceCents).toBe(32_000)
    expect(plan.creates[0].priceOutliers).toEqual([
      { legacyLocationId: 103, priceCents: 39_000, rows: 1 },
    ])
  })

  it("breaks a price tie toward the lower price", () => {
    const items = [
      item({ ID: 1, Name: "Tie", CategoryID: 10, Price: 390 }),
      item({ ID: 2, Name: "Tie", CategoryID: 11, Price: 320 }),
    ]
    const plan = planProducts(items, [category(10, 100), category(11, 101)], [])
    expect(plan.creates[0].basePriceCents).toBe(32_000)
  })

  it("never plans a create for a product already mapped", () => {
    const plan = planProducts(
      [item({ ID: 1, Name: "Sugar", Price: 100 })],
      [category(1, 100)],
      [mapping({ normalizedName: "sugar", globalProductId: 7, basePriceCents: 10_000 })],
    )

    expect(plan.creates).toHaveLength(0)
    expect(plan.existing).toEqual([
      {
        normalizedName: "sugar",
        globalProductId: 7,
        organizationInventoryId: 1,
        // Carried for every mapped product, agreeing or not — the organization
        // price tier needs legacy's price even where ours already matches.
        legacyModalCents: 10_000,
      },
    ])
    expect(plan.priceDrift).toHaveLength(0)
  })

  it("carries legacy's price on an existing product even when it disagrees with ours", () => {
    const plan = planProducts(
      [item({ ID: 1, Name: "Sugar", Price: 195 })],
      [category(1, 100)],
      [mapping({ normalizedName: "sugar", globalProductId: 7, basePriceCents: 16_200 })],
    )

    expect(plan.existing[0].legacyModalCents).toBe(19_500)
    expect(plan.priceDrift).toEqual([
      { normalizedName: "sugar", globalProductId: 7, currentCents: 16_200, legacyModalCents: 19_500 },
    ])
  })

  it("reports a price disagreement on an existing product instead of changing it", () => {
    const plan = planProducts(
      [item({ ID: 1, Name: "Sugar", Price: 250 })],
      [category(1, 100)],
      [mapping({ normalizedName: "sugar", globalProductId: 7, basePriceCents: 10_000 })],
    )

    expect(plan.creates).toHaveLength(0)
    expect(plan.priceDrift).toEqual([
      { normalizedName: "sugar", globalProductId: 7, currentCents: 10_000, legacyModalCents: 25_000 },
    ])
  })

  // Created, not skipped: historical orders reference these and without a
  // catalogue entry the whole order is refused as PRODUCT_NOT_FOUND. The zero
  // never reaches an imported order, which carries its own line price.
  it("still creates a product legacy never prices, at zero, and says so", () => {
    const plan = planProducts(
      [item({ ID: 1, Name: "Freebie", Price: 0 }), item({ ID: 2, Name: "Freebie", Price: null })],
      [category(1, 100)],
      [],
    )

    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].normalizedName).toBe("freebie")
    expect(plan.creates[0].basePriceCents).toBe(0)
    expect(plan.skipped).toEqual([
      {
        normalizedName: "freebie",
        sourceName: "Freebie",
        reason: "NO_PRICE",
        detail: "all 2 legacy rows carry a zero or absent price; created at zero",
      },
    ])
  })

  it("skips an unnamed row rather than joining every one of them together", () => {
    const plan = planProducts([item({ ID: 9, Name: "  " })], [category(1, 100)], [])
    expect(plan.creates).toHaveLength(0)
    expect(plan.skipped[0].reason).toBe("NO_NAME")
  })

  it("ignores zero-priced rows when choosing the modal price", () => {
    const items = [
      item({ ID: 1, Name: "Rice", CategoryID: 10, Price: 0 }),
      item({ ID: 2, Name: "Rice", CategoryID: 11, Price: 0 }),
      item({ ID: 3, Name: "Rice", CategoryID: 12, Price: 500 }),
    ]
    const plan = planProducts(items, [category(10, 100), category(11, 101), category(12, 102)], [])
    expect(plan.creates[0].basePriceCents).toBe(50_000)
  })

  it("collects each category once, in first-seen order", () => {
    const items = [
      item({ ID: 1, Name: "A", CategoryID: 10, CategoryName: "Grocery" }),
      item({ ID: 2, Name: "B", CategoryID: 11, CategoryName: "Beverages" }),
      item({ ID: 3, Name: "C", CategoryID: 12, CategoryName: "Grocery" }),
    ]
    const plan = planProducts(items, [category(10, 1), category(11, 2), category(12, 3)], [])
    expect(plan.categories).toEqual(["Grocery", "Beverages"])
  })

  it("tolerates an item whose category is unknown", () => {
    const plan = planProducts([item({ ID: 1, Name: "Orphan", CategoryID: 999 })], [], [])
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].branchCount).toBe(0)
  })

  it("is idempotent: planning against its own result creates nothing", () => {
    const items = [item({ ID: 1, Name: "Sugar", Price: 100 })]
    const first = planProducts(items, [category(1, 100)], [])
    expect(first.creates).toHaveLength(1)

    const applied: CurrentProductMapping[] = first.creates.map((entry, index) => ({
      normalizedName: entry.normalizedName,
      globalProductId: index + 1,
      organizationInventoryId: index + 1,
      basePriceCents: entry.basePriceCents,
    }))
    const second = planProducts(items, [category(1, 100)], applied)

    expect(second.creates).toHaveLength(0)
    expect(second.priceDrift).toHaveLength(0)
    expect(second.existing).toHaveLength(1)
  })
})

describe("summarizeProducts", () => {
  it("counts what a person needs to decide from", () => {
    const items = [
      item({ ID: 1, Name: "Candi", CategoryID: 10, Price: 320 }),
      item({ ID: 2, Name: "Candi", CategoryID: 11, Price: 390 }),
      item({ ID: 3, Name: "Sugar", CategoryID: 10, Price: 100 }),
      item({ ID: 4, Name: "Freebie", CategoryID: 10, Price: 0 }),
    ]
    const plan = planProducts(items, [category(10, 100), category(11, 101)], [])
    const counts = summarizeProducts(plan, items.length)

    // Three products: Candi, Sugar, and the unpriced Freebie created at zero.
    // Freebie is counted in `skipped` as well, because that list is what tells a
    // person legacy never gave it a price.
    expect(counts).toEqual({
      legacyRows: 4,
      distinctProducts: 3,
      toCreate: 3,
      alreadyMapped: 0,
      priceDrift: 0,
      skipped: 1,
      productsWithPriceOutliers: 1,
      outlierRows: 1,
    })
  })
})

describe("products retired from the item list but present in the price history", () => {
  const history = [
    { Date: "2025-03-01T00:00:00", ItemName: "Biscuits Marrie", Price: 200 },
    { Date: "2025-09-01T00:00:00", ItemName: "Biscuits Marrie", Price: 250 },
  ]

  it("creates them, so their historical orders can still import", () => {
    const plan = planProducts([item({ ID: 1, Name: "Sugar" })], [category(1, 100)], [], history)
    const retired = plan.creates.find((entry) => entry.normalizedName === "biscuits marrie")
    expect(retired).toBeDefined()
    expect(retired!.source).toBe("price-history")
  })

  it("prices them at the most recent price the history records", () => {
    const plan = planProducts([], [], [], history)
    expect(plan.creates[0].basePriceCents).toBe(25_000)
  })

  it("does not duplicate a product the item list already covers", () => {
    const plan = planProducts(
      [item({ ID: 1, Name: "Biscuits Marrie", Price: 300 })],
      [category(1, 100)],
      [],
      history,
    )
    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].source).toBe("item-list")
    expect(plan.creates[0].basePriceCents).toBe(30_000)
  })

  it("does not recreate one that is already mapped", () => {
    const plan = planProducts([], [], [mapping({ normalizedName: "biscuits marrie", basePriceCents: 25_000 })], history)
    expect(plan.creates).toHaveLength(0)
    expect(plan.existing).toHaveLength(1)
  })

  it("ignores history rows with no usable price", () => {
    const plan = planProducts([], [], [], [{ Date: "2025-01-01", ItemName: "Freebie", Price: 0 }])
    expect(plan.creates).toHaveLength(0)
  })
})
