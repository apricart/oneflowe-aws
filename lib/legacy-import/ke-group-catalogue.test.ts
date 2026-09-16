import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"

import type { CurrentBranchAssignment } from "./ke-branch-catalogue"
import {
  groupCataloguePlanLines,
  groupCatalogueReversalLines,
  parseGroupCatalogueCommitReport,
  planGroupCatalogue,
  planGroupCatalogueReversal,
  summarizeGroupCatalogue,
  type GroupAssignment,
  type GroupBranch,
  type MappedProduct,
  type WantedProduct,
} from "./ke-group-catalogue"

function wanted(...names: string[]): WantedProduct[] {
  return names.map((sourceName) => ({ sourceName }))
}

function mapping(overrides: Partial<MappedProduct> & { normalizedName: string }): MappedProduct {
  return {
    globalProductId: 100,
    productName: "Product",
    organizationInventoryId: 200,
    organizationInventoryActive: true,
    productActive: true,
    stockQuantity: 500,
    ...overrides,
  }
}

function branch(overrides: Partial<GroupBranch> & { branchId: number }): GroupBranch {
  return {
    groupId: 13,
    groupName: "Enabling Group",
    branchName: `Branch ${overrides.branchId}`,
    active: true,
    ...overrides,
  }
}

function row(overrides: Partial<CurrentBranchAssignment> & { branchId: number; organizationInventoryId: number }): CurrentBranchAssignment {
  return { isVisible: true, isActive: true, deleted: false, ...overrides }
}

const digest = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex")

const tea = mapping({ normalizedName: "tapal danedar (100 pcs)", globalProductId: 100, organizationInventoryId: 200, productName: "Tapal Danedar (100 PCS)" })
const sugar = mapping({ normalizedName: "sugar", globalProductId: 7, organizationInventoryId: 268, productName: "Sugar" })

describe("planGroupCatalogue", () => {
  it("creates a row for a listed product at a branch that has none", () => {
    const plan = planGroupCatalogue(wanted("Tapal Danedar (100 PCS)"), [tea], [branch({ branchId: 10 })], [])

    expect(plan.assignments).toEqual([{
      groupId: 13,
      groupName: "Enabling Group",
      branchId: 10,
      branchName: "Branch 10",
      organizationInventoryId: 200,
      globalProductId: 100,
      normalizedName: "tapal danedar (100 pcs)",
      action: "CREATE",
      before: null,
    }])
    expect(plan.unchanged).toBe(0)
    expect(plan.skipped).toEqual([])
  })

  it("leaves a visible, active row alone", () => {
    const plan = planGroupCatalogue(
      wanted("Tapal Danedar (100 PCS)"),
      [tea],
      [branch({ branchId: 10 })],
      [row({ branchId: 10, organizationInventoryId: 200 })],
    )

    expect(plan.assignments).toEqual([])
    expect(plan.unchanged).toBe(1)
  })

  it.each([
    ["hidden and inactive", { isVisible: false, isActive: false, deleted: false }],
    ["hidden only", { isVisible: false, isActive: true, deleted: false }],
    ["inactive only", { isVisible: true, isActive: false, deleted: false }],
    ["soft-deleted", { isVisible: true, isActive: true, deleted: true }],
  ])("restores a row that is %s, recording what it was", (_label, state) => {
    const plan = planGroupCatalogue(
      wanted("Tapal Danedar (100 PCS)"),
      [tea],
      [branch({ branchId: 10 })],
      [row({ branchId: 10, organizationInventoryId: 200, ...state })],
    )

    expect(plan.assignments).toHaveLength(1)
    expect(plan.assignments[0].action).toBe("RESTORE")
    expect(plan.assignments[0].before).toEqual(state)
  })

  it("plans every listed product at every active branch of every chosen group", () => {
    const plan = planGroupCatalogue(
      wanted("Tapal Danedar (100 PCS)", "Sugar"),
      [tea, sugar],
      [
        branch({ branchId: 10 }),
        branch({ branchId: 11 }),
        branch({ branchId: 20, groupId: 16, groupName: "Generation Group" }),
      ],
      [row({ branchId: 11, organizationInventoryId: 268 })],
    )

    expect(plan.assignments.map((entry) => `${entry.branchId}:${entry.organizationInventoryId}`).sort()).toEqual([
      "10:200", "10:268", "11:200", "20:200", "20:268",
    ])
    expect(plan.unchanged).toBe(1)
    expect(plan.groups).toEqual([
      { groupId: 13, groupName: "Enabling Group", activeBranches: 2 },
      { groupId: 16, groupName: "Generation Group", activeBranches: 1 },
    ])
  })

  it("never reaches a branch it was not given, whatever rows exist there", () => {
    const plan = planGroupCatalogue(
      wanted("Sugar"),
      [sugar],
      [branch({ branchId: 10 })],
      [row({ branchId: 99, organizationInventoryId: 268, isVisible: false, isActive: false })],
    )

    expect(plan.assignments.map((entry) => entry.branchId)).toEqual([10])
  })

  it("skips an inactive branch and reports it", () => {
    const plan = planGroupCatalogue(
      wanted("Sugar"),
      [sugar],
      [branch({ branchId: 10 }), branch({ branchId: 11, active: false, branchName: "Closed" })],
      [],
    )

    expect(plan.assignments.map((entry) => entry.branchId)).toEqual([10])
    expect(plan.inactiveBranches.map((entry) => entry.branchName)).toEqual(["Closed"])
    expect(plan.groups).toEqual([{ groupId: 13, groupName: "Enabling Group", activeBranches: 1 }])
  })

  describe("resolving the list", () => {
    it("joins on the normalised name, so spacing and case on the list do not matter", () => {
      const plan = planGroupCatalogue(wanted("TAPAL  DANEDAR ( 100 PCS )"), [tea], [branch({ branchId: 10 })], [])

      expect(plan.products.map((product) => product.globalProductId)).toEqual([100])
    })

    it("plans a product once when the list carries it twice", () => {
      const plan = planGroupCatalogue(wanted("Sugar", "Sugar", "sugar"), [sugar], [branch({ branchId: 10 })], [])

      expect(plan.products).toHaveLength(1)
      expect(plan.products[0].sourceNames).toEqual(["Sugar", "sugar"])
      expect(plan.assignments).toHaveLength(1)
    })

    it("plans a product once when two list names map to it", () => {
      const variant = mapping({ ...sugar, normalizedName: "sugar (01 kg)" })
      const plan = planGroupCatalogue(wanted("Sugar (01 KG)", "Sugar"), [sugar, variant], [branch({ branchId: 10 })], [])

      expect(plan.products).toHaveLength(1)
      expect(plan.products[0].sourceNames).toEqual(["Sugar (01 KG)", "Sugar"])
      expect(plan.assignments).toHaveLength(1)
    })

    it("refuses a name with no mapping rather than guessing", () => {
      const plan = planGroupCatalogue(wanted("Nestle Everyday (1 KG)"), [tea], [branch({ branchId: 10 })], [])

      expect(plan.assignments).toEqual([])
      expect(plan.skipped).toEqual([expect.objectContaining({
        sourceNames: ["Nestle Everyday (1 KG)"],
        normalizedName: "nestle everyday (1 kg)",
        reason: "PRODUCT_NOT_MAPPED",
      })])
    })

    it("refuses a name mapped to two different products", () => {
      const twin = mapping({ ...tea, globalProductId: 101, organizationInventoryId: 201 })
      const plan = planGroupCatalogue(wanted("Tapal Danedar (100 PCS)"), [tea, twin], [branch({ branchId: 10 })], [])

      expect(plan.assignments).toEqual([])
      expect(plan.skipped[0]).toEqual(expect.objectContaining({ reason: "PRODUCT_AMBIGUOUS", detail: "resolves to products 100, 101" }))
    })

    it("skips a retired product — it never wakes a global product", () => {
      const plan = planGroupCatalogue(wanted("Sugar"), [{ ...sugar, productActive: false }], [branch({ branchId: 10 })], [])

      expect(plan.assignments).toEqual([])
      expect(plan.skipped[0].reason).toBe("PRODUCT_RETIRED")
    })

    it("switches a listed product's organization entry back on, and still plans its branch rows", () => {
      const plan = planGroupCatalogue(wanted("Sugar"), [{ ...sugar, organizationInventoryActive: false }], [branch({ branchId: 10 })], [])

      expect(plan.activations).toEqual([{ organizationInventoryId: 268, globalProductId: 7, normalizedName: "sugar" }])
      expect(plan.assignments).toHaveLength(1)
      expect(plan.skipped).toEqual([])
      expect(groupCataloguePlanLines(plan)).toEqual(["ACTIVATE 268", "CREATE 10 268"])
    })

    it("still assigns a product with no stock, and warns that it is not yet orderable", () => {
      const plan = planGroupCatalogue(wanted("Sugar"), [{ ...sugar, stockQuantity: 0 }], [branch({ branchId: 10 })], [])

      expect(plan.assignments).toHaveLength(1)
      expect(plan.warnings).toEqual([expect.objectContaining({ globalProductId: 7, reason: "ZERO_STOCK" })])
    })

    it("ignores a blank list line", () => {
      const plan = planGroupCatalogue(wanted("", "   ", "Sugar"), [sugar], [branch({ branchId: 10 })], [])

      expect(plan.products).toHaveLength(1)
      expect(plan.skipped).toEqual([])
    })
  })

  describe("hiding what is not on the list", () => {
    const branches = [branch({ branchId: 10 }), branch({ branchId: 11 })]
    const coffee = mapping({ normalizedName: "coffee pods eespresso (8 boxes)", globalProductId: 183, organizationInventoryId: 193 })

    it("does nothing of the sort unless asked", () => {
      const plan = planGroupCatalogue(wanted("Sugar"), [sugar, coffee], branches, [row({ branchId: 10, organizationInventoryId: 193 })])

      expect(plan.hides).toEqual([])
    })

    it("hides every live row at the named branches whose product is not on the list", () => {
      const plan = planGroupCatalogue(
        wanted("Sugar"),
        [sugar, coffee],
        branches,
        [
          row({ branchId: 10, organizationInventoryId: 193 }),
          row({ branchId: 11, organizationInventoryId: 193 }),
          row({ branchId: 10, organizationInventoryId: 268 }),
        ],
        { hideOthers: true },
      )

      expect(plan.hides).toEqual([
        expect.objectContaining({ branchId: 10, organizationInventoryId: 193, normalizedName: "coffee pods eespresso (8 boxes)" }),
        expect.objectContaining({ branchId: 11, organizationInventoryId: 193 }),
      ])
      expect(groupCataloguePlanLines(plan)).toEqual(["CREATE 11 268", "HIDE 10 193", "HIDE 11 193"])
    })

    it("leaves a row that is already hidden, inactive or deleted as it is", () => {
      const plan = planGroupCatalogue(
        wanted("Sugar"),
        [sugar, coffee],
        branches,
        [
          row({ branchId: 10, organizationInventoryId: 193, isVisible: false }),
          row({ branchId: 11, organizationInventoryId: 193, isActive: false }),
          row({ branchId: 10, organizationInventoryId: 999, deleted: true }),
        ],
        { hideOthers: true },
      )

      expect(plan.hides).toEqual([])
    })

    it("never hides at a branch it was not given, nor at an inactive one", () => {
      const plan = planGroupCatalogue(
        wanted("Sugar"),
        [sugar, coffee],
        [branch({ branchId: 10 }), branch({ branchId: 12, active: false })],
        [row({ branchId: 99, organizationInventoryId: 193 }), row({ branchId: 12, organizationInventoryId: 193 })],
        { hideOthers: true },
      )

      expect(plan.hides).toEqual([])
    })

    it("names a row for a product legacy never mapped, with no name", () => {
      const plan = planGroupCatalogue(wanted("Sugar"), [sugar], branches, [row({ branchId: 10, organizationInventoryId: 555 })], { hideOthers: true })

      expect(plan.hides).toEqual([expect.objectContaining({ organizationInventoryId: 555, normalizedName: null })])
    })
  })

  describe("the digest", () => {
    const branches = [branch({ branchId: 10 }), branch({ branchId: 11 })]
    const rows = [row({ branchId: 11, organizationInventoryId: 200, isVisible: false, isActive: false })]

    it("is the same whatever order the inputs arrive in", () => {
      const forward = planGroupCatalogue(wanted("Sugar", "Tapal Danedar (100 PCS)"), [tea, sugar], branches, rows)
      const backward = planGroupCatalogue(wanted("Tapal Danedar (100 PCS)", "Sugar"), [sugar, tea], [...branches].reverse(), rows)

      expect(digest(groupCataloguePlanLines(forward))).toBe(digest(groupCataloguePlanLines(backward)))
    })

    it("changes when a row's before-state changes, so a restore never lands on a row that moved", () => {
      const hidden = planGroupCatalogue(wanted("Tapal Danedar (100 PCS)"), [tea], branches, rows)
      const deleted = planGroupCatalogue(wanted("Tapal Danedar (100 PCS)"), [tea], branches, [
        row({ branchId: 11, organizationInventoryId: 200, deleted: true }),
      ])

      expect(groupCataloguePlanLines(hidden)).toEqual(["CREATE 10 200", "RESTORE 11 200 ---"])
      expect(groupCataloguePlanLines(deleted)).toEqual(["CREATE 10 200", "RESTORE 11 200 vad"])
    })

    it("covers writes only — a skip or a warning does not move it", () => {
      const clean = planGroupCatalogue(wanted("Sugar"), [sugar], branches, [])
      const noisy = planGroupCatalogue(wanted("Sugar", "Unknown"), [{ ...sugar, stockQuantity: 0 }], branches, [])

      expect(groupCataloguePlanLines(noisy)).toEqual(groupCataloguePlanLines(clean))
    })
  })

  it("summarises the plan", () => {
    const plan = planGroupCatalogue(
      wanted("Sugar", "Tapal Danedar (100 PCS)", "Unknown"),
      [tea, { ...sugar, stockQuantity: 0 }],
      [branch({ branchId: 10 }), branch({ branchId: 11 }), branch({ branchId: 12, active: false })],
      [
        row({ branchId: 10, organizationInventoryId: 200 }),
        row({ branchId: 11, organizationInventoryId: 268, isVisible: false, isActive: false }),
      ],
    )

    expect(summarizeGroupCatalogue(plan, 3)).toEqual({
      listLines: 3,
      products: 2,
      groups: 1,
      activeBranches: 2,
      inactiveBranches: 1,
      activations: 0,
      toCreate: 2,
      toRestore: 1,
      toHide: 0,
      unchanged: 1,
      skipped: 1,
      warnings: 1,
      branchesTouched: 2,
    })
  })
})

describe("planGroupCatalogueReversal", () => {
  const committedOf = (assignments: GroupAssignment[]) => ({ activations: [], assignments, hides: [] })
  const created: GroupAssignment = {
    groupId: 13, groupName: "Enabling Group", branchId: 10, branchName: "Branch 10",
    organizationInventoryId: 200, globalProductId: 100, normalizedName: "tapal danedar (100 pcs)",
    action: "CREATE", before: null,
  }
  const restored: GroupAssignment = {
    ...created, branchId: 11, branchName: "Branch 11",
    action: "RESTORE", before: { isVisible: false, isActive: false, deleted: false },
  }

  it("deletes a created row that is still as the run left it", () => {
    const reversal = planGroupCatalogueReversal(committedOf([created]), [row({ branchId: 10, organizationInventoryId: 200 })])

    expect(reversal.deletes).toEqual([{ branchId: 10, branchName: "Branch 10", organizationInventoryId: 200, normalizedName: "tapal danedar (100 pcs)" }])
    expect(reversal.restores).toEqual([])
  })

  it("puts a restored row back to its recorded before-state", () => {
    const reversal = planGroupCatalogueReversal(committedOf([restored]), [row({ branchId: 11, organizationInventoryId: 200 })])

    expect(reversal.restores).toEqual([expect.objectContaining({ branchId: 11, to: { isVisible: false, isActive: false, deleted: false } })])
  })

  it("reports a created row that someone has since hidden, rather than deleting it", () => {
    const reversal = planGroupCatalogueReversal(committedOf([created]), [row({ branchId: 10, organizationInventoryId: 200, isVisible: false })])

    expect(reversal.deletes).toEqual([])
    expect(reversal.skipped[0]).toEqual(expect.objectContaining({ reason: "MOVED_SINCE" }))
  })

  it("reports a created row that is already gone", () => {
    const reversal = planGroupCatalogueReversal(committedOf([created]), [])

    expect(reversal.skipped[0]).toEqual(expect.objectContaining({ reason: "ALREADY_REVERSED" }))
  })

  it("reports a restored row that is already back where it was", () => {
    const reversal = planGroupCatalogueReversal(committedOf([restored]), [row({ branchId: 11, organizationInventoryId: 200, isVisible: false, isActive: false })])

    expect(reversal.restores).toEqual([])
    expect(reversal.skipped[0]).toEqual(expect.objectContaining({ reason: "ALREADY_REVERSED" }))
  })

  it("reports a restored row that has since moved somewhere else", () => {
    const reversal = planGroupCatalogueReversal(committedOf([restored]), [row({ branchId: 11, organizationInventoryId: 200, deleted: true })])

    expect(reversal.restores).toEqual([])
    expect(reversal.skipped[0]).toEqual(expect.objectContaining({ reason: "MOVED_SINCE" }))
  })

  it("plans each row once even if the report lists it twice", () => {
    const reversal = planGroupCatalogueReversal(committedOf([created, created]), [row({ branchId: 10, organizationInventoryId: 200 })])

    expect(reversal.deletes).toHaveLength(1)
  })

  it("digests the writes in a stable order", () => {
    const reversal = planGroupCatalogueReversal(
      committedOf([restored, created]),
      [row({ branchId: 10, organizationInventoryId: 200 }), row({ branchId: 11, organizationInventoryId: 200 })],
    )

    expect(groupCatalogueReversalLines(reversal)).toEqual(["DELETE 10 200", "RESTORE 11 200 -> ---"])
  })

  describe("what hideOthers and an activation did", () => {
    const hidden = { groupId: 13, groupName: "Enabling Group", branchId: 12, branchName: "Branch 12", organizationInventoryId: 193, normalizedName: "coffee pods eespresso (8 boxes)" }
    const activated = { organizationInventoryId: 193, globalProductId: 183, normalizedName: "coffee pods eespresso (8 boxes)" }

    it("shows a hidden row again while it is still as the run left it", () => {
      const reversal = planGroupCatalogueReversal(
        { activations: [], assignments: [], hides: [hidden] },
        [row({ branchId: 12, organizationInventoryId: 193, isVisible: false, isActive: false })],
      )

      expect(reversal.unhides).toEqual([expect.objectContaining({ branchId: 12, organizationInventoryId: 193 })])
      expect(groupCatalogueReversalLines(reversal)).toEqual(["UNHIDE 12 193"])
    })

    it("reports a hidden row that someone has since shown, or changed some other way", () => {
      const shown = planGroupCatalogueReversal({ activations: [], assignments: [], hides: [hidden] }, [row({ branchId: 12, organizationInventoryId: 193 })])
      const moved = planGroupCatalogueReversal({ activations: [], assignments: [], hides: [hidden] }, [row({ branchId: 12, organizationInventoryId: 193, isVisible: false })])

      expect(shown.unhides).toEqual([])
      expect(shown.skipped[0]).toEqual(expect.objectContaining({ reason: "ALREADY_REVERSED" }))
      expect(moved.skipped[0]).toEqual(expect.objectContaining({ reason: "MOVED_SINCE" }))
    })

    it("switches an activated entry off again, unless it is already off", () => {
      const on = planGroupCatalogueReversal({ activations: [activated], assignments: [], hides: [] }, [], [{ organizationInventoryId: 193, isActive: true }])
      const off = planGroupCatalogueReversal({ activations: [activated], assignments: [], hides: [] }, [], [{ organizationInventoryId: 193, isActive: false }])

      expect(on.deactivations).toEqual([activated])
      expect(groupCatalogueReversalLines(on)).toEqual(["DEACTIVATE 193"])
      expect(off.deactivations).toEqual([])
      expect(off.skipped[0]).toEqual(expect.objectContaining({ reason: "ALREADY_REVERSED", branchId: null }))
    })
  })
})

describe("parseGroupCatalogueCommitReport", () => {
  const created = {
    groupId: 13, groupName: "Enabling Group", branchId: 10, branchName: "Branch 10",
    organizationInventoryId: 200, globalProductId: 100, normalizedName: "tapal danedar (100 pcs)",
    action: "CREATE", before: null,
  }
  const report = {
    importer: "assign-ke-group-catalogue",
    mode: "COMMIT",
    generatedAt: "2026-09-15T10:00:00.000Z",
    planDigest: "abc",
    organization: { id: 10, code: "0001", name: "K-Electric" },
    plan: { assignments: [created] },
  }

  it("accepts a committed run's report", () => {
    expect(parseGroupCatalogueCommitReport(report).plan.assignments).toHaveLength(1)
  })

  it("reads a report written before activations and hides existed as having none", () => {
    const parsed = parseGroupCatalogueCommitReport(report)
    expect(parsed.plan.activations).toEqual([])
    expect(parsed.plan.hides).toEqual([])
  })

  it("refuses a dry-run report", () => {
    expect(() => parseGroupCatalogueCommitReport({ ...report, mode: "DRY_RUN" })).toThrow(/committed run, not a dry run/)
  })

  it("refuses another script's report", () => {
    expect(() => parseGroupCatalogueCommitReport({ ...report, importer: "sync-ke" })).toThrow(/assign-ke-group-catalogue/)
  })

  it("refuses a RESTORE with no before-state, which could not be reversed", () => {
    const broken = { ...report, plan: { assignments: [{ ...created, action: "RESTORE" }] } }
    expect(() => parseGroupCatalogueCommitReport(broken)).toThrow(/before-state/)
  })

  it("refuses a CREATE that claims a before-state", () => {
    const broken = { ...report, plan: { assignments: [{ ...created, before: { isVisible: false, isActive: false, deleted: false } }] } }
    expect(() => parseGroupCatalogueCommitReport(broken)).toThrow(/before-state/)
  })
})
