import { describe, expect, it } from "vitest"

import {
  getOrderTrackingActivity,
  getOrderTrackingSteps,
  getTrackingSummary,
  parseTrackingReference,
  stageTimesFromTrail,
  trackingReferenceOrderId,
} from "@/lib/order-tracking"

const states = (steps: ReturnType<typeof getOrderTrackingSteps>) => steps.map((step) => `${step.key}:${step.state}`)

describe("parseTrackingReference", () => {
  it("accepts an order id, a #-prefixed id and a transaction id", () => {
    expect(parseTrackingReference(" 2251 ")).toBe("2251")
    expect(parseTrackingReference("#2251")).toBe("2251")
    expect(parseTrackingReference("mgx4k2p1a9c3e7f0b5d8")).toBe("mgx4k2p1a9c3e7f0b5d8")
  })

  it("refuses empty, oversized and non-reference input", () => {
    expect(parseTrackingReference("")).toBeNull()
    expect(parseTrackingReference("   ")).toBeNull()
    expect(parseTrackingReference(null)).toBeNull()
    expect(parseTrackingReference("a".repeat(65))).toBeNull()
    expect(parseTrackingReference("1; DROP TABLE orders")).toBeNull()
    expect(parseTrackingReference("abc%")).toBeNull()
  })

  it("reads an order id only from a positive whole number in range", () => {
    expect(trackingReferenceOrderId("2251")).toBe(2251)
    expect(trackingReferenceOrderId("0")).toBeNull()
    expect(trackingReferenceOrderId("99999999999")).toBeNull()
    expect(trackingReferenceOrderId("mgx4k2")).toBeNull()
  })
})

describe("getOrderTrackingSteps", () => {
  it("shows a pending order as placed and awaiting approval", () => {
    const steps = getOrderTrackingSteps({ status: "PENDING", createdAt: "2026-10-01T05:00:00.000Z" })
    expect(states(steps)).toEqual([
      "placed:current", "approved:upcoming", "in_process:upcoming",
      "out_for_delivery:upcoming", "delivered:upcoming", "fulfilled:upcoming",
    ])
    expect(steps[0].at).toBe("2026-10-01T05:00:00.000Z")
    expect(steps[1].detail).toBe("Awaiting approval")
  })

  it("says a returned order is waiting on the requester, not the approver", () => {
    const steps = getOrderTrackingSteps({ status: "PENDING", returnedForCorrectionAt: "2026-10-02T05:00:00.000Z" })
    expect(steps[1].detail).toMatch(/Returned for correction/)
  })

  it("shows an approved order whose delivery has not started as approved, with In process not started", () => {
    const steps = getOrderTrackingSteps({ status: "APPROVED", fulfillmentStatus: "NOT_STARTED", approvedAt: "2026-10-02T05:00:00.000Z" })
    expect(states(steps).slice(0, 3)).toEqual(["placed:complete", "approved:current", "in_process:upcoming"])
    expect(steps[1].at).toBe("2026-10-02T05:00:00.000Z")
    expect(steps[2].detail).toMatch(/^Not started/)
  })

  it("dates each delivery stage from its own timestamp", () => {
    const steps = getOrderTrackingSteps({
      status: "APPROVED",
      fulfillmentStatus: "OUT_FOR_DELIVERY",
      approvedAt: "2026-10-02T05:00:00.000Z",
      inProcessAt: "2026-10-03T05:00:00.000Z",
      outForDeliveryAt: "2026-10-04T05:00:00.000Z",
    })
    expect(states(steps)).toEqual([
      "placed:complete", "approved:complete", "in_process:complete",
      "out_for_delivery:current", "delivered:upcoming", "fulfilled:upcoming",
    ])
    expect(steps[2].at).toBe("2026-10-03T05:00:00.000Z")
    expect(steps[3].at).toBe("2026-10-04T05:00:00.000Z")
    expect(steps[4].at).toBeNull()
  })

  it("waits on receipt confirmation once delivered", () => {
    const steps = getOrderTrackingSteps({ status: "APPROVED", fulfillmentStatus: "DELIVERED" })
    expect(steps[4].state).toBe("current")
    expect(steps[5]).toMatchObject({ state: "upcoming", detail: "Awaiting receipt confirmation" })
  })

  it("marks every step complete once fulfilled", () => {
    const steps = getOrderTrackingSteps({ status: "FULFILLED", fulfillmentStatus: "DELIVERED", fulfilledAt: "2026-10-06T05:00:00.000Z" })
    expect(steps.every((step) => step.state === "complete")).toBe(true)
    expect(steps.at(-1)?.at).toBe("2026-10-06T05:00:00.000Z")
  })

  it("ends a rejected order on a stop instead of showing delivery as upcoming", () => {
    const steps = getOrderTrackingSteps({ status: "REJECTED", rejectedAt: "2026-10-02T05:00:00.000Z" })
    expect(states(steps)).toEqual(["placed:complete", "rejected:stopped"])
    expect(steps[1].at).toBe("2026-10-02T05:00:00.000Z")
  })

  it("keeps the stages a cancelled order reached before it stopped", () => {
    const steps = getOrderTrackingSteps({ status: "CANCELLED", approvedAt: "2026-10-02T05:00:00.000Z", fulfillmentStatus: "NOT_STARTED" })
    expect(states(steps)).toEqual(["placed:complete", "approved:complete", "cancelled:stopped"])
  })

  it("shows a refunded, fulfilled order's whole journey and then the refund", () => {
    const steps = getOrderTrackingSteps({
      status: "REFUNDED",
      fulfillmentStatus: "DELIVERED",
      approvedAt: "2026-10-02T05:00:00.000Z",
      fulfilledAt: "2026-10-06T05:00:00.000Z",
      refundedAt: "2026-10-07T05:00:00.000Z",
    })
    expect(states(steps)).toEqual([
      "placed:complete", "approved:complete", "in_process:complete", "out_for_delivery:complete",
      "delivered:complete", "fulfilled:complete", "refunded:stopped",
    ])
  })
})

describe("getTrackingSummary", () => {
  it("reports a paid, fulfilled order on all three cards", () => {
    const summary = getTrackingSummary({ status: "FULFILLED", fulfillmentStatus: "DELIVERED", paymentStatus: "PAID", paidAt: "2026-10-08T05:00:00.000Z" })
    expect(summary.order).toMatchObject({ label: "Fulfilled", tone: "success" })
    expect(summary.payment).toMatchObject({ label: "Paid", tone: "success", at: "2026-10-08T05:00:00.000Z" })
    expect(summary.delivery).toMatchObject({ label: "Delivered", tone: "success" })
    expect(summary.stopped).toBe(false)
  })

  it("shows every delivery stage, with Not started current on a fresh approval", () => {
    const summary = getTrackingSummary({ status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
    expect(summary.delivery.label).toBe("Not Started")
    expect(summary.delivery.stages.map((stage) => [stage.label, stage.reached, stage.current])).toEqual([
      ["Not Started", true, true],
      ["In Process", false, false],
      ["Out for Delivery", false, false],
      ["Delivered", false, false],
    ])
  })

  it("shows payment as Unpaid → Paid and treats an unknown value as unpaid", () => {
    const summary = getTrackingSummary({ status: "APPROVED", paymentStatus: "garbage" })
    expect(summary.payment.label).toBe("Unpaid")
    expect(summary.payment.stages.map((stage) => [stage.key, stage.reached, stage.current])).toEqual([
      ["UNPAID", true, true],
      ["PAID", false, false],
    ])
  })

  it("does not describe a rejected order as a delivery or a payment in progress", () => {
    const summary = getTrackingSummary({ status: "REJECTED" })
    expect(summary.order).toMatchObject({ label: "Rejected", tone: "danger" })
    expect(summary.payment.label).toBe("Not applicable")
    expect(summary.delivery.label).toBe("Not proceeding")
    expect(summary.delivery.stages.some((stage) => stage.reached)).toBe(false)
    expect(summary.payment.stages.some((stage) => stage.reached || stage.current)).toBe(false)
    expect(summary.order.stages.map((stage) => stage.label)).toEqual(["Pending", "Rejected"])
    expect(summary.stopped).toBe(true)
  })

  it("names a returned order as returned for correction", () => {
    expect(getTrackingSummary({ status: "PENDING", returnedForCorrectionAt: "2026-10-02T05:00:00.000Z" }).order.label)
      .toBe("Returned for correction")
  })
})

describe("getOrderTrackingActivity", () => {
  it("lists recorded events newest first and skips the ones that never happened", () => {
    const activity = getOrderTrackingActivity({
      status: "FULFILLED",
      paymentStatus: "PAID",
      createdAt: "2026-10-01T05:00:00.000Z",
      approvedAt: "2026-10-02T05:00:00.000Z",
      inProcessAt: "2026-10-03T05:00:00.000Z",
      deliveredAt: "2026-10-05T05:00:00.000Z",
      fulfilledAt: "2026-10-06T05:00:00.000Z",
      paidAt: "2026-10-07T05:00:00.000Z",
    }, [{ status: "APPROVED", createdAt: "2026-10-08T05:00:00.000Z", updatedAt: "2026-10-09T05:00:00.000Z" }])
    expect(activity.map((event) => event.key)).toEqual([
      "refund-0-approved", "refund-0-requested", "paid", "fulfilled", "delivered", "in_process", "approved", "placed",
    ])
  })

  it("does not claim a payment on an unpaid order even if a stale paid time is present", () => {
    const activity = getOrderTrackingActivity({ status: "APPROVED", paymentStatus: "UNPAID", paidAt: "2026-10-07T05:00:00.000Z" })
    expect(activity.some((event) => event.key === "paid")).toBe(false)
  })
})

describe("stageTimesFromTrail", () => {
  it("takes the latest entry into each stage and drops stages past the current one", () => {
    const times = stageTimesFromTrail([
      { to: "IN_PROCESS", at: "2026-10-03T05:00:00.000Z" },
      { to: "OUT_FOR_DELIVERY", at: "2026-10-04T05:00:00.000Z" },
      { to: "IN_PROCESS", at: "2026-10-05T05:00:00.000Z" },
      { to: "DELIVERED", at: "2026-10-06T05:00:00.000Z" },
      { to: "bogus", at: "2026-10-06T05:00:00.000Z" },
      { to: null, at: "2026-10-06T05:00:00.000Z" },
    ], "OUT_FOR_DELIVERY")
    expect(times).toEqual({
      IN_PROCESS: "2026-10-05T05:00:00.000Z",
      OUT_FOR_DELIVERY: "2026-10-04T05:00:00.000Z",
    })
  })
})
