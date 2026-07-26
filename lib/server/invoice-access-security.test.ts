import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

describe("invoice access security", () => {
  it("enforces approval on both preview and download endpoints", () => {
    const previewRoute = source("app/api/v1/receipts/[orderId]/route.ts")
    const downloadRoute = source("app/api/v1/receipts/[orderId]/download/route.ts")

    for (const route of [previewRoute, downloadRoute]) {
      expect(route).toContain("if (!isInvoiceAvailableForOrder(order))")
      expect(route).toContain("Invoice is available after the order is approved")
    }
  })

  it("includes initiator and approver in both invoice formats", () => {
    const preview = source("components/receipts/receipt-content.tsx")
    const download = source("app/api/v1/receipts/[orderId]/download/route.ts")

    for (const invoiceFormat of [preview, download]) {
      expect(invoiceFormat).toContain("Initiator:")
      expect(invoiceFormat).toContain("Approver:")
      expect(invoiceFormat).toContain("approvedByName")
    }
  })
})
