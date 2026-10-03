import { describe, expect, it } from "vitest"

import { matchesViewerStatusBucket } from "@/lib/order-delivery-status"
import {
  DeliveryAcknowledgementBlockedError,
  UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE,
  UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD,
  isDeliveryAcknowledgementBlockedError,
  isUnacknowledgedDelivery,
  noticeForGroupResults,
  noticeFromDeliveryAcknowledgementView,
  parseUnacknowledgedDeliveriesResponse,
  resolveDeliveryAcknowledgement,
  unacknowledgedDeliveriesMessage,
  unacknowledgedDeliveryCountLabel,
} from "@/lib/unacknowledged-delivery-block"

const ORDER_STATUSES = ["PENDING", "APPROVED", "REJECTED", "FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED", "REFUNDED", "CANCELLED"]
const FULFILLMENT_STATUSES = ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED", null, undefined, "", "bogus"]

describe("what counts as an unacknowledged delivery", () => {
  it("is exactly APPROVED and DELIVERED — every other combination is not", () => {
    for (const status of ORDER_STATUSES) {
      for (const fulfillmentStatus of FULFILLMENT_STATUSES) {
        const expected = status === "APPROVED" && fulfillmentStatus === "DELIVERED"
        expect(isUnacknowledgedDelivery({ status, fulfillmentStatus }), `${status}/${String(fulfillmentStatus)}`).toBe(expected)
      }
    }
  })

  it("ignores case and surrounding whitespace, like the rest of the status rules", () => {
    expect(isUnacknowledgedDelivery({ status: "approved", fulfillmentStatus: "delivered" })).toBe(true)
    expect(isUnacknowledgedDelivery({ status: " Approved ", fulfillmentStatus: " Delivered " })).toBe(true)
  })

  it("treats a missing status as not counted", () => {
    expect(isUnacknowledgedDelivery({ status: null, fulfillmentStatus: "DELIVERED" })).toBe(false)
    expect(isUnacknowledgedDelivery({})).toBe(false)
  })

  it("is the dashboard's Delivered/Unacknowledged bucket, so the two cannot disagree", () => {
    for (const status of ORDER_STATUSES) {
      for (const fulfillmentStatus of FULFILLMENT_STATUSES) {
        const order = { status, fulfillmentStatus }
        expect(isUnacknowledgedDelivery(order)).toBe(matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", order))
      }
    }
  })
})

describe("the decision", () => {
  it("the threshold is two", () => {
    expect(UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD).toBe(2)
  })

  it.each([
    [0, true],
    [1, true],
    [2, false],
    [3, false],
    [250, false],
  ])("with the toggle on, %i unacknowledged → orderingAllowed %s", (count, allowed) => {
    expect(resolveDeliveryAcknowledgement({ enabled: true, unacknowledgedCount: count })).toEqual({
      enabled: true,
      orderingAllowed: allowed,
      unacknowledgedCount: count,
      threshold: 2,
    })
  })

  it("with the toggle off, nothing is blocked and nothing is reported, whatever the count", () => {
    expect(resolveDeliveryAcknowledgement({ enabled: false, unacknowledgedCount: 99 })).toEqual({
      enabled: false,
      orderingAllowed: true,
      unacknowledgedCount: 0,
      threshold: 2,
    })
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("a nonsensical count (%s) is read as zero, never as a block", (count) => {
    expect(resolveDeliveryAcknowledgement({ enabled: true, unacknowledgedCount: count })).toMatchObject({
      orderingAllowed: true,
      unacknowledgedCount: 0,
    })
  })
})

describe("the wording", () => {
  it("says how many, and what to do", () => {
    expect(unacknowledgedDeliveriesMessage(2)).toBe(
      "Your branch has 2 delivered orders awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order.",
    )
  })

  it("is singular for one", () => {
    expect(unacknowledgedDeliveryCountLabel(1)).toBe("1 delivered order awaiting acknowledgement")
    expect(unacknowledgedDeliveryCountLabel(3)).toBe("3 delivered orders awaiting acknowledgement")
  })
})

describe("the gate's error", () => {
  const error = new DeliveryAcknowledgementBlockedError({ unacknowledgedCount: 3, threshold: 2 })

  it("carries the message, the code, and only the count and the threshold", () => {
    expect(error.message).toBe(unacknowledgedDeliveriesMessage(3))
    expect(error.code).toBe(UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE)
    expect(error.details).toEqual({ code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedCount: 3, threshold: 2 })
    expect(error).toBeInstanceOf(Error)
  })

  it("is recognised by instance and by shape, and nothing else is", () => {
    expect(isDeliveryAcknowledgementBlockedError(error)).toBe(true)
    expect(isDeliveryAcknowledgementBlockedError({ code: UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE, message: "m", details: {} })).toBe(true)
    expect(isDeliveryAcknowledgementBlockedError({ code: UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE })).toBe(false)
    expect(isDeliveryAcknowledgementBlockedError({ code: "PAYMENT_CONTROL_BLOCKED", message: "m", details: {} })).toBe(false)
    expect(isDeliveryAcknowledgementBlockedError(new Error("Insufficient budget"))).toBe(false)
    expect(isDeliveryAcknowledgementBlockedError(null)).toBe(false)
    expect(isDeliveryAcknowledgementBlockedError("UNACKNOWLEDGED_DELIVERIES_BLOCKED")).toBe(false)
  })
})

describe("recognising the 409 from POST /api/v1/orders", () => {
  const body = {
    error: "Your branch has 2 delivered orders awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order.",
    code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED",
    deliveryAcknowledgement: { code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedCount: 2, threshold: 2 },
  }

  it("turns the refusal into the popup", () => {
    expect(parseUnacknowledgedDeliveriesResponse(409, body)).toEqual({ message: body.error, branches: [] })
  })

  it("rebuilds the message when the server sent none", () => {
    expect(parseUnacknowledgedDeliveriesResponse(409, { ...body, error: "  " })).toEqual({
      message: unacknowledgedDeliveriesMessage(2),
      branches: [],
    })
  })

  it.each([
    ["another status", 400, body],
    ["a 200", 200, body],
    ["the payment-control refusal", 409, { error: "x", code: "PAYMENT_CONTROL_BLOCKED", paymentControl: { overdueCount: 2, threshold: 2 } }],
    ["a stale-order 409", 409, { error: "Order was already changed" }],
    ["missing details", 409, { error: "x", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED" }],
    ["a non-numeric count", 409, { ...body, deliveryAcknowledgement: { unacknowledgedCount: "2" } }],
    ["a negative count", 409, { ...body, deliveryAcknowledgement: { unacknowledgedCount: -1 } }],
    ["null", 409, null],
    ["a string", 409, "UNACKNOWLEDGED_DELIVERIES_BLOCKED"],
  ])("ignores %s", (_label, status, candidate) => {
    expect(parseUnacknowledgedDeliveriesResponse(status as number, candidate)).toBeNull()
  })
})

describe("reading the pre-check view", () => {
  it("a blocked view becomes the popup", () => {
    expect(noticeFromDeliveryAcknowledgementView({ enabled: true, orderingAllowed: false, unacknowledgedCount: 4, threshold: 2 })).toEqual({
      message: unacknowledgedDeliveriesMessage(4),
      branches: [],
    })
  })

  it.each([
    ["an allowed view", { enabled: true, orderingAllowed: true, unacknowledgedCount: 1, threshold: 2 }],
    ["the toggle off", { enabled: false, orderingAllowed: true, unacknowledgedCount: 0, threshold: 2 }],
    ["a missing flag", { unacknowledgedCount: 5 }],
    ["a malformed count", { orderingAllowed: false, unacknowledgedCount: "5" }],
    ["null", null],
    ["an array", []],
  ])("shows nothing for %s", (_label, view) => {
    expect(noticeFromDeliveryAcknowledgementView(view)).toBeNull()
  })
})

describe("reading a group submission's results", () => {
  it("lists only the locations refused for this reason, and keeps their counts", () => {
    // Real results carry more than the parser reads (reason, unpaidInvoiceCount).
    const results = [
      { status: "created", branchId: 1, branchName: "North" },
      { status: "failed", branchId: 2, branchName: "South", reason: "x", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedDeliveryCount: 2 },
      { status: "failed", branchId: 3, branchName: "East", reason: "x", code: "PAYMENT_CONTROL_BLOCKED", unpaidInvoiceCount: 2 },
      { status: "failed", branchId: 4, branchName: "West", reason: "Insufficient budget" },
      { status: "failed", branchId: 5, branchName: "Hub", reason: "x", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedDeliveryCount: 7 },
    ]
    const notice = noticeForGroupResults(results)
    expect(notice?.branches).toEqual([
      { branchId: 2, branchName: "South", unacknowledgedCount: 2 },
      { branchId: 5, branchName: "Hub", unacknowledgedCount: 7 },
    ])
    expect(notice?.message).toContain("acknowledge/fulfil")
  })

  it.each([
    ["no failure of this kind", [{ status: "created", branchId: 1, branchName: "North" }]],
    ["an empty list", []],
    ["no list at all", undefined],
    ["a malformed row", [{ status: "failed", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", branchId: "2", branchName: "S", unacknowledgedDeliveryCount: 2 }]],
    ["a row with no count", [{ status: "failed", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", branchId: 2, branchName: "S" }]],
  ])("is null for %s", (_label, results) => {
    expect(noticeForGroupResults(results as never)).toBeNull()
  })
})
