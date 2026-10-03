import { describe, expect, it } from "vitest"

import {
  FULFILLMENT_STATUSES,
  isOrderDelivered,
  parseFulfillmentStatusFilter,
} from "@/lib/fulfillment-status"

describe("fulfillment status filters", () => {
  it("accepts every supported delivery status case-insensitively", () => {
    for (const status of FULFILLMENT_STATUSES) {
      expect(parseFulfillmentStatusFilter(status.toLowerCase())).toEqual({
        ok: true,
        filter: status,
      })
    }
  })

  it("treats an absent value as no delivery-status filter", () => {
    expect(parseFulfillmentStatusFilter(null)).toEqual({ ok: true, filter: null })
    expect(parseFulfillmentStatusFilter("  ")).toEqual({ ok: true, filter: null })
  })

  it("rejects unknown values instead of widening the order query", () => {
    const parsed = parseFulfillmentStatusFilter("on_the_way")

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain("fulfillmentStatus must be one of")
  })
})

describe("isOrderDelivered", () => {
  it("is true only once the goods have been delivered", () => {
    expect(isOrderDelivered("DELIVERED")).toBe(true)
    expect(isOrderDelivered(" delivered ")).toBe(true)
  })

  it("is false for every earlier stage, a missing value and an unknown one", () => {
    for (const status of ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY", null, undefined, "", "SHIPPED"]) {
      expect(isOrderDelivered(status)).toBe(false)
    }
  })
})
