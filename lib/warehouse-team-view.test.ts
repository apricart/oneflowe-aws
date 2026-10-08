import { describe, expect, it } from "vitest"

import {
  branchesInOrganization,
  cityCoveringBranch,
  describeWarehouseBranches,
  describeWarehouseReach,
  effectiveWarehouseBranchIds,
  toggleAllBranches,
  toggleBranch,
} from "@/lib/warehouse-team-view"

const organizations = [
  { id: 1, name: "Meezan" },
  { id: 2, name: "UBL" },
  { id: 3, name: "KE" },
  { id: 4, name: "HBL" },
]
const branches = [
  { id: 11, organizationId: 1, name: "North" },
  { id: 12, organizationId: 1, name: "South" },
  { id: 21, organizationId: 2, name: "Clifton" },
  { id: 31, organizationId: 3, name: "KE House" },
  { id: 41, organizationId: 4, name: "Saddar" },
]

describe("describing a warehouse user's branches", () => {
  it("says none, or counts branches and names a few organizations", () => {
    expect(describeWarehouseBranches([], branches, organizations)).toBe("None")
    expect(describeWarehouseBranches([11], branches, organizations)).toBe("1 branch — Meezan")
    expect(describeWarehouseBranches([11, 12, 21], branches, organizations)).toBe("3 branches — Meezan, UBL")
    expect(describeWarehouseBranches([11, 21, 31, 41], branches, organizations)).toBe("4 branches in 4 organizations")
  })

  it("ignores ids that are not a known branch", () => {
    expect(describeWarehouseBranches([999], branches, organizations)).toBe("None")
  })
})

describe("selecting branches", () => {
  it("narrows to one organization", () => {
    expect(branchesInOrganization([21, 12, 11, 31], branches, 1)).toEqual([11, 12])
  })

  it("toggles one, and all or none of an organization", () => {
    expect(toggleBranch([11], 12)).toEqual([11, 12])
    expect(toggleBranch([11, 12], 11)).toEqual([12])
    expect(toggleAllBranches([11], [11, 12])).toEqual([11, 12])
    expect(toggleAllBranches([12, 11], [11, 12])).toEqual([])
    expect(toggleAllBranches([], [])).toEqual([])
  })
})

describe("whole cities", () => {
  const cityBranches = [
    { id: 11, organizationId: 1, name: "North", cityKey: "lahore" },
    { id: 12, organizationId: 1, name: "South", cityKey: "karachi" },
    { id: 21, organizationId: 2, name: "Clifton", cityKey: "karachi" },
    { id: 31, organizationId: 3, name: "KE House", cityKey: null },
    { id: 41, organizationId: 4, name: "Saddar", cityKey: "karachi" },
  ]
  const cities = [
    { key: "karachi", label: "Karachi" },
    { key: "lahore", label: "Lahore" },
  ]

  it("finds the assigned city covering a branch, by the server's key only", () => {
    expect(cityCoveringBranch({ cityKey: "karachi" }, ["karachi"])).toBe("karachi")
    expect(cityCoveringBranch({ cityKey: "karachi" }, ["lahore"])).toBeNull()
    expect(cityCoveringBranch({ cityKey: null }, ["karachi"])).toBeNull()
    // Never normalised in the browser: the key is already the SQL key.
    expect(cityCoveringBranch({ cityKey: "karachi" }, ["Karachi"])).toBeNull()
  })

  it("serves single branches and every branch of an assigned city, once each", () => {
    expect(effectiveWarehouseBranchIds({ branchIds: [31, 12], cityKeys: ["karachi"] }, cityBranches)).toEqual([12, 21, 31, 41])
    expect(effectiveWarehouseBranchIds({ branchIds: [], cityKeys: [] }, cityBranches)).toEqual([])
  })

  it("names a few cities, then counts what they and the single branches reach", () => {
    expect(describeWarehouseReach({ branchIds: [31], cityKeys: [] }, cityBranches, organizations, cities)).toBe("1 branch — KE")
    expect(describeWarehouseReach({ branchIds: [], cityKeys: ["lahore"] }, cityBranches, organizations, cities)).toBe("Lahore · 1 branch — Meezan")
    expect(describeWarehouseReach({ branchIds: [], cityKeys: ["karachi", "lahore"] }, cityBranches, organizations, cities))
      .toBe("Karachi, Lahore · 4 branches — Meezan, UBL, HBL")
    expect(describeWarehouseReach({ branchIds: [], cityKeys: ["quetta"] }, cityBranches, organizations, cities)).toBe("quetta · no branches yet")
    expect(describeWarehouseReach({ branchIds: [], cityKeys: ["a", "b", "c", "d"] }, cityBranches, organizations, cities)).toBe("4 cities · no branches yet")
  })
})
