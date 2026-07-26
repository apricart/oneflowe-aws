import { describe, expect, it } from "vitest"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"

const approvedOrder = {
  orderStatus: "APPROVED",
  orderCreatedByUserId: "creator-id",
  orderApprovedByUserId: "approver-id",
}

describe("fulfillment token access", () => {
  it("allows the Order Portal creator to view an approved order token", () => {
    expect(canViewFulfillmentToken({
      ...approvedOrder,
      role: "ORDER_PORTAL",
      userId: "creator-id",
    })).toBe(true)
  })

  it("denies another Order Portal user in the same scope", () => {
    expect(canViewFulfillmentToken({
      ...approvedOrder,
      role: "ORDER_PORTAL",
      userId: "different-user-id",
    })).toBe(false)
  })

  it("does not expose a token to the Order Portal creator before approval", () => {
    expect(canViewFulfillmentToken({
      ...approvedOrder,
      role: "ORDER_PORTAL",
      userId: "creator-id",
      orderStatus: "PENDING",
    })).toBe(false)
  })

  it("preserves access for super admins, branch admins, and the approver", () => {
    expect(canViewFulfillmentToken({ ...approvedOrder, role: "SUPER_ADMIN", userId: "admin-id" })).toBe(true)
    expect(canViewFulfillmentToken({ ...approvedOrder, role: "BRANCH_ADMIN", userId: "branch-admin-id" })).toBe(true)
    expect(canViewFulfillmentToken({ ...approvedOrder, role: "HEAD_OFFICE", userId: "approver-id" })).toBe(true)
  })
})
