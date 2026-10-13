import { describe, expect, it } from "vitest"

import {
  INVOICE_ISSUE_POINT,
  STAGES_BEFORE_TAX_INVOICE,
  TAX_INVOICE_ISSUE_STAGE,
  drawsInvoiceNumberAtCreation,
  isBeforeTaxInvoiceStage,
  issuesTaxInvoiceOnStep,
} from "./invoice-policy"

describe("invoice numbering policy", () => {
  it("numbers invoices when processing starts (plans/OF-INVOICE-issue-at-processing.md)", () => {
    expect(INVOICE_ISSUE_POINT).toBe("processing")
    expect(TAX_INVOICE_ISSUE_STAGE).toBe("IN_PROCESS")
    expect(drawsInvoiceNumberAtCreation()).toBe(false)
  })

  it("keeps the switch back to numbering at creation", () => {
    expect(drawsInvoiceNumberAtCreation("creation")).toBe(true)
  })

  it("issues on In Process and on every later step, so an order already past it is never skipped", () => {
    expect(issuesTaxInvoiceOnStep("NOT_STARTED")).toBe(false)
    expect(issuesTaxInvoiceOnStep("IN_PROCESS")).toBe(true)
    expect(issuesTaxInvoiceOnStep("OUT_FOR_DELIVERY")).toBe(true)
    expect(issuesTaxInvoiceOnStep("DELIVERED")).toBe(true)
  })

  it("treats only Not Started — or no stage at all — as before the invoice", () => {
    expect(STAGES_BEFORE_TAX_INVOICE).toEqual(["NOT_STARTED"])
    expect(isBeforeTaxInvoiceStage(null)).toBe(true)
    expect(isBeforeTaxInvoiceStage("not_started")).toBe(true)
    expect(isBeforeTaxInvoiceStage("IN_PROCESS")).toBe(false)
    expect(isBeforeTaxInvoiceStage("OUT_FOR_DELIVERY")).toBe(false)
    expect(isBeforeTaxInvoiceStage("DELIVERED")).toBe(false)
  })
})
