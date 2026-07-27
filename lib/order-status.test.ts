import { describe, expect, it } from "vitest"
import {
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
})
