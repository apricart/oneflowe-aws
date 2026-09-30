import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("pending invoice notification wiring", () => {
  it("checks before both live order-submission paths", () => {
    const shop = source("app/shop/page.tsx")
    const groupStorefront = source("components/group-portal/storefront/group-storefront.tsx")

    expect(shop).toContain("usePendingInvoiceGuard")
    expect(shop).toContain("onClick={editingOrder ? placeOrder : pendingInvoiceGuard.attempt}")
    expect(groupStorefront).toContain("usePendingInvoiceGuard")
    expect(groupStorefront).toContain("onSubmit={() => { void pendingInvoiceGuard.attempt() }}")
  })

  it("keeps existing-order edits outside the new-order warning", () => {
    expect(source("app/shop/page.tsx")).toContain(
      "onClick={editingOrder ? placeOrder : pendingInvoiceGuard.attempt}",
    )
  })

  it("queries only invoices created by the authenticated user", () => {
    const route = source("app/api/v1/orders/pending-invoice/route.ts")
    expect(route).toContain("eq(orders.createdByUserId, user.id)")
    expect(route).toContain('eq(orderSelectColumns.paymentStatus, "UNPAID")')
    expect(route).toContain("isNotNull(orders.receiptData)")
    expect(route).toContain("PENDING_INVOICE_ORDER_STATUSES")
    expect(route).not.toMatch(/searchParams|branchId|organizationId/)
  })
})
