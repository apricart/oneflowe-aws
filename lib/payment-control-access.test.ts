import { describe, expect, it } from "vitest"

import {
  PAYMENT_CONTROL_EXCEPTION_MANAGER_ROLES,
  canManageExceptionForBranch,
  canManagePaymentControlExceptions,
  resolveViewableBranch,
} from "./payment-control-access"

describe("who may grant or revoke an exception", () => {
  it("is Super Admin and Head Office, spelled out — no hierarchy", () => {
    expect([...PAYMENT_CONTROL_EXCEPTION_MANAGER_ROLES]).toEqual(["SUPER_ADMIN", "HEAD_OFFICE"])
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE"])("%s may", (role) => {
    expect(canManagePaymentControlExceptions(role)).toBe(true)
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL", "", undefined, null, 1])(
    "%s may not — a branch never lifts its own block",
    (role) => {
      expect(canManagePaymentControlExceptions(role)).toBe(false)
    },
  )

  it("Head Office is fenced to its own tenant", () => {
    expect(canManageExceptionForBranch({ role: "HEAD_OFFICE", sessionOrganizationId: 10, branchOrganizationId: 10 })).toBe(true)
    expect(canManageExceptionForBranch({ role: "HEAD_OFFICE", sessionOrganizationId: 10, branchOrganizationId: 2 })).toBe(false)
    expect(canManageExceptionForBranch({ role: "HEAD_OFFICE", sessionOrganizationId: null, branchOrganizationId: 10 })).toBe(false)
    expect(canManageExceptionForBranch({ role: "HEAD_OFFICE", sessionOrganizationId: "10", branchOrganizationId: 10 })).toBe(true)
  })

  it("Super Admin is not fenced", () => {
    expect(canManageExceptionForBranch({ role: "SUPER_ADMIN", sessionOrganizationId: null, branchOrganizationId: 2 })).toBe(true)
  })

  it("a non-manager is refused even inside its own tenant", () => {
    expect(canManageExceptionForBranch({ role: "BRANCH_ADMIN", sessionOrganizationId: 10, branchOrganizationId: 10 })).toBe(false)
    expect(canManageExceptionForBranch({ role: "GROUP_USER", sessionOrganizationId: 10, branchOrganizationId: 10 })).toBe(false)
  })
})

describe("which branch a status read is for", () => {
  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("%s reads its own branch, with or without naming it", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 5, assignedBranchIds: null, requestedBranchId: undefined }))
      .toEqual({ ok: true, branchId: 5 })
    expect(resolveViewableBranch({ role, sessionBranchId: "5", assignedBranchIds: null, requestedBranchId: "5" }))
      .toEqual({ ok: true, branchId: 5 })
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("%s naming another branch is refused, not widened", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 5, assignedBranchIds: [5, 6], requestedBranchId: 6 }))
      .toMatchObject({ ok: false, status: 403 })
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("%s with no branch on the session is a 400", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: null, assignedBranchIds: null, requestedBranchId: 5 }))
      .toMatchObject({ ok: false, status: 400 })
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("%s reads a branch in its resolved assignment set", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 99, assignedBranchIds: [3, 4], requestedBranchId: 4 }))
      .toEqual({ ok: true, branchId: 4 })
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("%s asking for an unassigned branch is refused", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 99, assignedBranchIds: [3, 4], requestedBranchId: 99 }))
      .toMatchObject({ ok: false, status: 403 })
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("%s with an empty assignment set is refused, never the tenant", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 99, assignedBranchIds: [], requestedBranchId: 4 }))
      .toMatchObject({ ok: false, status: 403 })
    expect(resolveViewableBranch({ role, sessionBranchId: 99, assignedBranchIds: null, requestedBranchId: 4 }))
      .toMatchObject({ ok: false, status: 403 })
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("%s must name the branch", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: 99, assignedBranchIds: [3], requestedBranchId: undefined }))
      .toMatchObject({ ok: false, status: 400 })
  })

  it.each(["HEAD_OFFICE", "SUPER_ADMIN"])("%s must name the branch; the tenant check is the handler's", (role) => {
    expect(resolveViewableBranch({ role, sessionBranchId: null, assignedBranchIds: null, requestedBranchId: 12 }))
      .toEqual({ ok: true, branchId: 12 })
    expect(resolveViewableBranch({ role, sessionBranchId: null, assignedBranchIds: null, requestedBranchId: "abc" }))
      .toMatchObject({ ok: false, status: 400 })
  })

  it("an unknown role is refused", () => {
    expect(resolveViewableBranch({ role: "SOMETHING_ELSE", sessionBranchId: 5, assignedBranchIds: [5], requestedBranchId: 5 }))
      .toMatchObject({ ok: false, status: 403 })
  })
})
