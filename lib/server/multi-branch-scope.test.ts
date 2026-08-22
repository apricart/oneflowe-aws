import { describe, expect, it, vi } from "vitest"

// The module under test reaches for the database only in its query helpers.
// These stubs keep the pure policy functions unit-testable without a database.
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ db: {} }))

import {
  GROUP_ORDER_PORTAL_ROLE,
  GROUP_USER_ROLE,
  isGroupApproverRole,
  rejectScopeForSingleBranchRole,
  usesMultiBranchScope,
} from "./multi-branch-scope"
import { canAssignRole, canManageUser } from "./user-access-policy"
import { systemRoleSchema, userCreateSchema } from "./mutation-validation"

const SINGLE_BRANCH_ROLES = ["ORDER_PORTAL", "BRANCH_ADMIN", "HEAD_OFFICE", "SUPER_ADMIN"] as const

describe("multi-branch role identity", () => {
  it("recognises exactly the two group-based roles", () => {
    expect(usesMultiBranchScope(GROUP_ORDER_PORTAL_ROLE)).toBe(true)
    expect(usesMultiBranchScope(GROUP_USER_ROLE)).toBe(true)
    for (const role of [...SINGLE_BRANCH_ROLES, null, undefined, ""]) {
      expect(usesMultiBranchScope(role)).toBe(false)
    }
  })

  it("grants order decisions to Group User only", () => {
    expect(isGroupApproverRole(GROUP_USER_ROLE)).toBe(true)
    expect(isGroupApproverRole(GROUP_ORDER_PORTAL_ROLE)).toBe(false)
    for (const role of SINGLE_BRANCH_ROLES) {
      expect(isGroupApproverRole(role)).toBe(false)
    }
  })

  it("accepts both group roles as system roles", () => {
    expect(systemRoleSchema.safeParse("GROUP_ORDER_PORTAL").success).toBe(true)
    expect(systemRoleSchema.safeParse("GROUP_USER").success).toBe(true)
  })
})

describe("group and branch assignments are confined to the group roles", () => {
  it("accepts assignments for either group role", () => {
    expect(rejectScopeForSingleBranchRole("GROUP_ORDER_PORTAL", [1, 2], [3])).toBeNull()
    expect(rejectScopeForSingleBranchRole("GROUP_USER", [1], [2, 3])).toBeNull()
  })

  it("rejects assignments smuggled onto any single-branch role", () => {
    for (const role of SINGLE_BRANCH_ROLES) {
      expect(rejectScopeForSingleBranchRole(role, [1], [])).toEqual({
        message: "Group and branch assignments apply only to the group-based roles",
        status: 400,
      })
      expect(rejectScopeForSingleBranchRole(role, [], [7])).not.toBeNull()
    }
  })

  it("leaves single-branch roles alone when no assignments are supplied", () => {
    for (const role of SINGLE_BRANCH_ROLES) {
      expect(rejectScopeForSingleBranchRole(role, [], [])).toBeNull()
    }
  })
})

describe("role hierarchy placement", () => {
  it("lets administrators above them assign both group roles", () => {
    for (const role of ["GROUP_ORDER_PORTAL", "GROUP_USER"] as const) {
      expect(canAssignRole("SUPER_ADMIN", role)).toBe(true)
      expect(canAssignRole("HEAD_OFFICE", role)).toBe(true)
      expect(canManageUser("SUPER_ADMIN", role)).toBe(true)
      expect(canManageUser("HEAD_OFFICE", role)).toBe(true)
    }
  })

  it("does not let either group role assign or manage anyone above itself", () => {
    for (const role of ["HEAD_OFFICE", "SUPER_ADMIN"] as const) {
      expect(canAssignRole("GROUP_ORDER_PORTAL", role)).toBe(false)
      expect(canAssignRole("GROUP_USER", role)).toBe(false)
      expect(canManageUser("GROUP_ORDER_PORTAL", role)).toBe(false)
      expect(canManageUser("GROUP_USER", role)).toBe(false)
    }
  })

  it("keeps a Branch Admin from creating a multi-branch approver", () => {
    expect(canAssignRole("BRANCH_ADMIN", "GROUP_USER")).toBe(false)
    expect(canManageUser("BRANCH_ADMIN", "GROUP_USER")).toBe(false)
  })

  it("preserves every pre-existing role relationship", () => {
    expect(canAssignRole("SUPER_ADMIN", "HEAD_OFFICE")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "BRANCH_ADMIN")).toBe(true)
    expect(canAssignRole("HEAD_OFFICE", "ORDER_PORTAL")).toBe(true)
    expect(canAssignRole("BRANCH_ADMIN", "ORDER_PORTAL")).toBe(true)
    expect(canAssignRole("BRANCH_ADMIN", "HEAD_OFFICE")).toBe(false)
    expect(canAssignRole("ORDER_PORTAL", "ORDER_PORTAL")).toBe(false)
    expect(canAssignRole("SUPER_ADMIN", "SUPER_ADMIN")).toBe(false)
  })
})

describe("user creation payload", () => {
  const baseUser = {
    firstName: "Ayesha",
    lastName: "Khan",
    email: "ayesha.khan@example.com",
    username: "ayesha.khan",
    password: "Str0ng-Passphrase!",
    organizationId: 4,
    branchId: null,
  }

  it("accepts group and branch assignments for both group roles", () => {
    for (const role of ["GROUP_ORDER_PORTAL", "GROUP_USER"] as const) {
      const parsed = userCreateSchema.safeParse({
        ...baseUser,
        role,
        groupIds: [1, 2],
        branchIds: [8],
      })
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.groupIds).toEqual([1, 2])
      expect(parsed.success && parsed.data.branchIds).toEqual([8])
    }
  })

  it("defaults both lists to empty so existing callers are unaffected", () => {
    const parsed = userCreateSchema.safeParse({ ...baseUser, role: "ORDER_PORTAL", branchId: 9 })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.groupIds).toEqual([])
    expect(parsed.success && parsed.data.branchIds).toEqual([])
  })

  it("rejects duplicate ids", () => {
    const parsed = userCreateSchema.safeParse({
      ...baseUser,
      role: "GROUP_USER",
      groupIds: [3, 3],
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects non-positive ids", () => {
    const parsed = userCreateSchema.safeParse({
      ...baseUser,
      role: "GROUP_USER",
      branchIds: [0],
    })
    expect(parsed.success).toBe(false)
  })
})
