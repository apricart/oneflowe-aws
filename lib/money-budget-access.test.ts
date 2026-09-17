import { describe, expect, it } from "vitest"

import {
  canAllocateToBranch,
  canManageMoneyBudgets,
  canManageMoneyBudgetsForAccount,
  managesAssignedBranchesOnly,
  resolveManagedBranchScope,
} from "./money-budget-access"

/**
 * The allocation rule, pinned closed: who may allocate at all, and — for the
 * approver — that a request can narrow its assigned branch set but never
 * widen it, and that an empty set is a refusal rather than a tenant-wide read.
 */
describe("who may allocate money budgets", () => {
  it("requires a Group User's explicit account grant", () => {
    for (const flag of [undefined, null, false, "true", 1]) {
      expect(canManageMoneyBudgetsForAccount("GROUP_USER", flag)).toBe(false)
    }
    expect(canManageMoneyBudgetsForAccount("GROUP_USER", true)).toBe(true)
    expect(canManageMoneyBudgetsForAccount("HEAD_OFFICE", false)).toBe(true)
    expect(canManageMoneyBudgetsForAccount("SUPER_ADMIN", false)).toBe(true)
    expect(canManageMoneyBudgetsForAccount("GROUP_ORDER_PORTAL", true)).toBe(false)
  })
  it("admits the two tenant-wide roles and the multi-branch approver", () => {
    expect(canManageMoneyBudgets("SUPER_ADMIN")).toBe(true)
    expect(canManageMoneyBudgets("HEAD_OFFICE")).toBe(true)
    expect(canManageMoneyBudgets("GROUP_USER")).toBe(true)
  })

  it("refuses the ordering roles, the single-branch admin and anything malformed", () => {
    for (const role of ["GROUP_ORDER_PORTAL", "ORDER_PORTAL", "BRANCH_ADMIN", "group_user", "", null, undefined, 3]) {
      expect(canManageMoneyBudgets(role)).toBe(false)
    }
  })

  it("treats only the approver as assignment-scoped", () => {
    expect(managesAssignedBranchesOnly("GROUP_USER")).toBe(true)
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_ORDER_PORTAL", undefined]) {
      expect(managesAssignedBranchesOnly(role)).toBe(false)
    }
  })
})

describe("the branches a listing may return", () => {
  it("passes a tenant-wide role's request through untouched, ignoring any assignments", () => {
    expect(resolveManagedBranchScope({ role: "HEAD_OFFICE", assignedBranchIds: [1], requestedBranchIds: [] }))
      .toEqual({ ok: true, branchIds: null })
    expect(resolveManagedBranchScope({ role: "SUPER_ADMIN", assignedBranchIds: null, requestedBranchIds: [4, 5] }))
      .toEqual({ ok: true, branchIds: [4, 5] })
  })

  it("confines the approver to its assignments when it asks for nothing in particular", () => {
    expect(resolveManagedBranchScope({ role: "GROUP_USER", assignedBranchIds: [10, 11] }))
      .toEqual({ ok: true, branchIds: [10, 11] })
  })

  it("lets a request narrow within the assignments and never beyond them", () => {
    expect(resolveManagedBranchScope({ role: "GROUP_USER", assignedBranchIds: [10, 11], requestedBranchIds: [11] }))
      .toEqual({ ok: true, branchIds: [11] })
    // 12 is in the tenant but not assigned: it drops out rather than joining.
    expect(resolveManagedBranchScope({ role: "GROUP_USER", assignedBranchIds: [10, 11], requestedBranchIds: [10, 12] }))
      .toEqual({ ok: true, branchIds: [10] })
  })

  it("refuses rather than widening when every requested branch is outside the assignments", () => {
    const scope = resolveManagedBranchScope({ role: "GROUP_USER", assignedBranchIds: [10, 11], requestedBranchIds: [12, 90] })
    expect(scope).toEqual({ ok: false, error: "Requested branches are outside your assigned scope", status: 403 })
  })

  it("refuses an approver with no assignments instead of listing the tenant", () => {
    for (const assigned of [[], null, undefined]) {
      const scope = resolveManagedBranchScope({ role: "GROUP_USER", assignedBranchIds: assigned })
      expect(scope).toEqual({ ok: false, error: "No branches are assigned to your account", status: 403 })
    }
  })

  it("normalises ids and drops anything that is not a positive integer", () => {
    expect(resolveManagedBranchScope({
      role: "GROUP_USER",
      assignedBranchIds: ["10", 11, 11, 0, -1, "x"],
      requestedBranchIds: ["11", "11", "abc"],
    })).toEqual({ ok: true, branchIds: [11] })
  })
})

describe("whether one allocation may be written to one branch", () => {
  it("lets a tenant-wide role through — the handler's tenant check is the fence there", () => {
    expect(canAllocateToBranch({ role: "HEAD_OFFICE", assignedBranchIds: null, branchId: 7 })).toBe(true)
    expect(canAllocateToBranch({ role: "SUPER_ADMIN", assignedBranchIds: [], branchId: 7 })).toBe(true)
  })

  it("lets the approver write only to an assigned branch", () => {
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: [10, 11], branchId: 11 })).toBe(true)
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: [10, 11], branchId: 12 })).toBe(false)
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: [], branchId: 10 })).toBe(false)
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: null, branchId: 10 })).toBe(false)
  })

  it("refuses a malformed target and a role that never allocates, whatever the assignments say", () => {
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: [10], branchId: "ten" })).toBe(false)
    expect(canAllocateToBranch({ role: "GROUP_USER", assignedBranchIds: [10], branchId: 0 })).toBe(false)
    expect(canAllocateToBranch({ role: "GROUP_ORDER_PORTAL", assignedBranchIds: [10], branchId: 10 })).toBe(false)
    expect(canAllocateToBranch({ role: "BRANCH_ADMIN", assignedBranchIds: [10], branchId: 10 })).toBe(false)
  })
})
