import { describe, expect, it } from "vitest"

import {
  deriveInvoiceStatus,
  describeInvoiceStatus,
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  invoiceDocumentTitle,
  isOrderSupplied,
  isTaxInvoiceStatus,
  parseInvoiceStatusFilter,
  toInvoiceStatus,
  type InvoiceStatus,
  type InvoiceStatusSource,
} from "./invoice-status"

describe("deriveInvoiceStatus — the requester's table", () => {
  it.each<[string, InvoiceStatusSource, InvoiceStatus]>([
    ["pending", { status: "PENDING" }, "NOT_ISSUED"],
    ["approved, not delivered", { status: "APPROVED", fulfillmentStatus: "IN_PROCESS" }, "PROFORMA_AVAILABLE"],
    ["approved and delivered", { status: "APPROVED", fulfillmentStatus: "DELIVERED" }, "ISSUED"],
    ["fulfilled", { status: "FULFILLED", fulfillmentStatus: "DELIVERED" }, "ISSUED"],
    ["refunded partially", { status: "FULFILLED", fulfillmentStatus: "DELIVERED", refundAmountCents: 500 }, "PARTIALLY_CREDITED"],
    ["refunded fully", { status: "REFUNDED", fulfillmentStatus: "DELIVERED", statusAtRefund: "FULFILLED", refundAmountCents: 9_000 }, "CREDITED"],
  ])("%s", (_, order, expected) => {
    expect(deriveInvoiceStatus(order)).toBe(expected)
  })
})

describe("deriveInvoiceStatus — the cases the table leaves open", () => {
  it("a rejected order never had an invoice", () => {
    expect(deriveInvoiceStatus({ status: "REJECTED" })).toBe("NOT_ISSUED")
  })

  it("an order cancelled after approval is cancelled, not 'not issued'", () => {
    expect(deriveInvoiceStatus({ status: "CANCELLED", fulfillmentStatus: "IN_PROCESS" })).toBe("CANCELLED")
  })

  it("a full refund before delivery cancels the proforma rather than crediting an invoice", () => {
    expect(deriveInvoiceStatus({ status: "REFUNDED", statusAtRefund: "APPROVED", fulfillmentStatus: "NOT_STARTED", refundAmountCents: 100 }))
      .toBe("CANCELLED")
  })

  it("a partial refund before delivery leaves a proforma", () => {
    expect(deriveInvoiceStatus({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY", refundAmountCents: 100 }))
      .toBe("PROFORMA_AVAILABLE")
  })

  it("a full refund of a delivered order that was still approved is a credit", () => {
    expect(deriveInvoiceStatus({ status: "REFUNDED", statusAtRefund: "APPROVED", fulfillmentStatus: "DELIVERED" }))
      .toBe("CREDITED")
  })

  it("a refund recorded against a fulfilled order counts as supplied even without a delivery status", () => {
    expect(deriveInvoiceStatus({ status: "REFUNDED", statusAtRefund: "FULFILLED", fulfillmentStatus: null }))
      .toBe("CREDITED")
  })

  it("legacy partial-fulfilment statuses are supplied", () => {
    expect(deriveInvoiceStatus({ status: "PARTIAL" })).toBe("ISSUED")
    expect(deriveInvoiceStatus({ status: "PARTIALLY_FULFILLED", refundAmountCents: "250" })).toBe("PARTIALLY_CREDITED")
  })

  it("an order returned for correction is still pending underneath", () => {
    expect(deriveInvoiceStatus({ status: "PENDING", fulfillmentStatus: "NOT_STARTED" })).toBe("NOT_ISSUED")
  })

  it("reads stored values case- and space-insensitively", () => {
    expect(deriveInvoiceStatus({ status: " approved ", fulfillmentStatus: "delivered" })).toBe("ISSUED")
  })

  it("an unknown or missing status issues nothing", () => {
    expect(deriveInvoiceStatus({ status: "SOMETHING_ELSE" })).toBe("NOT_ISSUED")
    expect(deriveInvoiceStatus({})).toBe("NOT_ISSUED")
  })

  it("a zero or absent refund is not a credit", () => {
    expect(deriveInvoiceStatus({ status: "FULFILLED", refundAmountCents: 0 })).toBe("ISSUED")
    expect(deriveInvoiceStatus({ status: "FULFILLED", refundAmountCents: null })).toBe("ISSUED")
  })
})

describe("isOrderSupplied", () => {
  it("is true for delivery alone, for a fulfilled status, or for a refund taken from one", () => {
    expect(isOrderSupplied({ status: "APPROVED", fulfillmentStatus: "DELIVERED" })).toBe(true)
    expect(isOrderSupplied({ status: "FULFILLED" })).toBe(true)
    expect(isOrderSupplied({ status: "REFUNDED", statusAtRefund: "PARTIALLY_FULFILLED" })).toBe(true)
    expect(isOrderSupplied({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })).toBe(false)
  })
})

describe("document title", () => {
  it("only an issued invoice — credited or not — is titled INVOICE", () => {
    const titles = Object.fromEntries(INVOICE_STATUSES.map((status) => [status, invoiceDocumentTitle(status)]))
    expect(titles).toEqual({
      NOT_ISSUED: "PROFORMA INVOICE",
      PROFORMA_AVAILABLE: "PROFORMA INVOICE",
      ISSUED: "INVOICE",
      PARTIALLY_CREDITED: "INVOICE",
      CREDITED: "INVOICE",
      CANCELLED: "PROFORMA INVOICE",
    })
    expect(INVOICE_STATUSES.filter(isTaxInvoiceStatus)).toEqual(["ISSUED", "PARTIALLY_CREDITED", "CREDITED"])
  })
})

describe("describeInvoiceStatus", () => {
  it("adds the status, its label and the title", () => {
    expect(describeInvoiceStatus({ status: "FULFILLED" }).fields).toEqual({
      invoiceStatus: "ISSUED",
      invoiceStatusLabel: "Issued",
      documentTitle: "INVOICE",
    })
  })

  it("prints the customer's STRN on a proforma", () => {
    expect(describeInvoiceStatus({ status: "APPROVED" }, " 3277876 ").fields).toEqual({
      invoiceStatus: "PROFORMA_AVAILABLE",
      invoiceStatusLabel: "Proforma available",
      documentTitle: "PROFORMA INVOICE",
      organizationStrn: "3277876",
    })
  })

  it("leaves an issued invoice as it was printed before the STRN existed", () => {
    expect(describeInvoiceStatus({ status: "FULFILLED", refundAmountCents: 10 }, "3277876").fields)
      .not.toHaveProperty("organizationStrn")
  })

  it("omits a blank STRN", () => {
    expect(describeInvoiceStatus({ status: "APPROVED" }, "  ").fields).not.toHaveProperty("organizationStrn")
    expect(describeInvoiceStatus({ status: "APPROVED" }, null).fields).not.toHaveProperty("organizationStrn")
  })
})

describe("parseInvoiceStatusFilter", () => {
  it("treats absent and blank as no filter", () => {
    expect(parseInvoiceStatusFilter(null)).toEqual({ ok: true, filter: null })
    expect(parseInvoiceStatusFilter("  ")).toEqual({ ok: true, filter: null })
  })

  it("accepts every status in any case", () => {
    for (const status of INVOICE_STATUSES) {
      expect(parseInvoiceStatusFilter(status.toLowerCase())).toEqual({ ok: true, filter: status })
    }
  })

  it("refuses anything else instead of widening the list", () => {
    const parsed = parseInvoiceStatusFilter("PAID")
    expect(parsed.ok).toBe(false)
  })
})

describe("labels and coercion", () => {
  it("labels every status", () => {
    for (const status of INVOICE_STATUSES) expect(INVOICE_STATUS_LABELS[status]).toBeTruthy()
  })

  it("coerces only known values", () => {
    expect(toInvoiceStatus("issued")).toBe("ISSUED")
    expect(toInvoiceStatus("nope")).toBeNull()
    expect(toInvoiceStatus(null)).toBeNull()
  })
})
