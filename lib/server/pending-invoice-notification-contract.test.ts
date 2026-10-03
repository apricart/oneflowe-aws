import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

/** The body of the shop's new-order handler, up to its closing brace. */
function attemptNewOrderBody(shop: string): string {
  const start = shop.indexOf("const attemptNewOrder = async () => {")
  expect(start).toBeGreaterThan(-1)
  const end = shop.indexOf("\n  }\n", start)
  expect(end).toBeGreaterThan(start)
  return shop.slice(start, end)
}

describe("pending invoice notification wiring", () => {
  it("checks before both live order-submission paths", () => {
    const shop = source("app/shop/page.tsx")
    const groupStorefront = source("components/group-portal/storefront/group-storefront.tsx")

    expect(shop).toContain("usePendingInvoiceGuard")
    // A new order first asks whether the branch is blocked for unpaid invoices
    // (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md), then goes
    // through the pending-invoice notice exactly as before.
    expect(shop).toContain("onClick={editingOrder ? placeOrder : attemptNewOrder}")
    expect(attemptNewOrderBody(shop)).toContain("await pendingInvoiceGuard.attempt()")
    expect(groupStorefront).toContain("usePendingInvoiceGuard")
    expect(groupStorefront).toContain("onSubmit={() => { void pendingInvoiceGuard.attempt() }}")
  })

  it("keeps existing-order edits outside the new-order warning", () => {
    const shop = source("app/shop/page.tsx")
    expect(shop).toContain("onClick={editingOrder ? placeOrder : attemptNewOrder}")
    // The new-order path never places the order itself; only the guard does.
    expect(attemptNewOrderBody(shop)).not.toContain("placeOrder(")
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
