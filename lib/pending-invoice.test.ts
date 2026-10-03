import { describe, expect, it } from "vitest"

import { isPendingInvoiceOrder, parsePendingInvoiceStatus } from "./pending-invoice"

describe("pending invoice", () => {
  it.each(["APPROVED", "fulfilled", "PARTIAL", "PARTIALLY_FULFILLED"])(
    "recognizes an unpaid invoice in %s",
    (status) => {
      expect(isPendingInvoiceOrder({
        status,
        paymentStatus: "unpaid",
        receiptData: { invoiceNumber: "INV-1" },
      })).toBe(true)
    },
  )

  it.each(["PENDING", "REJECTED", "CANCELLED", "REFUNDED"])(
    "does not call a %s order a pending invoice",
    (status) => {
      expect(isPendingInvoiceOrder({
        status,
        paymentStatus: "UNPAID",
        receiptData: { invoiceNumber: "INV-1" },
      })).toBe(false)
    },
  )

  it("requires both an invoice snapshot and an unpaid payment state", () => {
    expect(isPendingInvoiceOrder({ status: "APPROVED", paymentStatus: "PAID", receiptData: {} })).toBe(false)
    expect(isPendingInvoiceOrder({ status: "APPROVED", paymentStatus: "UNPAID", receiptData: null })).toBe(false)
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
