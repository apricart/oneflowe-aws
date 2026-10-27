import { describe, expect, it } from "vitest"

import {
  describeDeskReach,
  filterReachOrganizations,
  reachDraftFor,
  setVisibleReach,
  toggleReachBranch,
  toggleReachOrganization,
} from "./order-desk-team-view"

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

  describe("the draft the Access dialog opens with", () => {
    it("keeps every grant the editor can show", () => {
      const draft = reachDraftFor({ organizationIds: [1], branchIds: [21] }, organizations)
      expect([...draft.organizationIds]).toEqual([1])
      expect([...draft.branchIds]).toEqual([21])
    })

    it("drops grants to an organization that is no longer managed, so saving cannot fail on them", () => {
      // Organization 9 and its branch 91 were granted while 9 was managed. It is
      // not on the screen any more, so there is nothing to untick them with, and
      // the server would refuse to store them again.
      const draft = reachDraftFor({ organizationIds: [1, 9], branchIds: [21, 91] }, organizations)
      expect([...draft.organizationIds]).toEqual([1])
      expect([...draft.branchIds]).toEqual([21])
    })

    it("drops a single branch already covered by its organization's whole grant", () => {
      const draft = reachDraftFor({ organizationIds: [1], branchIds: [11, 21] }, organizations)
      expect([...draft.branchIds]).toEqual([21])
    })

    it("is empty when nothing managed is granted, and when nothing is managed at all", () => {
      expect(reachDraftFor({ organizationIds: [9], branchIds: [91] }, organizations))
        .toEqual({ organizationIds: new Set(), branchIds: new Set() })
      expect(reachDraftFor({ organizationIds: [1], branchIds: [11] }, []))
        .toEqual({ organizationIds: new Set(), branchIds: new Set() })
    })
  })
})

describe("searching and bulk-ticking the reach editor", () => {
  const ids = (draft: { organizationIds: ReadonlySet<number>; branchIds: ReadonlySet<number> }) => ({
    organizationIds: [...draft.organizationIds].sort((a, b) => a - b),
    branchIds: [...draft.branchIds].sort((a, b) => a - b),
  })
  const empty = { organizationIds: new Set<number>(), branchIds: new Set<number>() }

  it("lists everything, whole, for an empty or blank search", () => {
    for (const query of ["", "   "]) {
      const visible = filterReachOrganizations(organizations, query)
      expect(visible.map((entry) => [entry.organization.id, entry.matchedWhole, entry.branches.length]))
        .toEqual([[1, true, 2], [2, true, 1]])
    }
  })

  it("lists a matching organization with every branch, ignoring case", () => {
    const visible = filterReachOrganizations(organizations, " meez ")
    expect(visible.map((entry) => [entry.organization.id, entry.matchedWhole, entry.branches.map((b) => b.id)]))
      .toEqual([[1, true, [11, 12]]])
  })

  it("lists an organization only for its matching branches, and drops one with none", () => {
    const visible = filterReachOrganizations(organizations, "SOUTH")
    expect(visible.map((entry) => [entry.organization.id, entry.matchedWhole, entry.branches.map((b) => b.id)]))
      .toEqual([[1, false, [12]]])
    expect(filterReachOrganizations(organizations, "nowhere")).toEqual([])
  })

  it("select all with no search grants every organization whole and drops redundant branches", () => {
    const next = setVisibleReach({ organizationIds: new Set(), branchIds: new Set([11]) }, filterReachOrganizations(organizations, ""), true)
    expect(ids(next)).toEqual({ organizationIds: [1, 2], branchIds: [] })
  })

  it("select all over a branch search grants only the listed branches, never the organization", () => {
    const next = setVisibleReach(empty, filterReachOrganizations(organizations, "south"), true)
    expect(ids(next)).toEqual({ organizationIds: [], branchIds: [12] })
  })

  it("select all over a branch search leaves a whole grant whole", () => {
    const next = setVisibleReach({ organizationIds: new Set([1]), branchIds: new Set() }, filterReachOrganizations(organizations, "south"), true)
    expect(ids(next)).toEqual({ organizationIds: [1], branchIds: [] })
  })

  it("unselect all withdraws only what is listed", () => {
    const draft = { organizationIds: new Set([2]), branchIds: new Set([11, 12]) }
    expect(ids(setVisibleReach(draft, filterReachOrganizations(organizations, "south"), false)))
      .toEqual({ organizationIds: [2], branchIds: [11] })
    expect(ids(setVisibleReach(draft, filterReachOrganizations(organizations, "meezan"), false)))
      .toEqual({ organizationIds: [2], branchIds: [] })
    expect(ids(setVisibleReach(draft, filterReachOrganizations(organizations, ""), false)))
      .toEqual({ organizationIds: [], branchIds: [] })
  })

  it("unselect all withdraws a whole grant listed for a branch match, since its tick is what shows", () => {
    const next = setVisibleReach({ organizationIds: new Set([1]), branchIds: new Set() }, filterReachOrganizations(organizations, "north"), false)
    expect(ids(next)).toEqual({ organizationIds: [], branchIds: [] })
  })
})
