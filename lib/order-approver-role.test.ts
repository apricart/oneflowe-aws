import { describe, expect, it } from "vitest"

import { canMakeOrderDecision } from "@/lib/order-approver-role"
import type { Role } from "@/lib/rbac"

const access = (overrides: Partial<{
  actorRole: Role
  actorOrganizationId: number | null
  actorBranchId: number | null
  configuredApproverRole: unknown
  orderOrganizationId: number | null
  orderBranchId: number
  branchOrganizationId: number | null
  actorScopedBranchIds: number[] | null | undefined
}> = {}) => canMakeOrderDecision({
  actorRole: "BRANCH_ADMIN",
  actorOrganizationId: 10,
  actorBranchId: 20,
  configuredApproverRole: "BRANCH_ADMIN",
  orderOrganizationId: 10,
  orderBranchId: 20,
  branchOrganizationId: 10,
  ...overrides,
})

describe("order approver policy", () => {
  it("allows only the configured Branch Admin in the order branch", () => {
    expect(access()).toBe(true)
    expect(access({ actorBranchId: 21 })).toBe(false)
    expect(access({ configuredApproverRole: "HEAD_OFFICE" })).toBe(false)
  })

  it("allows configured Head Office across branches in its organization", () => {
    expect(access({
      actorRole: "HEAD_OFFICE",
      actorBranchId: null,
      configuredApproverRole: "HEAD_OFFICE",
      orderBranchId: 99,
    })).toBe(true)
    expect(access({
      actorRole: "HEAD_OFFICE",
      actorBranchId: null,
      configuredApproverRole: "BRANCH_ADMIN",
    })).toBe(false)
  })

  it("fails closed across organizations and malformed branch ownership", () => {
    expect(access({ actorOrganizationId: 11 })).toBe(false)
    expect(access({ branchOrganizationId: 11 })).toBe(false)
    expect(access({ orderOrganizationId: null })).toBe(false)
  })

  it("never grants order decisions to Super Admin or an invalid policy value", () => {
    expect(access({ actorRole: "SUPER_ADMIN" })).toBe(false)
    expect(access({ configuredApproverRole: "SUPER_ADMIN" })).toBe(false)
    expect(access({ configuredApproverRole: null })).toBe(false)
  })

  it("ignores a multi-branch scope for every single-branch role", () => {
    // A scope list must never widen a role that does not use one.
    expect(access({ actorBranchId: 21, actorScopedBranchIds: [20] })).toBe(false)
    expect(access({
      actorRole: "HEAD_OFFICE",
      actorBranchId: null,
      configuredApproverRole: "BRANCH_ADMIN",
      actorScopedBranchIds: [20],
    })).toBe(false)
    expect(access({ actorRole: "SUPER_ADMIN", actorScopedBranchIds: [20] })).toBe(false)
    expect(access({ actorRole: "ORDER_PORTAL", actorScopedBranchIds: [20] })).toBe(false)
    expect(access({ actorRole: "GROUP_ORDER_PORTAL", actorScopedBranchIds: [20] })).toBe(false)
  })
})

const groupUserAccess = (overrides: Parameters<typeof access>[0] = {}) => access({
  actorRole: "GROUP_USER",
  actorBranchId: null,
  actorScopedBranchIds: [20, 21],
  ...overrides,
})

describe("group user order decisions", () => {
  it("decides only for branches inside its assigned scope", () => {
    expect(groupUserAccess()).toBe(true)
    expect(groupUserAccess({ orderBranchId: 21 })).toBe(true)
    expect(groupUserAccess({ orderBranchId: 99 })).toBe(false)
  })

  it("fails closed without a resolved scope", () => {
    expect(groupUserAccess({ actorScopedBranchIds: [] })).toBe(false)
    expect(groupUserAccess({ actorScopedBranchIds: null })).toBe(false)
    expect(groupUserAccess({ actorScopedBranchIds: undefined })).toBe(false)
  })

  it("still fails closed across organizations and malformed branch ownership", () => {
    expect(groupUserAccess({ actorOrganizationId: 11 })).toBe(false)
    expect(groupUserAccess({ branchOrganizationId: 11 })).toBe(false)
    expect(groupUserAccess({ orderOrganizationId: null })).toBe(false)
    expect(groupUserAccess({ actorOrganizationId: null })).toBe(false)
  })

  it("does not depend on the tenant's configured approver role", () => {
    // Its authority comes from its assignments, so either configured value works.
    expect(groupUserAccess({ configuredApproverRole: "HEAD_OFFICE" })).toBe(true)
    expect(groupUserAccess({ configuredApproverRole: "BRANCH_ADMIN" })).toBe(true)
  })
})

