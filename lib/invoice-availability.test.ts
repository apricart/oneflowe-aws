import { describe, expect, it } from "vitest"
import { isInvoiceAvailableForOrder } from "./invoice-availability"

describe("invoice availability", () => {
  it("keeps invoices hidden before approval", () => {
    expect(isInvoiceAvailableForOrder({ status: "PENDING" })).toBe(false)
    expect(isInvoiceAvailableForOrder({ status: "REJECTED" })).toBe(false)
    expect(isInvoiceAvailableForOrder({ status: "CANCELLED" })).toBe(false)
  })

  it("makes invoices available at approval and during later fulfillment states", () => {
    expect(isInvoiceAvailableForOrder({ status: "approved" })).toBe(true)
    expect(isInvoiceAvailableForOrder({ status: "FULFILLED" })).toBe(true)
    expect(isInvoiceAvailableForOrder({ status: "PARTIAL" })).toBe(true)
    expect(isInvoiceAvailableForOrder({ status: "PARTIALLY_FULFILLED" })).toBe(true)
  })

  it("only allows refunded invoices when the refund followed approval", () => {
    expect(isInvoiceAvailableForOrder({
      status: "REFUNDED",
      statusAtRefund: "APPROVED",
    })).toBe(true)
    expect(isInvoiceAvailableForOrder({
      status: "REFUNDED",
      statusAtRefund: "FULFILLED",
    })).toBe(true)
    expect(isInvoiceAvailableForOrder({
      status: "REFUNDED",
      statusAtRefund: "PENDING",
    })).toBe(false)
    expect(isInvoiceAvailableForOrder({ status: "REFUNDED" })).toBe(false)
  })
})
