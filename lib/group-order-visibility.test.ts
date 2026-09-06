import { describe, expect, it } from "vitest"

import {
  canOrderPortalReadOrder,
  isGroupPortalOrder,
  isOrderCreatorRole,
  ORDER_CREATOR_ROLES,
} from "@/lib/group-order-visibility"

const REQUESTER = "11111111-1111-4111-8111-111111111111"
const COLLEAGUE = "22222222-2222-4222-8222-222222222222"
const GROUP_PORTAL_USER = "33333333-3333-4333-8333-333333333333"

describe("isGroupPortalOrder", () => {
  it("recognises an order raised under a group submission", () => {
    expect(isGroupPortalOrder({ groupOrderId: 41 })).toBe(true)
  })

  it("treats every other order as an ordinary one", () => {
    // This is the property the whole change rests on: `groupOrderId` is null on
    // every order created by any other flow, so no existing order changes hands.
    expect(isGroupPortalOrder({ groupOrderId: null })).toBe(false)
    expect(isGroupPortalOrder({ groupOrderId: undefined })).toBe(false)
    expect(isGroupPortalOrder(null)).toBe(false)
    expect(isGroupPortalOrder(undefined)).toBe(false)
  })

  it("does not accept a non-numeric envelope reference", () => {
    expect(isGroupPortalOrder({ groupOrderId: "7" as unknown as number })).toBe(false)
  })
})

describe("canOrderPortalReadOrder", () => {
  it("reads an order it raised itself", () => {
    expect(canOrderPortalReadOrder({
      viewerUserId: REQUESTER,
      order: { createdByUserId: REQUESTER, groupOrderId: null },
    })).toBe(true)
  })

  it("reads a group order raised for its branch by someone else", () => {
    expect(canOrderPortalReadOrder({
      viewerUserId: REQUESTER,
      order: { createdByUserId: GROUP_PORTAL_USER, groupOrderId: 9 },
    })).toBe(true)
  })

  it("still cannot read a colleague's own order", () => {
    // The widening is limited to orders raised *for the branch*. One requester
    // must never gain sight of another requester's personal order.
    expect(canOrderPortalReadOrder({
      viewerUserId: REQUESTER,
      order: { createdByUserId: COLLEAGUE, groupOrderId: null },
    })).toBe(false)
  })

  it("fails closed without a viewer", () => {
    expect(canOrderPortalReadOrder({
      viewerUserId: null,
      order: { createdByUserId: REQUESTER, groupOrderId: null },
    })).toBe(false)
    expect(canOrderPortalReadOrder({
      viewerUserId: undefined,
      order: { createdByUserId: REQUESTER, groupOrderId: null },
    })).toBe(false)
  })

  it("fails closed without an order", () => {
    expect(canOrderPortalReadOrder({ viewerUserId: REQUESTER, order: null })).toBe(false)
    expect(canOrderPortalReadOrder({ viewerUserId: REQUESTER, order: undefined })).toBe(false)
  })

  it("does not treat a missing creator as a match for a missing viewer", () => {
    expect(canOrderPortalReadOrder({
      viewerUserId: null,
      order: { createdByUserId: null, groupOrderId: null },
    })).toBe(false)
  })
})

describe("order creator roles", () => {
  it("names both requester roles and nothing else", () => {
    expect([...ORDER_CREATOR_ROLES]).toEqual(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])
  })

  it("excludes every approving and administrative role", () => {
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER"]) {
      expect(isOrderCreatorRole(role)).toBe(false)
    }
  })

  it("rejects non-string input", () => {
    expect(isOrderCreatorRole(null)).toBe(false)
    expect(isOrderCreatorRole(undefined)).toBe(false)
    expect(isOrderCreatorRole(1)).toBe(false)
  })
})
