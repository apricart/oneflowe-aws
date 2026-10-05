import { describe, expect, it } from "vitest"

import { describeDeskReach, toggleReachBranch, toggleReachOrganization } from "./order-desk-team-view"

const organizations = [
  { id: 1, name: "Meezan", branches: [{ id: 11, name: "North" }, { id: 12, name: "South" }] },
  { id: 2, name: "UBL", branches: [{ id: 21, name: "Clifton" }] },
]

describe("the Order Desk Team reach editor", () => {
  it("drops single-branch ticks an organization-wide tick makes redundant", () => {
    const next = toggleReachOrganization({ organizationIds: new Set(), branchIds: new Set([11, 21]) }, 1, [11, 12])
    expect([...next.organizationIds]).toEqual([1])
    expect([...next.branchIds]).toEqual([21])
  })

  it("unticks an organization without inventing branches", () => {
    const next = toggleReachOrganization({ organizationIds: new Set([1]), branchIds: new Set() }, 1, [11, 12])
    expect([...next.organizationIds]).toEqual([])
    expect([...next.branchIds]).toEqual([])
  })

  it("toggles a single branch", () => {
    const on = toggleReachBranch({ organizationIds: new Set(), branchIds: new Set() }, 12)
    expect([...on.branchIds]).toEqual([12])
    expect([...toggleReachBranch(on, 12).branchIds]).toEqual([])
  })

  it("describes a member's reach in one line", () => {
    expect(describeDeskReach({ organizationIds: [1], branchIds: [21] }, organizations))
      .toBe("Meezan (all branches); UBL: Clifton")
    expect(describeDeskReach({ organizationIds: [], branchIds: [] }, organizations)).toBe("No access")
    // A grant to an organization no longer managed is not listed here.
    expect(describeDeskReach({ organizationIds: [9], branchIds: [] }, organizations)).toBe("No access")
  })
})
