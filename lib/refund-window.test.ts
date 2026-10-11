import { describe, expect, it } from "vitest"

import {
  REFUND_NOT_YET_AVAILABLE_REASON,
  REFUND_WINDOW_CLOSED_REASON,
  REQUESTER_REFUND_WINDOW_DAYS,
  REQUESTER_REFUND_WINDOW_MS,
  isRefundWindowExemptRole,
  isWithinRequesterRefundWindow,
  refundTimingReasonForRole,
  requesterRefundDeadline,
  requesterRefundTimingReason,
} from "@/lib/refund-window"

const FULFILLED_AT = new Date("2026-10-01T10:00:00.000Z")
const DEADLINE = new Date("2026-10-08T10:00:00.000Z")
const ms = (date: Date, offset: number) => new Date(date.getTime() + offset)

const fulfilledDelivered = {
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  fulfilledAt: FULFILLED_AT,
}

describe("the requester refund window", () => {
  it("is seven days long", () => {
    expect(REQUESTER_REFUND_WINDOW_DAYS).toBe(7)
    expect(REQUESTER_REFUND_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it("closes exactly seven days after fulfilment", () => {
    expect(requesterRefundDeadline(FULFILLED_AT)).toEqual(DEADLINE)
    expect(requesterRefundDeadline(FULFILLED_AT.toISOString())).toEqual(DEADLINE)
  })

  it("is open from the moment of fulfilment up to and including the deadline", () => {
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, FULFILLED_AT)).toBe(true)
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, ms(FULFILLED_AT, 60_000))).toBe(true)
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, ms(DEADLINE, -1))).toBe(true)
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, DEADLINE)).toBe(true)
  })

  it("is closed one millisecond after the deadline and from then on", () => {
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, ms(DEADLINE, 1))).toBe(false)
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, new Date("2027-01-01T00:00:00.000Z"))).toBe(false)
  })

  it("is not a calendar month: it crosses a month boundary and ignores the order date", () => {
    // Fulfilled on the last day of September, still open in October.
    const lateSeptember = new Date("2026-09-30T20:00:00.000Z")
    expect(isWithinRequesterRefundWindow(lateSeptember, new Date("2026-10-06T12:00:00.000Z"))).toBe(true)
  })

  it("treats an order with no fulfilment time, or an unreadable one, as outside the window", () => {
    for (const missing of [null, undefined, "", "not-a-date"]) {
      expect(requesterRefundDeadline(missing)).toBeNull()
      expect(isWithinRequesterRefundWindow(missing, FULFILLED_AT)).toBe(false)
    }
  })

  it("does not refuse a request a server clock slightly behind the fulfilment write would see", () => {
    expect(isWithinRequesterRefundWindow(FULFILLED_AT, ms(FULFILLED_AT, -5_000))).toBe(true)
  })
})

describe("requesterRefundTimingReason", () => {
  it("allows a fulfilled, delivered order inside the window", () => {
    expect(requesterRefundTimingReason(fulfilledDelivered, ms(FULFILLED_AT, 3 * 24 * 60 * 60 * 1000))).toBeNull()
  })

  it.each([
    ["PENDING", "NOT_STARTED"],
    ["APPROVED", "OUT_FOR_DELIVERY"],
    ["APPROVED", "DELIVERED"],
    ["FULFILLED", "IN_PROCESS"],
    ["FULFILLED", null],
  ])("refuses %s / %s as not yet available", (status, fulfillmentStatus) => {
    expect(requesterRefundTimingReason({ ...fulfilledDelivered, status, fulfillmentStatus }, FULFILLED_AT))
      .toBe(REFUND_NOT_YET_AVAILABLE_REASON)
  })

  it("reports the window as closed after the seventh day", () => {
    expect(requesterRefundTimingReason(fulfilledDelivered, ms(DEADLINE, 1))).toBe(REFUND_WINDOW_CLOSED_REASON)
    expect(REFUND_WINDOW_CLOSED_REASON).toContain("within 7 days of the order being fulfilled")
  })

  it("reports a fulfilled order with no fulfilment time as closed", () => {
    expect(requesterRefundTimingReason({ ...fulfilledDelivered, fulfilledAt: null }, FULFILLED_AT))
      .toBe(REFUND_WINDOW_CLOSED_REASON)
  })

  it("reads status and delivery case- and whitespace-insensitively", () => {
    expect(requesterRefundTimingReason({ ...fulfilledDelivered, status: " fulfilled ", fulfillmentStatus: "delivered" }, FULFILLED_AT))
      .toBeNull()
  })
})

describe("Super Admin has no time limit", () => {
  it("exempts Super Admin and no other role", () => {
    expect(isRefundWindowExemptRole("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "ORDER_DESK", "GROUP_USER", "super_admin", "", null, undefined]) {
      expect(isRefundWindowExemptRole(role), String(role)).toBe(false)
    }
  })

  it("lets Super Admin act on an order long after its window, and before delivery", () => {
    const yearLater = new Date("2027-10-01T00:00:00.000Z")
    expect(refundTimingReasonForRole("SUPER_ADMIN", fulfilledDelivered, yearLater)).toBeNull()
    expect(refundTimingReasonForRole("SUPER_ADMIN", { status: "APPROVED", fulfillmentStatus: "IN_PROCESS", fulfilledAt: null }, yearLater))
      .toBeNull()
  })

  it.each(["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "ORDER_DESK"])(
    "holds %s to the requester window",
    (role) => {
      expect(refundTimingReasonForRole(role, fulfilledDelivered, DEADLINE)).toBeNull()
      expect(refundTimingReasonForRole(role, fulfilledDelivered, ms(DEADLINE, 1))).toBe(REFUND_WINDOW_CLOSED_REASON)
      expect(refundTimingReasonForRole(role, { status: "APPROVED", fulfillmentStatus: "DELIVERED", fulfilledAt: null }, FULFILLED_AT))
        .toBe(REFUND_NOT_YET_AVAILABLE_REASON)
    },
  )
})
