import { describe, expect, it } from "vitest"

import {
  type ApproverCandidate,
  BRANCH_ADMIN_ORDERS_IN_FLIGHT_REFUSAL,
  NEW_BRANCH_ADMIN_APPROVER_REFUSAL,
  approverBranchCount,
  approverRoleAfterApproval,
  branchCountAfterReview,
  branchAdminBecomesGroupUser,
  newApproverRole,
  planApproverResolution,
  sameResolution,
} from "./join-approver-resolution"

/**
 * What approving a department sign-up does with each named approver
 * (plans/OF-JOIN-department-signup-multi-user.md). The review previews with
 * this and the approval re-runs it, so these cases are both screens.
 *
 * The role rule: Levels 1 and 2 are Group Users. At later levels, an approver
 * reaching one branch is a Branch Admin and one reaching more is a Group User
 * — for a new approver, and for an existing Branch Admin (converted). No other
 * existing account changes role.
 */

const ORG = 7
const LEVELS_ON = {
  orderApprovalRequired: true,
  orderApprovalLevelsEnabled: true,
  orderApproverRole: "BRANCH_ADMIN",
  levelCount: 3,
}
const HEAD_OFFICE_APPROVES = { ...LEVELS_ON, orderApproverRole: "HEAD_OFFICE" }

function candidate(overrides: Partial<ApproverCandidate> = {}): ApproverCandidate {
  return {
    userId: "user-1",
    organizationId: ORG,
    role: "GROUP_USER",
    isActive: true,
    level: null,
    branchId: null,
    scopedBranchIds: [],
    ordersInFlight: 0,
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

const branchAdmin = (overrides: Partial<ApproverCandidate> = {}) => candidate({ role: "BRANCH_ADMIN", branchId: 10, ...overrides })

describe("counting the initiator's branches", () => {
  it("counts each existing branch once, plus every CRC still to be created", () => {
    expect(approverBranchCount({ initiatorBranchIds: [10, 10, 11], newBranchCount: 0 })).toBe(2)
    expect(approverBranchCount({ initiatorBranchIds: [], newBranchCount: 1 })).toBe(1)
    expect(approverBranchCount({ initiatorBranchIds: [10], newBranchCount: 2 })).toBe(3)
  })

  it("always makes Level 1 and 2 approvers Group Users, regardless of branch count", () => {
    expect(newApproverRole(1, 1)).toBe("GROUP_USER")
    expect(newApproverRole(1, 10)).toBe("GROUP_USER")
    expect(newApproverRole(2, 1)).toBe("GROUP_USER")
    expect(newApproverRole(2, 10)).toBe("GROUP_USER")
  })

  it("uses branch count for approvers above Level 2", () => {
    expect(newApproverRole(3, 1)).toBe("BRANCH_ADMIN")
    expect(newApproverRole(3, 2)).toBe("GROUP_USER")
  })
})

describe("a new approver (nobody has the email)", () => {
  it.each([
    ["one existing branch at Level 1", { level: 1, initiatorBranchIds: [10] }, "GROUP_USER"],
    ["one existing branch", { initiatorBranchIds: [10] }, "GROUP_USER"],
    ["one CRC still to be created", { initiatorBranchIds: [], newBranchCount: 1 }, "GROUP_USER"],
    ["the same branch named twice", { initiatorBranchIds: [10, 10] }, "GROUP_USER"],
    ["two existing branches", { initiatorBranchIds: [10, 11] }, "GROUP_USER"],
    ["one branch and one new CRC", { initiatorBranchIds: [10], newBranchCount: 1 }, "GROUP_USER"],
    ["two new CRCs", { initiatorBranchIds: [], newBranchCount: 2 }, "GROUP_USER"],
  ])("with %s is created as a %s", (_case, overrides, role) => {
    expect(plan(overrides)).toEqual({ kind: "create", role })
  })

  it("is blocked at Level 3 for one branch where the approver role is Head Office, since a Branch Admin cannot hold a level there", () => {
    expect(plan({ level: 3, organization: HEAD_OFFICE_APPROVES, initiatorBranchIds: [10] }))
      .toEqual({ kind: "blocked", reason: NEW_BRANCH_ADMIN_APPROVER_REFUSAL })
  })

  it("is still a Group User for several branches where the approver role is Head Office", () => {
    expect(plan({ organization: HEAD_OFFICE_APPROVES })).toEqual({ kind: "create", role: "GROUP_USER" })
  })
})

describe("an existing Group User", () => {
  it("is given the level, and only the branches it lacks", () => {
    expect(plan({ candidates: [candidate({ scopedBranchIds: [10, 99] })] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [11], becomesGroupUser: false })
  })

  it("extends a holder of this level that lacks a branch, and leaves alone one that reaches all", () => {
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10] })] }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [11], becomesGroupUser: false })
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10, 11, 12] })] }))
      .toEqual({ kind: "covered", userId: "user-1" })
  })

  it("counts a CRC still to be created as a branch the holder lacks", () => {
    expect(plan({ candidates: [candidate({ level: 2, scopedBranchIds: [10, 11] })], newBranchCount: 1 }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [], becomesGroupUser: false })
  })

  it("stays a Group User for one branch — it is never turned into a Branch Admin", () => {
    expect(plan({ candidates: [candidate({ scopedBranchIds: [10] })], initiatorBranchIds: [10] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [], becomesGroupUser: false })
    expect(plan({ candidates: [candidate()], initiatorBranchIds: [], newBranchCount: 1 }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [], becomesGroupUser: false })
  })
})

describe("an existing Branch Admin", () => {
  it("becomes a Group User at Level 2 even when its own branch is the only branch", () => {
    expect(plan({ candidates: [branchAdmin()], initiatorBranchIds: [10] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [], becomesGroupUser: true })
    expect(plan({ candidates: [branchAdmin({ level: 2 })], initiatorBranchIds: [10] }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [], becomesGroupUser: true })
  })

  it("stays a Branch Admin at Level 3 when its own branch is the only branch", () => {
    expect(plan({ level: 3, candidates: [branchAdmin()], initiatorBranchIds: [10] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [], becomesGroupUser: false })
  })

  it("becomes a Group User when the initiator orders at another branch too, keeping its own", () => {
    expect(plan({ candidates: [branchAdmin()] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [11], becomesGroupUser: true })
    // Already holding the level: the level stays, the role and branches change.
    expect(plan({ candidates: [branchAdmin({ level: 2 })] }))
      .toEqual({ kind: "extend", userId: "user-1", addBranchIds: [11], becomesGroupUser: true })
  })

  it("becomes a Group User for one branch that is not its own", () => {
    expect(plan({ candidates: [branchAdmin()], initiatorBranchIds: [11] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [11], becomesGroupUser: true })
  })

  it("becomes a Group User when a new branch is to be created", () => {
    expect(plan({ candidates: [branchAdmin()], initiatorBranchIds: [10], newBranchCount: 1 }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [], becomesGroupUser: true })
  })

  it("is converted even where the approver role is Head Office, because the Group User it becomes may hold a level", () => {
    expect(plan({ organization: HEAD_OFFICE_APPROVES, candidates: [branchAdmin()] }))
      .toEqual({ kind: "assign", userId: "user-1", addBranchIds: [11], becomesGroupUser: true })
  })

  it("is blocked at Level 3 for its own single branch where the approver role is Head Office", () => {
    const result = plan({ level: 3, organization: HEAD_OFFICE_APPROVES, candidates: [branchAdmin()], initiatorBranchIds: [10] })
    expect(result.kind === "blocked" && result.reason).toMatch(/cannot hold an approval level/)
  })

  it("is blocked from becoming a Group User while orders it raised are pending or approved", () => {
    expect(plan({ candidates: [branchAdmin({ ordersInFlight: 2 })] }))
      .toEqual({ kind: "blocked", reason: BRANCH_ADMIN_ORDERS_IN_FLIGHT_REFUSAL })
  })

  it("is not held up by its orders when it stays a Branch Admin at Level 3", () => {
    expect(plan({ level: 3, candidates: [branchAdmin({ ordersInFlight: 2 })], initiatorBranchIds: [10] }).kind).toBe("assign")
  })

  it("is still refused for holding a different level, whatever the branches", () => {
    const result = plan({ candidates: [branchAdmin({ level: 1 })] })
    expect(result.kind === "blocked" && result.reason).toMatch(/already holds Level 1/)
  })
})

describe("branchAdminBecomesGroupUser", () => {
  it("is true for Levels 1 and 2, or for a later-level Branch Admin reaching past its own branch", () => {
    expect(branchAdminBecomesGroupUser({ role: "BRANCH_ADMIN", branchId: 10 }, { level: 1, initiatorBranchIds: [10], newBranchCount: 0 })).toBe(true)
    expect(branchAdminBecomesGroupUser({ role: "BRANCH_ADMIN", branchId: 10 }, { level: 2, initiatorBranchIds: [10], newBranchCount: 0 })).toBe(true)
    expect(branchAdminBecomesGroupUser({ role: "BRANCH_ADMIN", branchId: 10 }, { level: 3, initiatorBranchIds: [10], newBranchCount: 0 })).toBe(false)
    expect(branchAdminBecomesGroupUser({ role: "BRANCH_ADMIN", branchId: 10 }, { level: 3, initiatorBranchIds: [10, 11], newBranchCount: 0 })).toBe(true)
    expect(branchAdminBecomesGroupUser({ role: "BRANCH_ADMIN", branchId: 10 }, { level: 3, initiatorBranchIds: [10], newBranchCount: 1 })).toBe(true)
    expect(branchAdminBecomesGroupUser({ role: "GROUP_USER", branchId: null }, { level: 2, initiatorBranchIds: [10, 11], newBranchCount: 0 })).toBe(false)
    expect(branchAdminBecomesGroupUser({ role: "HEAD_OFFICE", branchId: null }, { level: 2, initiatorBranchIds: [10, 11], newBranchCount: 0 })).toBe(false)
  })
})

describe("other roles", () => {
  it.each([
    ["several accounts at one email", { candidates: [candidate(), candidate({ userId: "user-2" })] }, /More than one account/],
    ["an account in another organization", { candidates: [candidate({ organizationId: 99 })] }, /outside your organization/],
    ["an account with no organization", { candidates: [candidate({ organizationId: null })] }, /outside your organization/],
    ["the deciding Head Office user", { candidates: [candidate({ userId: "decider" })] }, /cannot make yourself/],
    ["an inactive account", { candidates: [candidate({ isActive: false })] }, /inactive/],
    ["an Order Portal user, which is never converted", { candidates: [candidate({ role: "ORDER_PORTAL", branchId: 10 })] }, /cannot hold an approval level/],
    ["a Group Order Portal user", { candidates: [candidate({ role: "GROUP_ORDER_PORTAL" })] }, /cannot hold an approval level/],
    ["someone holding a different level", { candidates: [candidate({ level: 1 })] }, /already holds Level 1/],
  ])("refuses %s", (_case, overrides, reason) => {
    const result = plan(overrides)
    expect(result.kind).toBe("blocked")
    expect(result.kind === "blocked" && result.reason).toMatch(reason)
  })

  it("never gives a Head Office user a level, which only Super Admin may do, but accepts one already holding it", () => {
    expect(plan({ organization: HEAD_OFFICE_APPROVES, candidates: [candidate({ role: "HEAD_OFFICE" })] }).kind).toBe("blocked")
    expect(plan({ organization: HEAD_OFFICE_APPROVES, candidates: [candidate({ role: "HEAD_OFFICE", level: 2 })] }))
      .toEqual({ kind: "covered", userId: "user-1" })
  })

  it("applies no level once the organization's levels are off, or the level is gone (D7)", () => {
    expect(plan({ organization: { ...LEVELS_ON, orderApprovalLevelsEnabled: false } }).kind).toBe("not_applied")
    expect(plan({ organization: { ...LEVELS_ON, orderApprovalRequired: false } }).kind).toBe("not_applied")
    expect(plan({ organization: { ...LEVELS_ON, levelCount: 1 } }).kind).toBe("not_applied")
    // Not applied wins over the role rule: nobody is created or converted.
    expect(plan({ organization: { ...HEAD_OFFICE_APPROVES, orderApprovalLevelsEnabled: false }, initiatorBranchIds: [10] }).kind)
      .toBe("not_applied")
  })
})

describe("approverRoleAfterApproval — the review's wording", () => {
  it("names the role each outcome leaves the approver with", () => {
    expect(approverRoleAfterApproval({ kind: "create", role: "BRANCH_ADMIN" }, null)).toBe("BRANCH_ADMIN")
    expect(approverRoleAfterApproval({ kind: "assign", userId: "a", addBranchIds: [], becomesGroupUser: true }, "BRANCH_ADMIN")).toBe("GROUP_USER")
    expect(approverRoleAfterApproval({ kind: "extend", userId: "a", addBranchIds: [1], becomesGroupUser: false }, "GROUP_USER")).toBe("GROUP_USER")
    expect(approverRoleAfterApproval({ kind: "covered", userId: "a" }, "HEAD_OFFICE")).toBe("HEAD_OFFICE")
    expect(approverRoleAfterApproval({ kind: "blocked", reason: "x" }, "ORDER_PORTAL")).toBeNull()
    expect(approverRoleAfterApproval({ kind: "not_applied", reason: "x" }, null)).toBeNull()
  })
})

describe("sameResolution — the drift check", () => {
  it("matches the same kind for the same account, whatever role it ends with", () => {
    expect(sameResolution(
      { kind: "assign", userId: "a", addBranchIds: [1], becomesGroupUser: false },
      { kind: "assign", userId: "a", addBranchIds: [1, 2], becomesGroupUser: true },
    )).toBe(true)
    expect(sameResolution({ kind: "create", role: "GROUP_USER" }, { kind: "create", role: "BRANCH_ADMIN" })).toBe(true)
  })

  it("refuses another account or another kind", () => {
    expect(sameResolution(
      { kind: "assign", userId: "a", addBranchIds: [], becomesGroupUser: false },
      { kind: "assign", userId: "b", addBranchIds: [], becomesGroupUser: false },
    )).toBe(false)
    expect(sameResolution({ kind: "create", role: "GROUP_USER" }, { kind: "assign", userId: "a", addBranchIds: [], becomesGroupUser: false })).toBe(false)
    expect(sameResolution({ kind: "covered", userId: "a" }, { kind: "assign", userId: "a", addBranchIds: [1], becomesGroupUser: false })).toBe(false)
    expect(sameResolution({ kind: "covered", userId: "a" }, { kind: "extend", userId: "b", addBranchIds: [1], becomesGroupUser: false })).toBe(false)
  })

  it("treats extended and covered as the same for the same holder: only the branches added differ", () => {
    // Mapping a CRC onto a branch already in the request leaves nothing to add.
    expect(sameResolution({ kind: "extend", userId: "a", addBranchIds: [], becomesGroupUser: false }, { kind: "covered", userId: "a" })).toBe(true)
    expect(sameResolution({ kind: "covered", userId: "a" }, { kind: "extend", userId: "a", addBranchIds: [1], becomesGroupUser: false })).toBe(true)
  })
})

describe("branchCountAfterReview — the count the approval decides roles on", () => {
  const rows = [
    { requestBranchId: 1, branchId: 10 },
    { requestBranchId: 2, branchId: null },
    { requestBranchId: 3, branchId: null },
  ]

  it("counts existing branches, CRCs to create, and CRCs mapped elsewhere once each", () => {
    expect(branchCountAfterReview(rows, {})).toBe(3)
    expect(branchCountAfterReview(rows, { 2: 20 })).toBe(3)
  })

  it("does not count a CRC mapped onto a branch already in the request, or two CRCs mapped onto one branch", () => {
    expect(branchCountAfterReview(rows, { 2: 10 })).toBe(2)
    expect(branchCountAfterReview(rows, { 2: 10, 3: 10 })).toBe(1)
    expect(branchCountAfterReview(rows, { 2: 20, 3: 20 })).toBe(2)
  })
})
