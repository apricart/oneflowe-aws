import { describe, expect, it } from "vitest"
import {
  getOrderStatusDisplay,
  shouldShowOrderFulfillmentStatus,
  shouldShowOrderPaymentStatus,
} from "@/lib/order-status-display"

describe("order status display", () => {
  it("returns every badge shown for a delivered, unpaid, partially refunded order", () => {
    const display = getOrderStatusDisplay({
      status: "FULFILLED",
      fulfillmentStatus: "DELIVERED",
      paymentStatus: "UNPAID",
      refundAmountCents: 25_000,
    })

    expect(display).toEqual({
      orderStatus: { key: "fulfilled", label: "Fulfilled" },
      fulfillmentStatus: "Delivered",
      paymentStatus: "Unpaid",
      refundStatus: "Partial Refund",
    })
  })

  it("uses the same normalized labels as the order table", () => {
    expect(getOrderStatusDisplay({
      status: " approved ",
      fulfillmentStatus: "in_process",
      paymentStatus: "paid",
    })).toEqual({
      orderStatus: { key: "approved", label: "Active" },
      fulfillmentStatus: "In Process",
      paymentStatus: "Paid",
      refundStatus: null,
    })
  })

  it("does not export secondary badges that the table intentionally hides", () => {
    const rejected = {
      status: "REJECTED",
      fulfillmentStatus: "DELIVERED",
      paymentStatus: "PAID",
    }

    expect(shouldShowOrderFulfillmentStatus(rejected)).toBe(false)
    expect(shouldShowOrderPaymentStatus(rejected)).toBe(false)
    expect(getOrderStatusDisplay(rejected)).toEqual({
      orderStatus: { key: "rejected", label: "Rejected" },
      fulfillmentStatus: null,
      paymentStatus: null,
      refundStatus: null,
    })
  })

  it("identifies a full refund independently from a partial refund amount", () => {
    expect(getOrderStatusDisplay({
      status: "REFUNDED",
      paymentStatus: "PAID",
      refundAmountCents: 50_000,
    })).toEqual({
      orderStatus: { key: "refunded", label: "Refunded" },
      fulfillmentStatus: null,
      paymentStatus: "Paid",
      refundStatus: "Full Refund",
    })
  })
})
