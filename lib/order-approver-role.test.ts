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
})

