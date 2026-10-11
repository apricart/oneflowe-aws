import { describe, expect, it } from "vitest"

import { groupOrderCancelRefusal, isCancellableGroupOrderStatus } from "@/lib/group-order-cancel"

describe("groupOrderCancelRefusal", () => {
  it("allows a pending group order", () => {
    expect(groupOrderCancelRefusal({ status: "PENDING", groupOrderId: 41 })).toBeNull()
  })

  it("normalises case and surrounding space", () => {
    expect(groupOrderCancelRefusal({ status: " pending ", groupOrderId: 41 })).toBeNull()
  })

  it("refuses every status past pending — once approved it is no longer the requester's", () => {
    for (const status of ["APPROVED", "FULFILLED", "PARTIALLY_FULFILLED", "REJECTED", "CANCELLED", "REFUNDED"]) {
      expect(groupOrderCancelRefusal({ status, groupOrderId: 41 }), status).toBe("NOT_PENDING")
    }
  })

  it("refuses a missing or unknown status rather than guessing", () => {
    expect(groupOrderCancelRefusal({ status: null, groupOrderId: 41 })).toBe("NOT_PENDING")
    expect(groupOrderCancelRefusal({ status: "SOMETHING", groupOrderId: 41 })).toBe("NOT_PENDING")
  })

  it("refuses an order that is not part of a group order, whatever its status", () => {
    expect(groupOrderCancelRefusal({ status: "PENDING", groupOrderId: null })).toBe("NOT_GROUP_ORDER")
    expect(groupOrderCancelRefusal({ status: "PENDING" })).toBe("NOT_GROUP_ORDER")
    expect(groupOrderCancelRefusal({ status: "PENDING", groupOrderId: 0 })).toBe("NOT_GROUP_ORDER")
  })
})

describe("isCancellableGroupOrderStatus", () => {
  it("is true only for pending", () => {
    expect(isCancellableGroupOrderStatus("PENDING")).toBe(true)
    expect(isCancellableGroupOrderStatus("pending")).toBe(true)
    expect(isCancellableGroupOrderStatus("APPROVED")).toBe(false)
    expect(isCancellableGroupOrderStatus(undefined)).toBe(false)
  })
})
