import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const route = readFileSync(
  resolve(process.cwd(), "app/api/v1/orders/[id]/route.ts"),
  "utf8",
)
const portal = readFileSync(resolve(process.cwd(), "app/shop/page.tsx"), "utf8")

describe("order edit security contract", () => {
  it("scopes the fast single-order read to what the portal user may see", () => {
    expect(route).toContain('"BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"')
    // A requester reads its own orders and the group orders raised for its
    // branch, which spend that branch's budget. The rule is the shared one
    // rather than an inline comparison, so this read and the store's list can
    // never disagree about which orders exist.
    expect(route).toContain("or(eq(orders.createdByUserId, currentUserId), isNotNull(orders.groupOrderId))")
    expect(route).toContain("canOrderPortalReadOrder({ viewerUserId: currentUserId, order: item })")
  })

  it("does not let that wider read reach a colleague's own order", () => {
    // The widening turns on `groupOrderId`, which is null on every order raised
    // through any other flow — including a colleague's own.
    const policy = readFileSync(
      resolve(process.cwd(), "lib/group-order-visibility.ts"),
      "utf8",
    )
    expect(policy).toContain("if (isGroupPortalOrder(order)) return true")
    expect(policy).toContain("return Boolean(viewerUserId) && order.createdByUserId === viewerUserId")
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
