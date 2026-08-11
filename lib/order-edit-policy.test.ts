import { describe, expect, it } from "vitest"

import { canOrderPortalEditOrder } from "@/lib/order-edit-policy"

const allowed = {
  actorRole: "ORDER_PORTAL",
  actorUserId: "user-1",
  actorOrganizationId: 10,
  actorBranchId: 20,
  orderStatus: "PENDING",
  orderCreatedByUserId: "user-1",
  orderOrganizationId: 10,
  orderBranchId: 20,
  branchOrganizationId: 10,
}

describe("Order Portal edit policy", () => {
  it("allows the creator to edit their own pending order in the same tenant and branch", () => {
    expect(canOrderPortalEditOrder(allowed)).toBe(true)
  })

  it.each(["APPROVED", "REJECTED", "FULFILLED", "REFUNDED"])(
    "blocks an order in %s state",
    (orderStatus) => {
      expect(canOrderPortalEditOrder({ ...allowed, orderStatus })).toBe(false)
    },
  )

  it("blocks other users, roles, organizations, and branches", () => {
    expect(canOrderPortalEditOrder({ ...allowed, actorUserId: "user-2" })).toBe(false)
    expect(canOrderPortalEditOrder({ ...allowed, actorRole: "BRANCH_ADMIN" })).toBe(false)
    expect(canOrderPortalEditOrder({ ...allowed, actorOrganizationId: 11 })).toBe(false)
    expect(canOrderPortalEditOrder({ ...allowed, actorBranchId: 21 })).toBe(false)
    expect(canOrderPortalEditOrder({ ...allowed, branchOrganizationId: 11 })).toBe(false)
  })
})
