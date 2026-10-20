import { describe, expect, it } from "vitest"

import {
  branchesInOrganization,
  citiesForOrganizations,
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

  const everyOrganization = [1, 2, 3, 4]

  it("finds the assigned city covering a branch, by the server's key only, in a chosen organization only", () => {
    const branch = { organizationId: 1, cityKey: "karachi" }
    expect(cityCoveringBranch(branch, { cityKeys: ["karachi"], cityOrganizationIds: [1] })).toBe("karachi")
    expect(cityCoveringBranch(branch, { cityKeys: ["lahore"], cityOrganizationIds: [1] })).toBeNull()
    expect(cityCoveringBranch({ organizationId: 1, cityKey: null }, { cityKeys: ["karachi"], cityOrganizationIds: [1] })).toBeNull()
    // The city alone is not enough: the branch's organization must be chosen.
    expect(cityCoveringBranch(branch, { cityKeys: ["karachi"], cityOrganizationIds: [2] })).toBeNull()
    expect(cityCoveringBranch(branch, { cityKeys: ["karachi"], cityOrganizationIds: [] })).toBeNull()
    // Never normalised in the browser: the key is already the SQL key.
    expect(cityCoveringBranch(branch, { cityKeys: ["Karachi"], cityOrganizationIds: [1] })).toBeNull()
  })

  it("serves single branches and every branch of an assigned city in a chosen organization, once each", () => {
    expect(effectiveWarehouseBranchIds({ branchIds: [31, 12], cityKeys: ["karachi"], cityOrganizationIds: everyOrganization }, cityBranches))
      .toEqual([12, 21, 31, 41])
    expect(effectiveWarehouseBranchIds({ branchIds: [31], cityKeys: ["karachi"], cityOrganizationIds: [2] }, cityBranches)).toEqual([21, 31])
    expect(effectiveWarehouseBranchIds({ branchIds: [], cityKeys: ["karachi"], cityOrganizationIds: [] }, cityBranches)).toEqual([])
    expect(effectiveWarehouseBranchIds({ branchIds: [], cityKeys: [], cityOrganizationIds: everyOrganization }, cityBranches)).toEqual([])
  })

  it("names a few cities, then counts what they and the single branches reach", () => {
    const reach = (branchIds: number[], cityKeys: string[], cityOrganizationIds = everyOrganization) =>
      describeWarehouseReach({ branchIds, cityKeys, cityOrganizationIds }, cityBranches, organizations, cities)
    expect(reach([31], [])).toBe("1 branch — KE")
    expect(reach([], ["lahore"])).toBe("Lahore · 1 branch — Meezan")
    expect(reach([], ["karachi", "lahore"])).toBe("Karachi, Lahore · 4 branches — Meezan, UBL, HBL")
    expect(reach([], ["karachi"], [2, 4])).toBe("Karachi · 2 branches — UBL, HBL")
    expect(reach([], ["quetta"])).toBe("quetta · no branches yet")
    expect(reach([], ["karachi"], [])).toBe("Karachi · no organization chosen")
    expect(reach([], ["a", "b", "c", "d"])).toBe("4 cities · no branches yet")
  })

  describe("offering the cities of the chosen organizations", () => {
    const counted = [
      { key: "karachi", label: "Karachi", organizations: [{ organizationId: 1, branchCount: 2 }, { organizationId: 2, branchCount: 5 }] },
      { key: "lahore", label: "Lahore", organizations: [{ organizationId: 1, branchCount: 1 }] },
      { key: "quetta", label: "Quetta", organizations: [{ organizationId: 3, branchCount: 4 }] },
      { key: "gone", label: "gone", organizations: [] },
    ]

    it("offers nothing until an organization is chosen", () => {
      expect(citiesForOrganizations(counted, [], [])).toEqual([])
    })

    it("offers only the chosen organizations' cities, counted within them", () => {
      expect(citiesForOrganizations(counted, [2], [])).toEqual([
        { key: "karachi", label: "Karachi", branchCount: 5, organizationCount: 1, outside: false },
      ])
      expect(citiesForOrganizations(counted, [1, 2], [])).toEqual([
        { key: "karachi", label: "Karachi", branchCount: 7, organizationCount: 2, outside: false },
        { key: "lahore", label: "Lahore", branchCount: 1, organizationCount: 1, outside: false },
      ])
    })

    it("still lists an assigned city none of them has, after the others, so it can be withdrawn", () => {
      expect(citiesForOrganizations(counted, [2], ["quetta", "gone", "karachi"])).toEqual([
        { key: "karachi", label: "Karachi", branchCount: 5, organizationCount: 1, outside: false },
        { key: "quetta", label: "Quetta", branchCount: 0, organizationCount: 0, outside: true },
        { key: "gone", label: "gone", branchCount: 0, organizationCount: 0, outside: true },
      ])
    })
  })
})
