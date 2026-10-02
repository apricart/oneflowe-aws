import { describe, expect, it } from "vitest"

import {
  UNACKNOWLEDGED_ORDERS_SOURCE_URL,
  canSendTokenFromTab,
  orderRowFulfilmentAction,
  parseOrderDeliveryFilter,
  selectUnacknowledgedOrders,
} from "@/lib/unacknowledged-orders"
import { isUnacknowledgedDelivery } from "@/lib/unacknowledged-delivery-block"

const order = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "APPROVED",
  fulfillmentStatus: "DELIVERED",
  deliveredAt: null as string | null,
  createdAt: "2026-09-01T10:00:00.000Z",
  approvalToken: `TOKEN-${id}`,
  ...overrides,
})

describe("selectUnacknowledgedOrders", () => {
  it("lists only approved orders whose goods have been delivered", () => {
    const listed = selectUnacknowledgedOrders([
      order(1),
      order(2, { fulfillmentStatus: "DISPATCHED" }),
      order(3, { status: "FULFILLED" }),
      order(4, { status: "PENDING", fulfillmentStatus: null }),
      order(5, { status: "approved", fulfillmentStatus: "delivered" }),
    ])
    expect(listed.map((row) => row.id)).toEqual([1, 5])
  })

  it("uses the same rule as the ordering block", () => {
    const rows = [
      order(1),
      order(2, { fulfillmentStatus: "PENDING" }),
      order(3, { status: "REFUNDED" }),
      order(4, { status: "REJECTED", fulfillmentStatus: "DELIVERED" }),
    ]
    expect(selectUnacknowledgedOrders(rows).map((row) => row.id))
      .toEqual(rows.filter(isUnacknowledgedDelivery).map((row) => row.id))
  })

  it("puts the longest-waiting delivery first, undated deliveries last", () => {
    const listed = selectUnacknowledgedOrders([
      order(1, { deliveredAt: null, createdAt: "2026-08-01T00:00:00.000Z" }),
      order(2, { deliveredAt: "2026-09-20T00:00:00.000Z" }),
      order(3, { deliveredAt: "2026-09-10T00:00:00.000Z" }),
    ])
    expect(listed.map((row) => row.id)).toEqual([3, 2, 1])
  })

  it("breaks ties by when the order was raised, then by id", () => {
    const deliveredAt = "2026-09-10T00:00:00.000Z"
    const listed = selectUnacknowledgedOrders([
      order(9, { deliveredAt, createdAt: "2026-09-02T00:00:00.000Z" }),
      order(8, { deliveredAt, createdAt: "2026-09-02T00:00:00.000Z" }),
      order(7, { deliveredAt, createdAt: "2026-09-01T00:00:00.000Z" }),
    ])
    expect(listed.map((row) => row.id)).toEqual([7, 8, 9])
  })

  it("does not reorder the list it was given", () => {
    const rows = [order(2, { deliveredAt: "2026-09-20T00:00:00.000Z" }), order(1, { deliveredAt: "2026-09-10T00:00:00.000Z" })]
    selectUnacknowledgedOrders(rows)
    expect(rows.map((row) => row.id)).toEqual([2, 1])
  })

  it("answers an empty list for a missing or malformed payload", () => {
    expect(selectUnacknowledgedOrders(undefined)).toEqual([])
    expect(selectUnacknowledgedOrders(null)).toEqual([])
    expect(selectUnacknowledgedOrders([])).toEqual([])
  })
})

describe("canSendTokenFromTab", () => {
  it("is true only when the list handed this viewer the token", () => {
    expect(canSendTokenFromTab(order(1))).toBe(true)
    expect(canSendTokenFromTab(order(1, { approvalToken: null }))).toBe(false)
    expect(canSendTokenFromTab(order(1, { approvalToken: "   " }))).toBe(false)
    expect(canSendTokenFromTab(order(1, { approvalToken: undefined }))).toBe(false)
  })
})

describe("UNACKNOWLEDGED_ORDERS_SOURCE_URL", () => {
  it("asks for approved orders only, at the list's maximum page", () => {
    const params = new URL(UNACKNOWLEDGED_ORDERS_SOURCE_URL, "http://localhost").searchParams
    expect(params.get("status")).toBe("approved")
    expect(params.get("limit")).toBe("500")
  })
})

describe("parseOrderDeliveryFilter", () => {
  it("means no narrowing when absent or blank", () => {
    expect(parseOrderDeliveryFilter(null)).toEqual({ ok: true, filter: null })
    expect(parseOrderDeliveryFilter(undefined)).toEqual({ ok: true, filter: null })
    expect(parseOrderDeliveryFilter("  ")).toEqual({ ok: true, filter: null })
  })

  it("accepts the one allowlisted value, case-insensitively", () => {
    expect(parseOrderDeliveryFilter("unacknowledged")).toEqual({ ok: true, filter: "unacknowledged" })
    expect(parseOrderDeliveryFilter(" Unacknowledged ")).toEqual({ ok: true, filter: "unacknowledged" })
  })

  it("refuses anything else instead of silently widening the list", () => {
    expect(parseOrderDeliveryFilter("delivered").ok).toBe(false)
    expect(parseOrderDeliveryFilter("unacknowledged' OR 1=1").ok).toBe(false)
  })
})

describe("orderRowFulfilmentAction", () => {
  const active = { status: "APPROVED", approvalToken: "ABCD1234" }

  it("lets Super Admin fulfil an active order with its token", () => {
    expect(orderRowFulfilmentAction({ ...active, canFulfilWithToken: true })).toBe("fulfil-with-token")
  })

  it("lets an approver who was handed the token send it", () => {
    expect(orderRowFulfilmentAction({ ...active, canFulfilWithToken: false })).toBe("send-token")
  })

  it("offers nothing without a token the server returned", () => {
    expect(orderRowFulfilmentAction({ status: "APPROVED", approvalToken: null, canFulfilWithToken: true })).toBeNull()
    expect(orderRowFulfilmentAction({ status: "APPROVED", approvalToken: null, canFulfilWithToken: false })).toBeNull()
  })

  it("offers nothing for an order that is not active", () => {
    for (const status of ["PENDING", "FULFILLED", "REJECTED", "REFUNDED", "PARTIALLY_FULFILLED", null]) {
      expect(orderRowFulfilmentAction({ status, approvalToken: "ABCD1234", canFulfilWithToken: true })).toBeNull()
    }
  })

  it("reads the status case-insensitively", () => {
    expect(orderRowFulfilmentAction({ status: "approved", approvalToken: "ABCD1234", canFulfilWithToken: false })).toBe("send-token")
  })
})
