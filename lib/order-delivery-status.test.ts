import { describe, expect, it } from "vitest"
import {
  VIEWER_STATUS_BUCKETS,
  countViewerStatusBuckets,
  getViewerStatusBucket,
  isDelivered,
  isFulfilledStatus,
  matchesViewerStatusBucket,
  type OrderDeliverySource,
} from "@/lib/order-delivery-status"

const order = (status: string, fulfillmentStatus?: string | null): OrderDeliverySource => ({
  status,
  fulfillmentStatus: fulfillmentStatus ?? null,
})

describe("matchesViewerStatusBucket", () => {
  it("puts a pending order in Pending Approval and nowhere else", () => {
    const pending = order("PENDING")
    expect(matchesViewerStatusBucket("PENDING", pending)).toBe(true)
    expect(matchesViewerStatusBucket("APPROVED", pending)).toBe(false)
    expect(matchesViewerStatusBucket("UNFULFILLED", pending)).toBe(false)
    expect(matchesViewerStatusBucket("FULFILLED", pending)).toBe(false)
  })

  it("counts an approved, undelivered order as Active and Unfulfilled", () => {
    const active = order("APPROVED", "IN_PROCESS")
    expect(matchesViewerStatusBucket("APPROVED", active)).toBe(true)
    expect(matchesViewerStatusBucket("UNFULFILLED", active)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED", active)).toBe(false)
    expect(matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", active)).toBe(false)
  })

  it("counts an approved, delivered order as Active, Delivered and pending acknowledgment", () => {
    const arrived = order("APPROVED", "DELIVERED")
    expect(matchesViewerStatusBucket("APPROVED", arrived)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED", arrived)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", arrived)).toBe(true)
    expect(matchesViewerStatusBucket("UNFULFILLED", arrived)).toBe(false)
  })

  it("counts a fulfilled, delivered order as Delivered but never as pending acknowledgment", () => {
    const settled = order("FULFILLED", "DELIVERED")
    expect(matchesViewerStatusBucket("FULFILLED", settled)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED", settled)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", settled)).toBe(false)
    expect(matchesViewerStatusBucket("APPROVED", settled)).toBe(false)
  })

  it("treats partial fulfilment as fulfilled, under either spelling", () => {
    expect(isFulfilledStatus("PARTIAL")).toBe(true)
    expect(isFulfilledStatus("PARTIALLY_FULFILLED")).toBe(true)
    expect(matchesViewerStatusBucket("FULFILLED", order("PARTIAL", "DELIVERED"))).toBe(true)
    expect(matchesViewerStatusBucket("FULFILLED", order("PARTIALLY_FULFILLED"))).toBe(true)
  })

  it("leaves rejected, cancelled and refunded orders out of every bucket", () => {
    for (const status of ["REJECTED", "CANCELLED", "REFUNDED"]) {
      const counts = countViewerStatusBuckets([order(status, "NOT_STARTED")])
      expect(Object.values(counts).every((count) => count === 0)).toBe(true)
    }
  })

  it("reads a missing or unknown fulfilment status as not delivered", () => {
    expect(isDelivered(order("APPROVED", null))).toBe(false)
    expect(isDelivered(order("APPROVED", "SOMETHING_ELSE"))).toBe(false)
    expect(matchesViewerStatusBucket("UNFULFILLED", order("APPROVED", null))).toBe(true)
  })

  it("normalises case and surrounding whitespace on both columns", () => {
    const messy = order("  approved ", " delivered ")
    expect(matchesViewerStatusBucket("APPROVED", messy)).toBe(true)
    expect(matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", messy)).toBe(true)
  })
})

describe("the Active partition", () => {
  it("splits Active exactly into pending-acknowledgment and unfulfilled", () => {
    const orders = [
      order("PENDING"),
      order("APPROVED", "NOT_STARTED"),
      order("APPROVED", "IN_PROCESS"),
      order("APPROVED", "OUT_FOR_DELIVERY"),
      order("APPROVED", "DELIVERED"),
      order("APPROVED", "DELIVERED"),
      order("FULFILLED", "DELIVERED"),
      order("PARTIAL", "DELIVERED"),
      order("REJECTED"),
    ]

    const counts = countViewerStatusBuckets(orders)

    expect(counts.PENDING).toBe(1)
    expect(counts.APPROVED).toBe(5)
    expect(counts.DELIVERED_UNACKNOWLEDGED).toBe(2)
    expect(counts.UNFULFILLED).toBe(3)
    expect(counts.DELIVERED).toBe(4)
    expect(counts.FULFILLED).toBe(2)

    // The identity the panel is built on.
    expect(counts.DELIVERED_UNACKNOWLEDGED + counts.UNFULFILLED).toBe(counts.APPROVED)
  })
})

describe("VIEWER_STATUS_BUCKETS", () => {
  it("carries all six buckets exactly once", () => {
    const keys = VIEWER_STATUS_BUCKETS.map((bucket) => bucket.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(6)
  })

  it("gives every bucket a distinct drill-down type and count field", () => {
    const types = VIEWER_STATUS_BUCKETS.map((bucket) => bucket.drillDownType)
    const fields = VIEWER_STATUS_BUCKETS.map((bucket) => bucket.countField)
    expect(new Set(types).size).toBe(types.length)
    expect(new Set(fields).size).toBe(fields.length)
  })

  it("resolves a bucket by key and refuses an unknown one", () => {
    expect(getViewerStatusBucket("FULFILLED").label).toBe("Fulfilled")
    expect(() => getViewerStatusBucket("NOPE" as never)).toThrow(/Unknown viewer status bucket/)
  })
})
