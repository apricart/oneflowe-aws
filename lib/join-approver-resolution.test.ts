import { describe, expect, it } from "vitest"

import {
  type ApproverCandidate,
  planApproverResolution,
  sameResolution,
} from "./join-approver-resolution"

/**
 * What approving a department sign-up does with each named approver
 * (plans/OF-JOIN-department-signup-multi-user.md). The review previews with
 * this and the approval re-runs it, so these cases are both screens.
 */

const ORG = 7
const LEVELS_ON = {
  orderApprovalRequired: true,
  orderApprovalLevelsEnabled: true,
  orderApproverRole: "BRANCH_ADMIN",
  levelCount: 3,
}

function candidate(overrides: Partial<ApproverCandidate> = {}): ApproverCandidate {
  return {
    userId: "user-1",
    organizationId: ORG,
    role: "GROUP_USER",
    isActive: true,
    level: null,
    branchId: null,
    scopedBranchIds: [],
    ...overrides,
  }
}

function plan(overrides: Partial<Parameters<typeof planApproverResolution>[0]> = {}) {
  return planApproverResolution({
    level: 2,
    organizationId: ORG,
    organization: LEVELS_ON,
    candidates: [],
    initiatorBranchIds: [10, 11],
    newBranchCount: 0,
    deciderUserId: "decider",
    ...overrides,
  })
}

describe("planApproverResolution", () => {
  it("creates an account for an email nobody has", () => {
    expect(plan()).toEqual({ kind: "create" })
  })

  it("assigns the level to an eligible Group User, adding only the branches it lacks", () => {
    expect(plan({ candidates: [candidate({ scopedBranchIds: [10, 99] })] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [11] })
  })

  it("extends a holder of this level that lacks a branch, and leaves alone one that reaches all", () => {
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10] })] }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [11] })
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10, 11, 12] })] }))
      .toEqual({ kind: "covered", userId: "user-1" })
  })

  it("counts a CRC still to be created as a branch the holder lacks", () => {
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10, 11] })], newBranchCount: 1 }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [] })
  })

  describe("refuses", () => {
    it.each([
      ["several accounts at one email", { candidates: [candidate(), candidate({ userId: "user-2" })] }, /More than one account/],
      ["an account in another organization", { candidates: [candidate({ organizationId: 99 })] }, /outside your organization/],
      ["an account with no organization", { candidates: [candidate({ organizationId: null })] }, /outside your organization/],
      ["the deciding Head Office user", { candidates: [candidate({ userId: "decider" })] }, /cannot make yourself/],
      ["an inactive account", { candidates: [candidate({ isActive: false })] }, /inactive/],
      ["a role that cannot hold a level", { candidates: [candidate({ role: "ORDER_PORTAL" })] }, /cannot hold an approval level/],
      ["someone holding a different level", { candidates: [candidate({ level: 1 })] }, /already holds Level 1/],
    ])("%s", (_case, overrides, reason) => {
      const result = plan(overrides)
      expect(result.kind).toBe("blocked")
      expect(result.kind === "blocked" && result.reason).toMatch(reason)
    })
  })

  describe("a Branch Admin, where that is the approver role", () => {
    it("is assigned only when its one branch is the only branch", () => {
      expect(plan({ candidates: [candidate({ role: "BRANCH_ADMIN", branchId: 10 })], initiatorBranchIds: [10] }))
        .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [] })
      expect(plan({ candidates: [candidate({ role: "BRANCH_ADMIN", branchId: 10, level: 2 })], initiatorBranchIds: [10] }))
        .toEqual({ kind: "covered", userId: "user-1" })
    })

    it("is refused when the initiator orders at another branch too, or a new one", () => {
      expect(plan({ candidates: [candidate({ role: "BRANCH_ADMIN", branchId: 10 })] }).kind).toBe("blocked")
      expect(plan({ candidates: [candidate({ role: "BRANCH_ADMIN", branchId: 10 })], initiatorBranchIds: [10], newBranchCount: 1 }).kind)
        .toBe("blocked")
    })

    it("is refused where the approver role is Head Office", () => {
      expect(plan({
        organization: { ...LEVELS_ON, orderApproverRole: "HEAD_OFFICE" },
        candidates: [candidate({ role: "BRANCH_ADMIN", branchId: 10 })],
        initiatorBranchIds: [10],
      }).kind).toBe("blocked")
    })
  })

  it("never gives a Head Office user a level, which only Super Admin may do, but accepts one already holding it", () => {
    const headOffice = { ...LEVELS_ON, orderApproverRole: "HEAD_OFFICE" }
    expect(plan({ organization: headOffice, candidates: [candidate({ role: "HEAD_OFFICE" })] }).kind).toBe("blocked")
    expect(plan({ organization: headOffice, candidates: [candidate({ role: "HEAD_OFFICE", level: 2 })] }))
      .toEqual({ kind: "covered", userId: "user-1" })
  })

  it("applies no level once the organization's levels are off, or the level is gone (D7)", () => {
    expect(plan({ organization: { ...LEVELS_ON, orderApprovalLevelsEnabled: false } }).kind).toBe("not_applied")
    expect(plan({ organization: { ...LEVELS_ON, orderApprovalRequired: false } }).kind).toBe("not_applied")
    expect(plan({ organization: { ...LEVELS_ON, levelCount: 1 } }).kind).toBe("not_applied")
  })
})

describe("sameResolution — the drift check", () => {
  it("matches the same kind for the same account", () => {
    expect(sameResolution({ kind: "assign", userId: "a", addBranchIds: [1] }, { kind: "assign", userId: "a", addBranchIds: [1, 2] })).toBe(true)
    expect(sameResolution({ kind: "create" }, { kind: "create" })).toBe(true)
  })

  it("refuses another account or another kind", () => {
    expect(sameResolution({ kind: "assign", userId: "a", addBranchIds: [] }, { kind: "assign", userId: "b", addBranchIds: [] })).toBe(false)
    expect(sameResolution({ kind: "create" }, { kind: "assign", userId: "a", addBranchIds: [] })).toBe(false)
    expect(sameResolution({ kind: "covered", userId: "a" }, { kind: "extend", userId: "a", addBranchIds: [1] })).toBe(false)
  })
})
