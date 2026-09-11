import { describe, expect, it } from "vitest"

import {
  applyOrderCreatorContactVisibility,
  canViewOrderCreatorContact,
} from "@/lib/order-detail-visibility"

const CONTACT = {
  creatorEmail: "employee@example.test",
  creatorPhone: "+920000000000",
  creatorEmployeeId: "EMP-1",
}

describe("canViewOrderCreatorContact", () => {
  it("withholds contact details from a requester reading someone else's order", () => {
    expect(canViewOrderCreatorContact({
      role: "GROUP_ORDER_PORTAL",
      viewerUserId: "requester-1",
      orderCreatedByUserId: "employee-9",
    })).toBe(false)
  })

  it("still shows a requester its own order's contact row", () => {
    expect(canViewOrderCreatorContact({
      role: "GROUP_ORDER_PORTAL",
      viewerUserId: "requester-1",
      orderCreatedByUserId: "requester-1",
    })).toBe(true)
  })

  it("withholds them when the requester has no identity to compare", () => {
    // Fail closed: an unidentified caller is never treated as the creator.
    for (const viewerUserId of [null, undefined, ""]) {
      expect(canViewOrderCreatorContact({
        role: "GROUP_ORDER_PORTAL",
        viewerUserId,
        orderCreatedByUserId: null,
      })).toBe(false)
    }
  })

  it("leaves every other role exactly as it was", () => {
    for (const role of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"]) {
      expect(canViewOrderCreatorContact({
        role,
        viewerUserId: "viewer-1",
        orderCreatedByUserId: "employee-9",
      })).toBe(true)
    }
  })
})

describe("applyOrderCreatorContactVisibility", () => {
  it("blanks the contact fields without dropping the keys", () => {
    const result = applyOrderCreatorContactVisibility(
      { ...CONTACT, creatorName: "Employee Nine", id: 7 },
      { role: "GROUP_ORDER_PORTAL", viewerUserId: "requester-1", orderCreatedByUserId: "employee-9" },
    )

    // Nulled rather than deleted: clients read these by key.
    expect(result).toHaveProperty("creatorEmail", null)
    expect(result).toHaveProperty("creatorPhone", null)
    expect(result).toHaveProperty("creatorEmployeeId", null)
  })

  it("keeps the display name, which is what 'who raised this' needs", () => {
    const result = applyOrderCreatorContactVisibility(
      { ...CONTACT, creatorName: "Employee Nine" },
      { role: "GROUP_ORDER_PORTAL", viewerUserId: "requester-1", orderCreatedByUserId: "employee-9" },
    )

    expect(result.creatorName).toBe("Employee Nine")
  })

  it("carries every unrelated field through untouched", () => {
    const order = { ...CONTACT, id: 7, tid: "abc", totalCents: 1000 }
    const result = applyOrderCreatorContactVisibility(
      order,
      { role: "GROUP_ORDER_PORTAL", viewerUserId: "requester-1", orderCreatedByUserId: "employee-9" },
    )

    expect(result.id).toBe(7)
    expect(result.tid).toBe("abc")
    expect(result.totalCents).toBe(1000)
  })

  it("returns the same object for a viewer that may see the contact row", () => {
    const order = { ...CONTACT }
    const result = applyOrderCreatorContactVisibility(
      order,
      { role: "BRANCH_ADMIN", viewerUserId: "admin-1", orderCreatedByUserId: "employee-9" },
    )

    expect(result).toBe(order)
    expect(result.creatorEmail).toBe(CONTACT.creatorEmail)
  })

  it("does not mutate the order it was given", () => {
    const order = { ...CONTACT }
    applyOrderCreatorContactVisibility(
      order,
      { role: "GROUP_ORDER_PORTAL", viewerUserId: "requester-1", orderCreatedByUserId: "employee-9" },
    )

    expect(order.creatorEmail).toBe(CONTACT.creatorEmail)
  })
})
