import { describe, expect, it } from "vitest"

import { resolveBranchCreationAccess } from "./branch-creation-access"

describe("branch creation tenant access", () => {
  it("allows a Super Admin to select an organization", () => {
    expect(resolveBranchCreationAccess(
      { role: "SUPER_ADMIN", organizationId: null },
      42,
    )).toEqual({ allowed: true, organizationId: 42 })
  })

  it("allows Head Office to create inside its assigned organization", () => {
    expect(resolveBranchCreationAccess(
      { role: "HEAD_OFFICE", organizationId: 12 },
      12,
    )).toEqual({ allowed: true, organizationId: 12 })
  })

  it("rejects a Head Office cross-tenant organization request", () => {
    expect(resolveBranchCreationAccess(
      { role: "HEAD_OFFICE", organizationId: 12 },
      99,
    )).toEqual({
      allowed: false,
      status: 403,
      message: "Forbidden: Branches can only be created in your assigned organization",
    })
  })

  it("fails closed when Head Office has no organization assignment", () => {
    expect(resolveBranchCreationAccess(
      { role: "HEAD_OFFICE", organizationId: null },
      12,
    )).toEqual({
      allowed: false,
      status: 403,
      message: "Organization context required",
    })
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"] as const)(
    "does not grant branch creation to %s",
    (role) => {
      expect(resolveBranchCreationAccess(
        { role, organizationId: 12 },
        12,
      )).toMatchObject({ allowed: false, status: 403 })
    },
  )
})
