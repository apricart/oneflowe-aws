import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order delivery date contracts", () => {
  it("adds a nullable delivery timestamp and backfills only delivered orders", () => {
    const schema = source("db/schema.ts")
    const migration = source("drizzle/20260722120000_add_order_delivered_at.sql")

    expect(schema).toContain('deliveredAt: timestamp("delivered_at", { withTimezone: true })')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "delivered_at" timestamp with time zone')
    expect(migration).toContain("ORDER_FULFILLMENT_STATUS_UPDATE")
    expect(migration).toContain('"order_row"."fulfilled_at"')
    expect(migration).toContain('"order_row"."updated_at"')
    expect(migration).toContain("= 'DELIVERED'")
    expect(migration).toContain('"order_row"."delivered_at" IS NULL')
  })

  it("records delivery only through existing authorized, tenant-scoped transitions", () => {
    const progressRoute = source("app/api/v1/orders/[id]/fulfillment-status/route.ts")
    const directFulfilment = source("app/api/v1/orders/[id]/fulfill/route.ts")
    // The transition itself moved into the shared fulfilment service, which the
    // route and the token hand-off both call.
    const fulfilmentService = source("lib/server/order-fulfillment.ts")
    const orderSelect = source("lib/order-select.ts")

    expect(progressRoute).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(progressRoute).toContain("verifyResourceAccess(order.organizationId, order.branchId)")
    // The transition moved into the progress module the warehouse shares; both
    // routes reach delivery only through it, each authorizing its own caller.
    const progressModule = source("lib/server/order-fulfillment-progress.ts")
    const warehouseRoute = source("app/api/v1/warehouse/orders/[id]/progress/route.ts")
    expect(progressRoute).toContain("progressOrderFulfillment({")
    expect(warehouseRoute).toContain("progressOrderFulfillment({")
    expect(warehouseRoute).toContain('requireApiRole(["WAREHOUSE"])')
    expect(warehouseRoute).toContain("isOrderInWarehouseReach(user.id, orderId, { client: tx, lock: true })")
    expect(progressModule).toContain("transitionOrderFulfillmentStatusColumn")
    expect(orderSelect).toContain("WHEN ${nextStatus} = 'DELIVERED'")
    expect(orderSelect).toContain('COALESCE("delivered_at", NOW())')

    expect(directFulfilment).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(directFulfilment).toContain("verifyResourceAccess(ord.organizationId, ord.branchId)")
    // Fulfilment no longer records a delivery: it requires one. The recorded
    // delivery moment is never overwritten by the fulfilment that follows it.
    expect(fulfilmentService).not.toContain("deliveredAt: fulfilledAt")
    expect(fulfilmentService).not.toContain("updateOrderFulfillmentStatusColumn")
    expect(directFulfilment).toContain("if (!isOrderDelivered(ord.fulfillmentStatus)) {")
  })

  it("uses deliveredAt for the waiting window without changing order-list scoping", () => {
    const autoFulfil = source("app/api/v1/orders/cron/auto-fulfill/route.ts")
    const ordersRoute = source("app/api/v1/orders/route.ts")

    expect(autoFulfil).toContain("lte(orders.deliveredAt, cutoff)")
    expect(autoFulfil).not.toContain("lte(orders.updatedAt, cutoff)")
    expect(ordersRoute).toContain("deliveredAt: orders.deliveredAt")
    expect(ordersRoute).toContain("eq(orders.createdByUserId, currentUserId)")
    expect(ordersRoute).toContain("eq(orders.organizationId, orgIdNum)")
    expect(ordersRoute).toContain("eq(orders.branchId, branchIdFromUser)")
  })

  it("shows an explicit empty value for orders that have not been delivered", () => {
    const directory = source("components/orders/orders-directory.tsx")

    // Headers are sortable labels (plans/OF-TABLE-column-sorting.md).
    expect(directory).toContain('{sortLabel("orderDate", "Order Date")}</th>')
    expect(directory).toContain('{sortLabel("deliveryDate", "Delivery Date")}</th>')
    expect(directory).toContain('order.deliveredAt ? format(new Date(order.deliveredAt), "dd MMM yyyy") : "—"')
    // The table is wider than its card, so its horizontal scrollbar is always
    // shown (overflow-x: scroll) rather than appearing only on overflow/hover.
    // Rows scroll inside the bounded box (overflow-y: auto) so that scrollbar
    // sits in the viewport instead of below the last row.
    expect(directory).toContain("orders-table-scrollbar")
    expect(source("app/globals.css")).toMatch(/\.orders-table-scrollbar \{\s*overflow-x: scroll;\s*overflow-y: auto;/)
  })
})
