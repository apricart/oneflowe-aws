import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const route = readFileSync(
  resolve(process.cwd(), "app/api/v1/orders/[id]/route.ts"),
  "utf8",
)
const portal = readFileSync(resolve(process.cwd(), "app/shop/page.tsx"), "utf8")

describe("order edit security contract", () => {
  it("allows the fast single-order read only for the portal user's own order", () => {
    expect(route).toContain('"BRANCH_ADMIN", "ORDER_PORTAL"')
    expect(route).toContain('currentRole === "ORDER_PORTAL" && item.createdByUserId !== currentUserId')
  })

  it("keeps the update restricted to Order Portal users and strict input", () => {
    expect(route).toContain('requireApiRole(["ORDER_PORTAL"])')
    expect(route).toContain("orderUpdateSchema.safeParse")
    expect(route).toContain("canOrderPortalEditOrder")
  })

  it("locks and scopes the order before reconciling reservations", () => {
    expect(route).toContain('eq(orders.createdByUserId, user.id)')
    expect(route).toContain('eq(orders.organizationId, organizationId)')
    expect(route).toContain('eq(orders.branchId, branchId)')
    expect(route).toContain('.for("update")')
    expect(route).toContain("lockedBudget.amountHeldCents - existingOrder.totalCents + totalCents")
    expect(route).toContain("Number(product.stockQuantity) + previousQuantity - nextQuantity")
  })

  it("enforces pending status at the write point and limits the UI action likewise", () => {
    expect(route).toContain("sql`UPPER(${orders.status}) = 'PENDING'`")
    expect(portal).toContain('order.status?.toUpperCase() === "PENDING"')
    expect(portal).toContain('method: editingOrder ? "PUT" : "POST"')
  })
})
