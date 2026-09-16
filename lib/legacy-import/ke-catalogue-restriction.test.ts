import { describe, expect, it } from "vitest"

import type { CurrentBranchAssignment } from "./ke-branch-catalogue"
import {
  catalogueRestrictionPlanLines,
  catalogueRestrictionReversalLines,
  planCatalogueRestriction,
  planCatalogueRestrictionReversal,
  summarizeCatalogueRestriction,
  type OrganizationEntry,
} from "./ke-catalogue-restriction"
import type { MappedProduct, WantedProduct } from "./ke-group-catalogue"

function wanted(...names: string[]): WantedProduct[] {
  return names.map((sourceName) => ({ sourceName }))
}

function mapping(overrides: Partial<MappedProduct> & { normalizedName: string; organizationInventoryId: number; globalProductId: number }): MappedProduct {
  return { productName: overrides.normalizedName, organizationInventoryActive: true, productActive: true, stockQuantity: 500, ...overrides }
}

function entry(overrides: Partial<OrganizationEntry> & { organizationInventoryId: number }): OrganizationEntry {
  return { globalProductId: overrides.organizationInventoryId + 1000, productName: `Product ${overrides.organizationInventoryId}`, isActive: true, ...overrides }
}

function row(overrides: Partial<CurrentBranchAssignment> & { branchId: number; organizationInventoryId: number }): CurrentBranchAssignment {
  return { isVisible: true, isActive: true, deleted: false, ...overrides }
}

// The list names sugar (kept). Coffee is a twin outside the list; tea is
// outside the list and already off; test is outside the list with no rows.
const sugarMapping = mapping({ normalizedName: "sugar", organizationInventoryId: 268, globalProductId: 7, productName: "Sugar" })
const sugar = entry({ organizationInventoryId: 268, globalProductId: 7, productName: "Sugar" })
const coffee = entry({ organizationInventoryId: 193, globalProductId: 183, productName: "Coffee Pods Eespresso (8 boxes)" })
const tea = entry({ organizationInventoryId: 177, globalProductId: 167, productName: "tea", isActive: false })
const test = entry({ organizationInventoryId: 425, globalProductId: 348, productName: "test" })

describe("planCatalogueRestriction", () => {
  it("keeps every listed product and deactivates every active entry outside the list", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar"),
      [sugarMapping],
      [sugar, coffee, tea, test],
      [row({ branchId: 10, organizationInventoryId: 268 }), row({ branchId: 10, organizationInventoryId: 193 })],
    )

    expect(plan.kept.map((product) => product.organizationInventoryId)).toEqual([268])
    expect(plan.activations).toEqual([])
    expect(plan.deactivations.map((entry) => entry.organizationInventoryId)).toEqual([193, 425])
    expect(plan.alreadyInactive).toEqual([tea])
  })

  it("records every non-deleted branch row of a deactivated entry with its before-state", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar"),
      [sugarMapping],
      [sugar, coffee],
      [
        row({ branchId: 12, organizationInventoryId: 193 }),
        row({ branchId: 10, organizationInventoryId: 193, isVisible: false }),
        row({ branchId: 11, organizationInventoryId: 193, isVisible: false, isActive: false }),
        row({ branchId: 13, organizationInventoryId: 193, deleted: true }),
        row({ branchId: 10, organizationInventoryId: 268 }),
      ],
    )

    expect(plan.deactivations[0].branchRows).toEqual([
      { branchId: 10, isVisible: false, isActive: true },
      { branchId: 11, isVisible: false, isActive: false },
      { branchId: 12, isVisible: true, isActive: true },
    ])
  })

  it("never touches a listed product's branch rows", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar"),
      [sugarMapping],
      [sugar],
      [row({ branchId: 10, organizationInventoryId: 268, isVisible: false, isActive: false })],
    )

    expect(plan.deactivations).toEqual([])
    expect(catalogueRestrictionPlanLines(plan)).toEqual([])
  })

  it("activates a listed product whose organization entry is off, at the organization level only", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar"),
      [{ ...sugarMapping, organizationInventoryActive: false }],
      [{ ...sugar, isActive: false }],
      [row({ branchId: 10, organizationInventoryId: 268, isVisible: false, isActive: false })],
    )

    expect(plan.activations).toEqual([{ organizationInventoryId: 268, globalProductId: 7, productName: "Sugar" }])
    expect(plan.deactivations).toEqual([])
    expect(catalogueRestrictionPlanLines(plan)).toEqual(["ACTIVATE 268"])
  })

  it("refuses a list name it cannot resolve rather than guessing, and still restricts the rest", () => {
    const plan = planCatalogueRestriction(wanted("Sugar", "Unknown Thing"), [sugarMapping], [sugar, coffee], [])

    expect(plan.skipped).toEqual([expect.objectContaining({ reason: "PRODUCT_NOT_MAPPED", sourceNames: ["Unknown Thing"] })])
    expect(plan.deactivations.map((entry) => entry.organizationInventoryId)).toEqual([193])
  })

  it("treats two list names for one product as one kept product", () => {
    const variant = mapping({ ...sugarMapping, normalizedName: "sugar (01 kg)" })
    const plan = planCatalogueRestriction(wanted("Sugar", "Sugar (01 KG)"), [sugarMapping, variant], [sugar, coffee], [])

    expect(plan.kept).toHaveLength(1)
    expect(plan.deactivations.map((entry) => entry.organizationInventoryId)).toEqual([193])
  })

  it("digests every write in a stable order and nothing else", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar"),
      [{ ...sugarMapping, stockQuantity: 0 }],
      [sugar, coffee, tea],
      [row({ branchId: 12, organizationInventoryId: 193 }), row({ branchId: 10, organizationInventoryId: 193, isVisible: false, isActive: false })],
    )

    expect(catalogueRestrictionPlanLines(plan)).toEqual(["DEACTIVATE 193", "HIDE 10 193 --", "HIDE 12 193 va"])
    expect(plan.warnings).toHaveLength(1)
  })

  it("summarises the plan", () => {
    const plan = planCatalogueRestriction(
      wanted("Sugar", "Unknown"),
      [sugarMapping],
      [sugar, coffee, tea, test],
      [row({ branchId: 12, organizationInventoryId: 193 }), row({ branchId: 10, organizationInventoryId: 193, isVisible: false, isActive: false })],
    )

    expect(summarizeCatalogueRestriction(plan, 2)).toEqual({
      listLines: 2,
      kept: 1,
      activations: 0,
      deactivations: 2,
      branchRowsHidden: 1,
      branchRowsAlreadyHidden: 1,
      alreadyInactive: 1,
      skipped: 1,
      warnings: 0,
    })
  })
})

describe("planCatalogueRestrictionReversal", () => {
  const committed = {
    activations: [],
    deactivations: [{
      organizationInventoryId: 193,
      globalProductId: 183,
      productName: "Coffee Pods Eespresso (8 boxes)",
      branchRows: [
        { branchId: 10, isVisible: true, isActive: true },
        { branchId: 11, isVisible: false, isActive: false },
      ],
    }],
  }
  const hidden = [
    row({ branchId: 10, organizationInventoryId: 193, isVisible: false, isActive: false }),
    row({ branchId: 11, organizationInventoryId: 193, isVisible: false, isActive: false }),
  ]

  it("reactivates the entry and puts back only the rows the run hid", () => {
    const reversal = planCatalogueRestrictionReversal(committed, [{ ...coffee, isActive: false }], hidden)

    expect(reversal.reactivations).toEqual([{
      organizationInventoryId: 193,
      productName: "Coffee Pods Eespresso (8 boxes)",
      branchRows: [{ branchId: 10, isVisible: true, isActive: true }],
    }])
    expect(reversal.skipped).toEqual([])
    expect(catalogueRestrictionReversalLines(reversal)).toEqual(["REACTIVATE 193", "UNHIDE 10 193 -> va"])
  })

  it("reports an entry someone has already switched back on", () => {
    const reversal = planCatalogueRestrictionReversal(committed, [coffee], hidden)

    expect(reversal.reactivations).toEqual([])
    expect(reversal.skipped).toEqual([expect.objectContaining({ reason: "ALREADY_REVERSED", branchId: null })])
  })

  it("reports a branch row that moved since, and still reactivates the entry", () => {
    const reversal = planCatalogueRestrictionReversal(
      committed,
      [{ ...coffee, isActive: false }],
      [row({ branchId: 10, organizationInventoryId: 193, isVisible: true, isActive: false }), hidden[1]],
    )

    expect(reversal.reactivations).toEqual([expect.objectContaining({ organizationInventoryId: 193, branchRows: [] })])
    expect(reversal.skipped).toEqual([expect.objectContaining({ reason: "MOVED_SINCE", branchId: 10 })])
  })

  it("re-deactivates an entry the run activated, unless it has been turned off again", () => {
    const activated = { activations: [{ organizationInventoryId: 268, globalProductId: 7, productName: "Sugar" }], deactivations: [] }

    expect(planCatalogueRestrictionReversal(activated, [sugar], []).deactivations).toEqual(activated.activations)
    expect(planCatalogueRestrictionReversal(activated, [{ ...sugar, isActive: false }], []).skipped[0].reason).toBe("ALREADY_REVERSED")
  })
})
