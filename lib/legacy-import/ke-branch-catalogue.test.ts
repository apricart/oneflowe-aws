import { describe, expect, it } from "vitest"

import {
  planBranchCatalogue,
  summarizeBranchCatalogue,
  type CurrentBranchAssignment,
  type CurrentCatalogueEntry,
} from "./ke-branch-catalogue"
import type { LegacyCategory, LegacyItem } from "./ke-products"

// Legacy: category 10 belongs to location 1, category 20 to location 2.
const categories: LegacyCategory[] = [
  { ID: 10, LocationID: 1, Name: "Tea" },
  { ID: 20, LocationID: 2, Name: "Tea" },
  { ID: 30, LocationID: null, Name: "Orphan" },
]

function item(id: number, name: string, categoryId: number, statusId = 1): LegacyItem {
  return { ID: id, Name: name, CategoryID: categoryId, Price: 100, StatusID: statusId }
}

function entry(overrides: Partial<CurrentCatalogueEntry> & { normalizedName: string }): CurrentCatalogueEntry {
  return {
    globalProductId: 100,
    organizationInventoryId: 200,
    organizationInventoryActive: true,
    productActive: true,
    legacyOwned: true,
    stockQuantity: 500,
    ...overrides,
  }
}

function row(overrides: Partial<CurrentBranchAssignment> & { branchId: number; organizationInventoryId: number }): CurrentBranchAssignment {
  return { isVisible: true, isActive: true, deleted: false, ...overrides }
}

const pins = (...ids: number[]) =>
  new Map(ids.map((id) => [id, { branchId: id * 10, name: `Branch ${id}` }]))

const options = { stockLevel: 500, resetStock: false }

describe("planBranchCatalogue", () => {
  it("assigns a mapped, active product to the branch pinned to its legacy location", () => {
    const plan = planBranchCatalogue(
      [item(1, "Tapal Danedar (100 PCS)", 10)],
      categories,
      pins(1),
      [entry({ normalizedName: "tapal danedar (100 pcs)" })],
      [],
      options,
    )
    expect(plan.assignments).toEqual([{
      branchId: 10,
      branchName: "Branch 1",
      legacyLocationId: 1,
      organizationInventoryId: 200,
      normalizedName: "tapal danedar (100 pcs)",
      action: "CREATE",
    }])
    expect(plan.activations).toHaveLength(0)
    expect(plan.stockChanges).toHaveLength(0)
    expect(plan.unchanged).toBe(0)
  })

  it("restores a row that exists but is hidden, inactive or soft-deleted", () => {
    const catalogue = [
      entry({ normalizedName: "a", organizationInventoryId: 1 }),
      entry({ normalizedName: "b", organizationInventoryId: 2 }),
      entry({ normalizedName: "c", organizationInventoryId: 3 }),
    ]
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "B", 10), item(3, "C", 10)],
      categories,
      pins(1),
      catalogue,
      [
        row({ branchId: 10, organizationInventoryId: 1, isVisible: false }),
        row({ branchId: 10, organizationInventoryId: 2, isActive: false }),
        row({ branchId: 10, organizationInventoryId: 3, deleted: true }),
      ],
      options,
    )
    expect(plan.assignments.map((entry) => [entry.organizationInventoryId, entry.action])).toEqual([
      [1, "RESTORE"], [2, "RESTORE"], [3, "RESTORE"],
    ])
  })

  it("counts a visible, active row as unchanged", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10)],
      categories,
      pins(1),
      [entry({ normalizedName: "a" })],
      [row({ branchId: 10, organizationInventoryId: 200 })],
      options,
    )
    expect(plan.assignments).toHaveLength(0)
    expect(plan.unchanged).toBe(1)
  })

  // The shop joins through organization_inventory.is_active, so an assignment
  // to a dormant catalogue entry would still show nothing.
  it("activates a dormant catalogue entry legacy still sells, once, whatever the number of locations", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "A", 20)],
      categories,
      pins(1, 2),
      [entry({ normalizedName: "a", organizationInventoryActive: false })],
      [],
      options,
    )
    expect(plan.activations).toEqual([{
      normalizedName: "a",
      globalProductId: 100,
      organizationInventoryId: 200,
      locations: 2,
    }])
    expect(plan.assignments).toHaveLength(2)
  })

  it("does not activate a product legacy no longer lists anywhere", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10)],
      categories,
      pins(1),
      [
        entry({ normalizedName: "a", organizationInventoryId: 1 }),
        entry({ normalizedName: "retired", organizationInventoryId: 2, organizationInventoryActive: false }),
      ],
      [],
      options,
    )
    expect(plan.activations).toHaveLength(0)
  })

  // Orders are refused beyond stock_quantity, so a zero-stock product is
  // unorderable however visible it is.
  it("sets stock only on a zero-stock product legacy sells, on an ordinary run", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "B", 10)],
      categories,
      pins(1),
      [
        entry({ normalizedName: "a", organizationInventoryId: 1, globalProductId: 11, stockQuantity: 0 }),
        entry({ normalizedName: "b", organizationInventoryId: 2, globalProductId: 12, stockQuantity: 3 }),
      ],
      [],
      options,
    )
    expect(plan.stockChanges).toEqual([{ normalizedName: "a", globalProductId: 11, currentStock: 0, stockQuantity: 500 }])
  })

  // The one deliberate way to overwrite a figure someone typed or orders wore down.
  it("sets every product legacy sells to the level when a reset is requested", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "B", 10), item(3, "C", 10)],
      categories,
      pins(1),
      [
        entry({ normalizedName: "a", organizationInventoryId: 1, globalProductId: 11, stockQuantity: 0 }),
        entry({ normalizedName: "b", organizationInventoryId: 2, globalProductId: 12, stockQuantity: 4855 }),
        entry({ normalizedName: "c", organizationInventoryId: 3, globalProductId: 13, stockQuantity: 500 }),
        entry({ normalizedName: "retired", organizationInventoryId: 4, globalProductId: 14, stockQuantity: 9 }),
      ],
      [],
      { stockLevel: 500, resetStock: true },
    )
    expect(plan.stockChanges.map((change) => [change.globalProductId, change.currentStock, change.stockQuantity])).toEqual([
      [11, 0, 500], [12, 4855, 500],
    ])
  })

  // Production: "millac tea whitener 850gm" and "milac instant tea whitener
  // (850gm)" both map to product 238. The commit writes each row once and is
  // pinned to the value the plan saw, so a duplicate would refuse the run.
  it("plans catalogue-level work once per row when two legacy names map to one product", () => {
    const plan = planBranchCatalogue(
      [item(1, "Millac Tea Whitener 850gm", 10), item(2, "Milac Instant Tea Whitener (850gm)", 20)],
      categories,
      pins(1, 2),
      [
        entry({ normalizedName: "millac tea whitener 850gm", organizationInventoryId: 7, globalProductId: 238, productActive: false, organizationInventoryActive: false, stockQuantity: 0 }),
        entry({ normalizedName: "milac instant tea whitener (850gm)", organizationInventoryId: 7, globalProductId: 238, productActive: false, organizationInventoryActive: false, stockQuantity: 0 }),
      ],
      [],
      options,
    )
    expect(plan.globalActivations).toEqual([expect.objectContaining({ globalProductId: 238, locations: 2 })])
    expect(plan.activations).toEqual([expect.objectContaining({ organizationInventoryId: 7, locations: 2 })])
    expect(plan.stockChanges).toEqual([expect.objectContaining({ globalProductId: 238, currentStock: 0, stockQuantity: 500 })])
    // The branch rows are still one per legacy pair: the same row at two branches.
    expect(plan.assignments.map((a) => [a.branchId, a.organizationInventoryId])).toEqual([[10, 7], [20, 7]])
  })

  it("plans one branch row when both names are listed at the same location", () => {
    const catalogue = [
      entry({ normalizedName: "millac tea whitener 850gm", organizationInventoryId: 7, globalProductId: 238 }),
      entry({ normalizedName: "milac instant tea whitener (850gm)", organizationInventoryId: 7, globalProductId: 238 }),
    ]
    const plan = planBranchCatalogue(
      [item(1, "Millac Tea Whitener 850gm", 10), item(2, "Milac Instant Tea Whitener (850gm)", 10)],
      categories,
      pins(1),
      catalogue,
      [],
      options,
    )
    expect(plan.assignments).toHaveLength(1)
    expect(plan.legacyPairs).toBe(1)

    const visible = planBranchCatalogue(
      [item(1, "Millac Tea Whitener 850gm", 10), item(2, "Milac Instant Tea Whitener (850gm)", 10)],
      categories,
      pins(1),
      catalogue,
      [row({ branchId: 10, organizationInventoryId: 7 })],
      options,
    )
    expect(visible.assignments).toHaveLength(0)
    expect(visible.unchanged).toBe(1)
  })

  it("refuses a non-positive stock level", () => {
    expect(() => planBranchCatalogue([], categories, pins(), [], [], { stockLevel: 0, resetStock: false })).toThrow(/stockLevel/)
    expect(() => planBranchCatalogue([], categories, pins(), [], [], { stockLevel: 1.5, resetStock: false })).toThrow(/stockLevel/)
  })

  // The legacy order import parked its products `inactive` globally so
  // historical lines would resolve without the product appearing anywhere.
  it("activates a global product the import created and legacy still sells, then treats it as sellable", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "A", 20)],
      categories,
      pins(1, 2),
      [entry({ normalizedName: "a", productActive: false, legacyOwned: true, organizationInventoryActive: false, stockQuantity: 0 })],
      [],
      options,
    )
    expect(plan.globalActivations).toEqual([{ normalizedName: "a", globalProductId: 100, locations: 2 }])
    expect(plan.activations).toHaveLength(1)
    expect(plan.stockChanges).toHaveLength(1)
    expect(plan.assignments).toHaveLength(2)
    expect(plan.skipped).toHaveLength(0)
  })

  // A global product has reach beyond this tenant, so one retired by another
  // hand is left retired.
  it("never assigns or activates a product someone other than the import retired", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10)],
      categories,
      pins(1),
      [entry({ normalizedName: "a", productActive: false, legacyOwned: false, organizationInventoryActive: false, stockQuantity: 0 })],
      [],
      options,
    )
    expect(plan.assignments).toHaveLength(0)
    expect(plan.globalActivations).toHaveLength(0)
    expect(plan.activations).toHaveLength(0)
    expect(plan.stockChanges).toHaveLength(0)
    expect(plan.skipped).toEqual([expect.objectContaining({ legacyLocationId: 1, reason: "PRODUCT_RETIRED" })])
  })

  it("skips a location no branch is pinned to, and a product with no mapping", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "Unknown", 20)],
      categories,
      pins(2),
      [entry({ normalizedName: "a" })],
      [],
      options,
    )
    expect(plan.assignments).toHaveLength(0)
    expect(plan.skipped.map((entry) => [entry.legacyLocationId, entry.reason])).toEqual([
      [1, "LOCATION_NOT_PINNED"],
      [2, "PRODUCT_NOT_MAPPED"],
    ])
  })

  it("skips an item whose category belongs to no location", () => {
    const plan = planBranchCatalogue([item(1, "A", 30)], categories, pins(1), [entry({ normalizedName: "a" })], [], options)
    expect(plan.skipped).toEqual([expect.objectContaining({ legacyLocationId: null, reason: "NO_LOCATION" })])
  })

  it("ignores a legacy item that is not active", () => {
    const plan = planBranchCatalogue([item(1, "A", 10, 0)], categories, pins(1), [entry({ normalizedName: "a" })], [], options)
    expect(plan.assignments).toHaveLength(0)
    expect(plan.skipped).toHaveLength(0)
    expect(plan.legacyPairs).toBe(0)
  })

  // Never hidden: the sync does not deactivate anything, it reports.
  it("reports a visible product legacy does not list at that branch, without planning to hide it", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10)],
      categories,
      pins(1, 2),
      [entry({ normalizedName: "a", organizationInventoryId: 1 }), entry({ normalizedName: "b", organizationInventoryId: 2 })],
      [
        row({ branchId: 10, organizationInventoryId: 1 }),
        row({ branchId: 10, organizationInventoryId: 2 }),
        row({ branchId: 10, organizationInventoryId: 3, isVisible: false }),
        row({ branchId: 999, organizationInventoryId: 2 }),
      ],
      options,
    )
    expect(plan.extras).toEqual([{ branchId: 10, branchName: "Branch 1", organizationInventoryId: 2, normalizedName: "b" }])
    expect(plan.unchanged).toBe(1)
  })

  it("is idempotent: planning against its own result changes nothing", () => {
    const items = [item(1, "A", 10), item(2, "B", 10), item(3, "A", 20)]
    const catalogue = [
      entry({ normalizedName: "a", organizationInventoryId: 1, globalProductId: 11, productActive: false, organizationInventoryActive: false, stockQuantity: 0 }),
      entry({ normalizedName: "b", organizationInventoryId: 2, globalProductId: 12 }),
    ]
    const first = planBranchCatalogue(items, categories, pins(1, 2), catalogue, [], options)
    expect(first.assignments).toHaveLength(3)
    expect(first.globalActivations).toHaveLength(1)
    expect(first.activations).toHaveLength(1)
    expect(first.stockChanges).toHaveLength(1)

    const applied: CurrentCatalogueEntry[] = catalogue.map((row) => ({
      ...row,
      productActive: row.productActive
        || first.globalActivations.some((a) => a.globalProductId === row.globalProductId),
      organizationInventoryActive: row.organizationInventoryActive
        || first.activations.some((a) => a.organizationInventoryId === row.organizationInventoryId),
      stockQuantity: first.stockChanges.find((g) => g.globalProductId === row.globalProductId)?.stockQuantity ?? row.stockQuantity,
    }))
    const rows: CurrentBranchAssignment[] = first.assignments.map((a) => row({
      branchId: a.branchId,
      organizationInventoryId: a.organizationInventoryId,
    }))
    const second = planBranchCatalogue(items, categories, pins(1, 2), applied, rows, options)
    expect(second.assignments).toHaveLength(0)
    expect(second.globalActivations).toHaveLength(0)
    expect(second.activations).toHaveLength(0)
    expect(second.stockChanges).toHaveLength(0)
    expect(second.extras).toHaveLength(0)
    expect(second.unchanged).toBe(3)
  })
})

describe("summarizeBranchCatalogue", () => {
  it("counts what the commit would write", () => {
    const plan = planBranchCatalogue(
      [item(1, "A", 10), item(2, "B", 10), item(3, "A", 20), item(4, "Nope", 20)],
      categories,
      pins(1, 2),
      [
        entry({ normalizedName: "a", organizationInventoryId: 1, globalProductId: 11, organizationInventoryActive: false, stockQuantity: 0 }),
        entry({ normalizedName: "b", organizationInventoryId: 2, globalProductId: 12 }),
      ],
      [row({ branchId: 10, organizationInventoryId: 2, isVisible: false }), row({ branchId: 20, organizationInventoryId: 2 })],
      options,
    )
    expect(summarizeBranchCatalogue(plan)).toEqual({
      legacyLocations: 2,
      legacyPairs: 4,
      globalActivations: 0,
      activations: 1,
      stockChanges: 1,
      toCreate: 2,
      toRestore: 1,
      unchanged: 0,
      extras: 1,
      skipped: 1,
      branchesTouched: 2,
    })
  })
})
