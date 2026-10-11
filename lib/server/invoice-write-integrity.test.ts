import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

const source = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8")

describe("invoice creation is part of the order transaction", () => {
  it("does not swallow receipt failures in either order-creation path", () => {
    const singleOrder = source("app/api/v1/orders/route.ts")
    const groupOrder = source("lib/server/group-order-creation.ts")

    expect(singleOrder).not.toContain("Receipt generation failed during order creation")
    expect(groupOrder).not.toContain("Receipt generation failed during group order creation")
    expect(singleOrder).not.toContain("if (!receiptData) return")
    expect(groupOrder).not.toContain("if (!receiptData) return")
    expect(singleOrder).toContain("const receiptData = await generateReceiptData({")
    expect(groupOrder).toContain("const receiptData = await generateReceiptData({")
  })

  it("rolls back order edits instead of erasing the invoice when regeneration fails", () => {
    const orderEdit = source("app/api/v1/orders/[id]/route.ts")

    expect(orderEdit).not.toContain("Receipt regeneration failed during order edit")
    expect(orderEdit).not.toContain("set({ receiptData: null })")
    expect(orderEdit).toContain("const receiptData = await generateReceiptData({")
  })

  // Both creation paths number through one function, which numbers nothing
  // while invoices are issued at delivery (plans/OF-INVOICE-invoice-ledger.md)
  // and, when switched back, still locks the tenant on the TID fallback.
  it("numbers (or not) through one shared function that locks the tenant on the TID fallback", () => {
    for (const path of ["app/api/v1/orders/route.ts", "lib/server/group-order-creation.ts"]) {
      expect(source(path)).toContain("await assignInvoiceNumberAtCreation(tx, receiptData, {")
      expect(source(path)).not.toContain("generateNextInvoiceNumber(")
    }
    expect(source("lib/invoice-number.ts")).toContain("await lockInvoiceTenantForIssuance(client, input.organizationId)")
  })
})

describe("an issued invoice permanently owns its organization prefix", () => {
  it("serializes invoice issuance against organization-code changes", () => {
    const invoiceNumber = source("lib/invoice-number.ts")
    const organizationUpdate = source("app/api/v1/organizations/[id]/route.ts")

    expect(invoiceNumber).toContain('.for("share")')
    expect(organizationUpdate).toContain('.for("update")')
    expect(organizationUpdate).toContain("isNotNull(orders.receiptData)")
    expect(organizationUpdate).toContain('kind: "invoice-prefix-locked"')
    expect(organizationUpdate).toContain(
      "Organization code cannot be changed after the organization has issued its first invoice.",
    )
  })
})
