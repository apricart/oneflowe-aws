import { describe, expect, it } from "vitest"

import {
  CHILD_NEEDS_PARENT_MESSAGE,
  MAX_PARENT_BRANCH_FILTER_IDS,
  ONLY_CHILD_HAS_PARENT_MESSAGE,
  OWN_PARENT_MESSAGE,
  branchHierarchyInputError,
  describeBranchHierarchy,
  hierarchyForNewBranch,
  matchesBranchHierarchyFilter,
  normalizeBranchHierarchyRole,
  parentBranchOptions,
  parseHierarchyRolesParam,
  parseParentBranchIdsParam,
  planBranchHierarchyChange,
  rollUpBranchRowsByParent,
  type BranchReportRow,
} from "@/lib/branch-hierarchy"

describe("branch hierarchy — creating", () => {
  it("defaults to standalone with no parent", () => {
    expect(branchHierarchyInputError({})).toBeNull()
    expect(hierarchyForNewBranch({})).toEqual({ hierarchyRole: "STANDALONE", parentBranchId: null })
  })

  it("requires a parent for a child and refuses one for anything else", () => {
    expect(branchHierarchyInputError({ hierarchyRole: "CHILD" })).toBe(CHILD_NEEDS_PARENT_MESSAGE)
    expect(branchHierarchyInputError({ hierarchyRole: "CHILD", parentBranchId: null })).toBe(CHILD_NEEDS_PARENT_MESSAGE)
    expect(branchHierarchyInputError({ hierarchyRole: "PARENT", parentBranchId: 4 })).toBe(ONLY_CHILD_HAS_PARENT_MESSAGE)
    expect(branchHierarchyInputError({ parentBranchId: 4 })).toBe(ONLY_CHILD_HAS_PARENT_MESSAGE)
    expect(branchHierarchyInputError({ hierarchyRole: "CHILD", parentBranchId: 4 })).toBeNull()
    expect(branchHierarchyInputError({ hierarchyRole: "PARENT", parentBranchId: null })).toBeNull()
  })

  it("stores the parent only for a child", () => {
    expect(hierarchyForNewBranch({ hierarchyRole: "CHILD", parentBranchId: 4 })).toEqual({ hierarchyRole: "CHILD", parentBranchId: 4 })
    expect(hierarchyForNewBranch({ hierarchyRole: "PARENT", parentBranchId: null })).toEqual({ hierarchyRole: "PARENT", parentBranchId: null })
  })
})

describe("branch hierarchy — editing", () => {
  const standalone = { hierarchyRole: "STANDALONE", parentBranchId: null } as const
  const parent = { hierarchyRole: "PARENT", parentBranchId: null } as const
  const childOf4 = { hierarchyRole: "CHILD", parentBranchId: 4 } as const

  it("leaves the hierarchy alone when neither field is sent, or both restate it", () => {
    expect(planBranchHierarchyChange(9, standalone, {})).toEqual({ kind: "unchanged" })
    expect(planBranchHierarchyChange(9, childOf4, { hierarchyRole: "CHILD", parentBranchId: 4 })).toEqual({ kind: "unchanged" })
    expect(planBranchHierarchyChange(9, childOf4, { hierarchyRole: "CHILD" })).toEqual({ kind: "unchanged" })
    expect(planBranchHierarchyChange(9, parent, { hierarchyRole: "PARENT", parentBranchId: null })).toEqual({ kind: "unchanged" })
  })

  it("makes a standalone branch a parent or a child", () => {
    expect(planBranchHierarchyChange(9, standalone, { hierarchyRole: "PARENT" })).toEqual({
      kind: "change", next: parent, demotesParent: false, checksParent: false,
    })
    expect(planBranchHierarchyChange(9, standalone, { hierarchyRole: "CHILD", parentBranchId: 4 })).toEqual({
      kind: "change", next: childOf4, demotesParent: false, checksParent: true,
    })
  })

  it("re-parents a child when only the parent is sent", () => {
    expect(planBranchHierarchyChange(9, childOf4, { parentBranchId: 5 })).toEqual({
      kind: "change", next: { hierarchyRole: "CHILD", parentBranchId: 5 }, demotesParent: false, checksParent: true,
    })
  })

  it("clears the parent when a child becomes standalone or a parent", () => {
    expect(planBranchHierarchyChange(9, childOf4, { hierarchyRole: "STANDALONE" })).toEqual({
      kind: "change", next: standalone, demotesParent: false, checksParent: false,
    })
    expect(planBranchHierarchyChange(9, childOf4, { hierarchyRole: "PARENT", parentBranchId: null })).toEqual({
      kind: "change", next: parent, demotesParent: false, checksParent: false,
    })
  })

  it("flags a parent that stops being one, so its children can be counted", () => {
    expect(planBranchHierarchyChange(9, parent, { hierarchyRole: "STANDALONE" })).toMatchObject({ kind: "change", demotesParent: true })
    expect(planBranchHierarchyChange(9, parent, { hierarchyRole: "CHILD", parentBranchId: 4 })).toMatchObject({
      kind: "change", demotesParent: true, checksParent: true,
    })
  })

  it("refuses a child with no parent, a parent on a non-child, and a branch as its own parent", () => {
    expect(planBranchHierarchyChange(9, standalone, { hierarchyRole: "CHILD" })).toEqual({ kind: "refused", message: CHILD_NEEDS_PARENT_MESSAGE })
    expect(planBranchHierarchyChange(9, childOf4, { parentBranchId: null })).toEqual({ kind: "refused", message: CHILD_NEEDS_PARENT_MESSAGE })
    expect(planBranchHierarchyChange(9, standalone, { parentBranchId: 4 })).toEqual({ kind: "refused", message: ONLY_CHILD_HAS_PARENT_MESSAGE })
    expect(planBranchHierarchyChange(9, childOf4, { hierarchyRole: "PARENT", parentBranchId: 4 })).toEqual({ kind: "refused", message: ONLY_CHILD_HAS_PARENT_MESSAGE })
    expect(planBranchHierarchyChange(9, standalone, { hierarchyRole: "CHILD", parentBranchId: 9 })).toEqual({ kind: "refused", message: OWN_PARENT_MESSAGE })
    expect(planBranchHierarchyChange(9, childOf4, { parentBranchId: 9 })).toEqual({ kind: "refused", message: OWN_PARENT_MESSAGE })
  })
})

describe("branch hierarchy — display and list filter", () => {
  it("describes each type, and reads anything unknown as standalone", () => {
    expect(describeBranchHierarchy({ hierarchyRole: "PARENT" })).toBe("Parent branch")
    expect(describeBranchHierarchy({ hierarchyRole: "CHILD", parentBranchName: "Head Branch" })).toBe("Child of Head Branch")
    expect(describeBranchHierarchy({ hierarchyRole: "CHILD" })).toBe("Child branch")
    expect(describeBranchHierarchy({ hierarchyRole: "STANDALONE" })).toBe("Standalone")
    expect(describeBranchHierarchy({})).toBe("Standalone")
    expect(normalizeBranchHierarchyRole("parent")).toBe("STANDALONE")
    expect(normalizeBranchHierarchyRole(null)).toBe("STANDALONE")
  })

  it("filters a branch list by type", () => {
    expect(matchesBranchHierarchyFilter({ hierarchyRole: "CHILD" }, "all")).toBe(true)
    expect(matchesBranchHierarchyFilter({ hierarchyRole: "CHILD" }, "CHILD")).toBe(true)
    expect(matchesBranchHierarchyFilter({ hierarchyRole: "CHILD" }, "PARENT")).toBe(false)
    expect(matchesBranchHierarchyFilter({}, "STANDALONE")).toBe(true)
  })

  it("offers only the organization's parents, never the branch itself, by name", () => {
    const branches = [
      { id: 1, name: "Zeta", organizationId: 10, hierarchyRole: "PARENT", status: "active" },
      { id: 2, name: "Alpha", organizationId: 10, hierarchyRole: "PARENT", status: "inactive" },
      { id: 3, name: "Child", organizationId: 10, hierarchyRole: "CHILD" },
      { id: 4, name: "Lone", organizationId: 10, hierarchyRole: "STANDALONE" },
      { id: 5, name: "Foreign", organizationId: 11, hierarchyRole: "PARENT" },
    ]
    expect(parentBranchOptions(branches, 10)).toEqual([
      { id: 2, name: "Alpha", status: "inactive" },
      { id: 1, name: "Zeta", status: "active" },
    ])
    expect(parentBranchOptions(branches, 10, 1).map((option) => option.id)).toEqual([2])
    expect(parentBranchOptions(branches, null)).toEqual([])
  })
})

describe("branch hierarchy — report query parameters", () => {
  it("parses roles, case-insensitively and without duplicates", () => {
    expect(parseHierarchyRolesParam(null)).toEqual([])
    expect(parseHierarchyRolesParam("")).toEqual([])
    expect(parseHierarchyRolesParam("parent, CHILD,parent")).toEqual(["PARENT", "CHILD"])
    expect(parseHierarchyRolesParam("PARENT,GRANDPARENT")).toBeNull()
    expect(parseHierarchyRolesParam("PARENT,")).toBeNull()
  })

  it("parses parent ids, refusing anything malformed or too many", () => {
    expect(parseParentBranchIdsParam(undefined)).toEqual([])
    expect(parseParentBranchIdsParam("3, 4,3")).toEqual([3, 4])
    expect(parseParentBranchIdsParam("0")).toBeNull()
    expect(parseParentBranchIdsParam("-1")).toBeNull()
    expect(parseParentBranchIdsParam("1.5")).toBeNull()
    expect(parseParentBranchIdsParam("abc")).toBeNull()
    expect(parseParentBranchIdsParam("2147483648")).toBeNull()
    const atLimit = Array.from({ length: MAX_PARENT_BRANCH_FILTER_IDS }, (_, index) => index + 1).join(",")
    expect(parseParentBranchIdsParam(atLimit)).toHaveLength(MAX_PARENT_BRANCH_FILTER_IDS)
    expect(parseParentBranchIdsParam(`${atLimit},${MAX_PARENT_BRANCH_FILTER_IDS + 1}`)).toBeNull()
  })
})

describe("branch hierarchy — report roll-up", () => {
  const row = (overrides: Partial<BranchReportRow> & { id: number; name: string }): BranchReportRow => ({
    status: "active",
    hierarchyRole: "STANDALONE",
    parentBranchId: null,
    parentBranchName: null,
    totalOrders: 0,
    fulfilledOrders: 0,
    revenue: 0,
    refunds: 0,
    ...overrides,
  })

  it("folds each parent's children into one row and leaves standalone branches alone", () => {
    const rolled = rollUpBranchRowsByParent([
      row({ id: 1, name: "Head", hierarchyRole: "PARENT", revenue: 10_000, refunds: 100, totalOrders: 2, fulfilledOrders: 1 }),
      row({ id: 2, name: "Kid A", hierarchyRole: "CHILD", parentBranchId: 1, parentBranchName: "Head", revenue: 5_001, refunds: 0, totalOrders: 3, fulfilledOrders: 3 }),
      row({ id: 3, name: "Kid B", hierarchyRole: "CHILD", parentBranchId: 1, parentBranchName: "Head", revenue: 1, refunds: 50, totalOrders: 1, fulfilledOrders: 0 }),
      row({ id: 4, name: "Lone", revenue: 20_000, totalOrders: 1, fulfilledOrders: 1 }),
    ])

    expect(rolled).toEqual([
      expect.objectContaining({ id: 4, name: "Lone", memberCount: 1, childCount: 0, revenue: 20_000 }),
      expect.objectContaining({
        id: "parent-1",
        name: "Head",
        status: "active",
        hierarchyRole: "PARENT",
        memberCount: 3,
        childCount: 2,
        revenue: 15_002,
        refunds: 150,
        totalOrders: 6,
        fulfilledOrders: 4,
      }),
    ])
  })

  it("rolls children up under their parent's name and status when the parent is not in the report", () => {
    const [family] = rollUpBranchRowsByParent([
      row({ id: 2, name: "Kid A", hierarchyRole: "CHILD", parentBranchId: 1, parentBranchName: "Head", parentBranchStatus: "inactive", revenue: 7 }),
    ])
    expect(family).toMatchObject({ id: "parent-1", name: "Head", status: "inactive", memberCount: 1, childCount: 1, revenue: 7 })
  })

  it("keeps a parent with no children as a family of one", () => {
    expect(rollUpBranchRowsByParent([row({ id: 1, name: "Head", hierarchyRole: "PARENT", revenue: 9 })])).toEqual([
      expect.objectContaining({ id: "parent-1", memberCount: 1, childCount: 0, revenue: 9 }),
    ])
  })

  it("keeps hidden money hidden and still orders by orders", () => {
    const rolled = rollUpBranchRowsByParent([
      row({ id: 1, name: "Head", hierarchyRole: "PARENT", revenue: null, refunds: null, totalOrders: 1 }),
      row({ id: 2, name: "Kid", hierarchyRole: "CHILD", parentBranchId: 1, revenue: null, refunds: null, totalOrders: 4 }),
      row({ id: 3, name: "Lone", revenue: null, refunds: null, totalOrders: 2 }),
    ])
    expect(rolled.map((entry) => [entry.id, entry.revenue, entry.totalOrders])).toEqual([
      ["parent-1", null, 5],
      [3, null, 2],
    ])
  })

  it("returns nothing for nothing", () => {
    expect(rollUpBranchRowsByParent([])).toEqual([])
  })
})
