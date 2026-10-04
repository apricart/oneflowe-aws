import { describe, expect, it } from "vitest"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"

const FULFILLMENT_ROLES = [
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const

describe("fulfillment token access", () => {
  it.each(FULFILLMENT_ROLES)("allows %s to fulfill an approved order after its scope check", (role) => {
    expect(canViewFulfillmentToken({
      role,
      orderStatus: " approved ",
      userId: "viewer-id",
      orderCreatedByUserId: "different-user-id",
      orderApprovedByUserId: "another-user-id",
      configuredApproverRole: role === "HEAD_OFFICE" ? "BRANCH_ADMIN" : "HEAD_OFFICE",
    })).toBe(true)
  })

  it.each(FULFILLMENT_ROLES)("does not expose a token to %s before approval", (role) => {
    expect(canViewFulfillmentToken({ role, orderStatus: "PENDING" })).toBe(false)
    expect(canViewFulfillmentToken({ role, orderStatus: "REJECTED" })).toBe(false)
    expect(canViewFulfillmentToken({ role })).toBe(false)
  })

  it("does not grant fulfillment-token access to an unknown or read-only role", () => {
    expect(canViewFulfillmentToken({ role: "VIEWER", orderStatus: "APPROVED" })).toBe(false)
    expect(canViewFulfillmentToken({ role: "UNKNOWN_ROLE", orderStatus: "APPROVED" })).toBe(false)
    expect(canViewFulfillmentToken({ orderStatus: "APPROVED" })).toBe(false)
  })

  it("preserves Super Admin token access for its existing verification flow", () => {
    expect(canViewFulfillmentToken({ role: "SUPER_ADMIN", orderStatus: "APPROVED" })).toBe(true)
    expect(canViewFulfillmentToken({ role: "SUPER_ADMIN", orderStatus: "FULFILLED" })).toBe(true)
  })
})
