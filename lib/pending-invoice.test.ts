import { describe, expect, it } from "vitest"

import { isPendingInvoiceOrder, parsePendingInvoiceStatus } from "./pending-invoice"

describe("pending invoice", () => {
  it.each([
    ["delivered, not yet fulfilled", { status: "APPROVED", fulfillmentStatus: "DELIVERED" }],
    ["fulfilled", { status: "fulfilled", fulfillmentStatus: "DELIVERED" }],
    ["legacy partial", { status: "PARTIAL" }],
    ["partially fulfilled", { status: "PARTIALLY_FULFILLED" }],
    ["partly credited", { status: "FULFILLED", fulfillmentStatus: "DELIVERED", refundAmountCents: 500 }],
  ])("recognizes an unpaid tax invoice: %s", (_, order) => {
    expect(isPendingInvoiceOrder({
      ...order,
      paymentStatus: "unpaid",
      receiptData: { invoiceNumber: "INV-1" },
    })).toBe(true)
  })

  it.each([
    ["pending", { status: "PENDING" }],
    ["rejected", { status: "REJECTED" }],
    ["cancelled", { status: "CANCELLED" }],
    ["fully credited", { status: "REFUNDED", statusAtRefund: "FULFILLED", fulfillmentStatus: "DELIVERED" }],
    // Only a proforma exists until delivery: nothing is owed on it yet.
    ["approved, not delivered", { status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" }],
  ])("does not call a %s order a pending invoice", (_, order) => {
    expect(isPendingInvoiceOrder({
      ...order,
      paymentStatus: "UNPAID",
      receiptData: { invoiceNumber: "INV-1" },
    })).toBe(false)
  })

  it("requires both an invoice snapshot and an unpaid payment state", () => {
    expect(isPendingInvoiceOrder({ status: "FULFILLED", paymentStatus: "PAID", receiptData: {} })).toBe(false)
    expect(isPendingInvoiceOrder({ status: "FULFILLED", paymentStatus: "UNPAID", receiptData: null })).toBe(false)
  })

  it("accepts only a complete status response", () => {
    expect(parsePendingInvoiceStatus({ hasPendingInvoice: false, pendingInvoice: null })).toEqual({
      hasPendingInvoice: false,
      pendingInvoice: null,
    })
    expect(parsePendingInvoiceStatus({
      hasPendingInvoice: true,
      pendingInvoice: { orderId: 4, invoiceNumber: "INV-4", orderReference: "TID-4" },
    })).toEqual({
      hasPendingInvoice: true,
      pendingInvoice: { orderId: 4, invoiceNumber: "INV-4", orderReference: "TID-4" },
    })
    expect(parsePendingInvoiceStatus({ hasPendingInvoice: true, pendingInvoice: null })).toBeNull()
    expect(parsePendingInvoiceStatus({ hasPendingInvoice: "yes", pendingInvoice: null })).toBeNull()
  })
})
