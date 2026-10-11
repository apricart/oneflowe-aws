import { describe, expect, it } from "vitest"

import { INVOICE_ISSUE_POINT, drawsInvoiceNumberAtCreation } from "./invoice-policy"

describe("invoice numbering policy", () => {
  it("numbers invoices at delivery (plans/OF-INVOICE-invoice-ledger.md)", () => {
    expect(INVOICE_ISSUE_POINT).toBe("delivery")
    expect(drawsInvoiceNumberAtCreation()).toBe(false)
  })

  it("keeps the switch back to numbering at creation", () => {
    expect(drawsInvoiceNumberAtCreation("creation")).toBe(true)
  })
})
