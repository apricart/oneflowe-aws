import { describe, expect, it } from "vitest"

import { parsePaymentStatusFilter } from "@/lib/payment-status"

describe("payment-status list filters", () => {
  it("accepts paid and unpaid case-insensitively", () => {
    expect(parsePaymentStatusFilter("paid")).toEqual({ ok: true, status: "PAID" })
    expect(parsePaymentStatusFilter(" UNPAID ")).toEqual({ ok: true, status: "UNPAID" })
  })

  it("leaves an omitted payment status unfiltered", () => {
    expect(parsePaymentStatusFilter(null)).toEqual({ ok: true, status: null })
  })

  it("refuses unknown values instead of treating them as unpaid", () => {
    expect(parsePaymentStatusFilter("settled")).toEqual({
      ok: false,
      message: "paymentStatus must be one of: UNPAID, PAID",
    })
  })
})
