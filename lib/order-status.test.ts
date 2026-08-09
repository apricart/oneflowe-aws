import { describe, expect, it } from "vitest"
import {
  getPendingOrderReviewHref,
  getOrderStatusesForFilter,
  getOrderStatusFilter,
  ORDER_STATUS_FILTERS,
  PENDING_ORDERS_REVIEW_HREF,
} from "@/lib/order-status"

describe("order status navigation", () => {
  it.each(ORDER_STATUS_FILTERS)("accepts the allowlisted %s filter", (status) => {
    expect(getOrderStatusFilter(status)).toBe(status)
    expect(getOrderStatusFilter(status.toUpperCase())).toBe(status)
    expect(getOrderStatusFilter(` ${status} `)).toBe(status)
  })

  it.each([
    null,
    undefined,
    "",
    "unknown",
    "pending&organizationId=999",
    "../organizations",
  ])("falls back to all for an invalid status filter: %s", (status) => {
    expect(getOrderStatusFilter(status)).toBe("all")
  })

  it("uses a tenant-neutral canonical URL for pending-order review", () => {
    const url = new URL(PENDING_ORDERS_REVIEW_HREF, "https://oneflowe.test")

    expect(url.pathname).toBe("/orders")
    expect(url.searchParams.get("status")).toBe("pending")
    expect(url.searchParams.get("organizationId")).toBeNull()
    expect(url.searchParams.get("branchId")).toBeNull()
    expect(url.searchParams.get("branchIds")).toBeNull()
  })

  it("maps UI filters to every database status represented by each tab", () => {
    expect(getOrderStatusesForFilter("all")).toEqual([])
    expect(getOrderStatusesForFilter("pending")).toEqual(["PENDING"])
    expect(getOrderStatusesForFilter("approved")).toEqual(["APPROVED"])
    expect(getOrderStatusesForFilter("fulfilled")).toEqual([
      "FULFILLED",
      "PARTIAL",
      "PARTIALLY_FULFILLED",
    ])
    expect(getOrderStatusesForFilter("rejected")).toEqual(["REJECTED", "CANCELLED"])
    expect(getOrderStatusesForFilter("refunded")).toEqual(["REFUNDED"])
  })

  it("deep-links a single pending-order notification to that order", () => {
    expect(getPendingOrderReviewHref(42, 1)).toBe("/orders/42")
  })

  it.each([
    { orderId: 42, count: 2 },
    { orderId: null, count: 1 },
    { orderId: 0, count: 1 },
    { orderId: -1, count: 1 },
    { orderId: 1.5, count: 1 },
  ])("falls back to the pending list when a specific order is unavailable: $orderId/$count", ({ orderId, count }) => {
    expect(getPendingOrderReviewHref(orderId, count)).toBe(PENDING_ORDERS_REVIEW_HREF)
  })
})
