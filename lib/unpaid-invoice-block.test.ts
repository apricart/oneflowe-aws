import { describe, expect, it } from "vitest"

import { isPaymentStatusUpdateEligible } from "@/lib/business-rules"
import { PaymentControlBlockedError, resolvePaymentControl } from "@/lib/payment-control-policy"
import {
  blockedBranchesOf,
  isUnpaidInvoiceOrder,
  noticeForBlock,
  noticeForBlockedBranches,
  orderingBlockFromStatusView,
  parseOrderingBlockedResponse,
  unpaidInvoiceCountLabel,
} from "@/lib/unpaid-invoice-block"

const unpaid = {
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  paymentStatus: "UNPAID",
  receiptData: { invoiceNumber: "INV-1" },
}

describe("isUnpaidInvoiceOrder", () => {
  it("counts a fulfilled, delivered, invoiced order still marked unpaid", () => {
    expect(isUnpaidInvoiceOrder(unpaid)).toBe(true)
  })

  it("does not count a paid invoice", () => {
    expect(isUnpaidInvoiceOrder({ ...unpaid, paymentStatus: "PAID" })).toBe(false)
  })

  it.each(["PENDING", "APPROVED", "REJECTED", "REFUNDED", "PARTIAL", "PARTIALLY_FULFILLED"])(
    "does not count an order in %s — only FULFILLED can be marked paid",
    (status) => {
      expect(isUnpaidInvoiceOrder({ ...unpaid, status })).toBe(false)
    },
  )

  it.each(["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY"])(
    "does not count a fulfilled order not yet delivered (%s)",
    (fulfillmentStatus) => {
      expect(isUnpaidInvoiceOrder({ ...unpaid, fulfillmentStatus })).toBe(false)
    },
  )

  it("does not count an order with no invoice snapshot", () => {
    expect(isUnpaidInvoiceOrder({ ...unpaid, receiptData: null })).toBe(false)
    expect(isUnpaidInvoiceOrder({ ...unpaid, receiptData: undefined })).toBe(false)
  })

  it("does not treat a missing or unknown payment status as unpaid", () => {
    expect(isUnpaidInvoiceOrder({ ...unpaid, paymentStatus: null })).toBe(false)
    expect(isUnpaidInvoiceOrder({ ...unpaid, paymentStatus: "PART_PAID" })).toBe(false)
  })

  it("tolerates case and whitespace in stored values", () => {
    expect(isUnpaidInvoiceOrder({ ...unpaid, status: " fulfilled ", fulfillmentStatus: "delivered", paymentStatus: "unpaid" })).toBe(true)
  })

  // Every counted invoice must be one the Super Admin Paid/Unpaid control can
  // act on, or a block could never be cleared by paying.
  it("counts only orders the Paid/Unpaid control accepts", () => {
    const statuses = ["PENDING", "APPROVED", "FULFILLED", "REFUNDED", "REJECTED"]
    const fulfilments = ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]
    for (const status of statuses) {
      for (const fulfillmentStatus of fulfilments) {
        if (isUnpaidInvoiceOrder({ ...unpaid, status, fulfillmentStatus })) {
          expect(isPaymentStatusUpdateEligible(status, fulfillmentStatus)).toBe(true)
        }
      }
    }
  })
})

describe("parseOrderingBlockedResponse", () => {
  const refusal = () => {
    const status = resolvePaymentControl({
      overdue: { configured: true, overdueCount: 2, items: [] },
      exception: null,
      now: new Date("2026-09-30T00:00:00.000Z"),
    })
    const error = new PaymentControlBlockedError(status)
    return { error: error.message, code: error.code, paymentControl: error.details }
  }

  it("recognises the order route's 409 and keeps the server's sentence", () => {
    expect(parseOrderingBlockedResponse(409, refusal())).toEqual({
      unpaidInvoiceCount: 2,
      threshold: 2,
      message: "You have 2 unpaid invoices. Please pay your dues before placing a new order.",
    })
  })

  it("words the refusal itself when the server sent no sentence", () => {
    const body = { ...refusal(), error: "" }
    expect(parseOrderingBlockedResponse(409, body)?.message)
      .toBe("You have 2 unpaid invoices. Please pay your dues before placing a new order.")
  })

  it("ignores any other status, even with the code", () => {
    expect(parseOrderingBlockedResponse(400, refusal())).toBeNull()
    expect(parseOrderingBlockedResponse(500, refusal())).toBeNull()
  })

  it("ignores another 409, such as an edit conflict", () => {
    expect(parseOrderingBlockedResponse(409, { error: "Order state changed" })).toBeNull()
  })

  it.each([
    ["no body", null],
    ["a string body", "blocked"],
    ["no details", { code: "PAYMENT_CONTROL_BLOCKED" }],
    ["a negative count", { code: "PAYMENT_CONTROL_BLOCKED", paymentControl: { overdueCount: -1, threshold: 2 } }],
    ["a fractional count", { code: "PAYMENT_CONTROL_BLOCKED", paymentControl: { overdueCount: 1.5, threshold: 2 } }],
    ["a string count", { code: "PAYMENT_CONTROL_BLOCKED", paymentControl: { overdueCount: "2", threshold: 2 } }],
  ])("returns null for a malformed refusal (%s)", (_label, body) => {
    expect(parseOrderingBlockedResponse(409, body)).toBeNull()
  })
})

describe("orderingBlockFromStatusView", () => {
  const view = (overrides: Record<string, unknown> = {}) => ({
    orderingAllowed: false,
    overdueCount: 3,
    threshold: 2,
    reason: "THRESHOLD_REACHED",
    ...overrides,
  })

  it("reports a block when ordering is not allowed", () => {
    expect(orderingBlockFromStatusView(view())).toEqual({
      unpaidInvoiceCount: 3,
      threshold: 2,
      message: "You have 3 unpaid invoices. Please pay your dues before placing a new order.",
    })
  })

  it("names an expired exception", () => {
    expect(orderingBlockFromStatusView(view({ reason: "EXCEPTION_EXPIRED" }))?.message)
      .toContain("The Head Office exception has expired.")
  })

  it("reports nothing while ordering is allowed — including an active exception", () => {
    expect(orderingBlockFromStatusView(view({ orderingAllowed: true }))).toBeNull()
    expect(orderingBlockFromStatusView(view({ orderingAllowed: true, reason: "EXCEPTION_ACTIVE" }))).toBeNull()
  })

  it("reports nothing for a malformed view, since the server still decides", () => {
    expect(orderingBlockFromStatusView(null)).toBeNull()
    expect(orderingBlockFromStatusView("nope")).toBeNull()
    expect(orderingBlockFromStatusView(view({ orderingAllowed: "false" }))).toBeNull()
    expect(orderingBlockFromStatusView(view({ overdueCount: undefined }))).toBeNull()
  })

  it("falls back to the threshold wording for an unknown reason", () => {
    expect(orderingBlockFromStatusView(view({ reason: "SOMETHING_NEW" }))?.message)
      .toBe("You have 3 unpaid invoices. Please pay your dues before placing a new order.")
  })
})

describe("group submissions", () => {
  const results = [
    { status: "created", branchId: 1, branchName: "North", orderId: 10 },
    { status: "failed", branchId: 2, branchName: "South", reason: "You have 2 unpaid invoices.", code: "PAYMENT_CONTROL_BLOCKED", unpaidInvoiceCount: 2 },
    { status: "failed", branchId: 3, branchName: "East", reason: "Insufficient budget" },
    { status: "failed", branchId: 4, branchName: "West", reason: "You have 4 unpaid invoices.", code: "PAYMENT_CONTROL_BLOCKED", unpaidInvoiceCount: 4 },
  ]

  it("picks out only the branches refused for unpaid invoices", () => {
    expect(blockedBranchesOf(results)).toEqual([
      { branchId: 2, branchName: "South", unpaidInvoiceCount: 2 },
      { branchId: 4, branchName: "West", unpaidInvoiceCount: 4 },
    ])
  })

  it("ignores malformed rows and a missing list", () => {
    expect(blockedBranchesOf(undefined)).toEqual([])
    expect(blockedBranchesOf(null)).toEqual([])
    expect(blockedBranchesOf([{ status: "failed", code: "PAYMENT_CONTROL_BLOCKED", branchId: "2", branchName: "X", unpaidInvoiceCount: 2 }])).toEqual([])
    expect(blockedBranchesOf([{ status: "failed", code: "PAYMENT_CONTROL_BLOCKED", branchId: 2, branchName: "X" }])).toEqual([])
  })

  it("has no notice when no branch was blocked, and lists them when some were", () => {
    expect(noticeForBlockedBranches([])).toBeNull()
    const notice = noticeForBlockedBranches(blockedBranchesOf(results))
    expect(notice?.branches.map((branch) => branch.branchName)).toEqual(["South", "West"])
    expect(notice?.message).toContain("Please pay your dues")
  })
})

describe("notice helpers", () => {
  it("a single-branch block carries its sentence and no list", () => {
    expect(noticeForBlock({ unpaidInvoiceCount: 2, threshold: 2, message: "m" })).toEqual({ message: "m", branches: [] })
  })

  it("labels a count in singular and plural", () => {
    expect(unpaidInvoiceCountLabel(1)).toBe("1 unpaid invoice")
    expect(unpaidInvoiceCountLabel(2)).toBe("2 unpaid invoices")
  })
})
