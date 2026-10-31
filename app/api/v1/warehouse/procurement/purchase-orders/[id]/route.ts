import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { loadWarehousePurchaseOrder } from "@/lib/server/procurement"
import { caughtResponse, json, routeId } from "@/lib/server/procurement-route"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"

/**
 * One approved purchase order to receive against: lines, ordered and received
 * quantities, the over-delivery allowance and earlier receipts — never a cost.
 * Another warehouse's PO, or one not yet approved, is 404.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    const order = await loadWarehousePurchaseOrder(db, id, warehouseIds)
    return order ? json({ order }) : error("Not found", 404)
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/warehouse/procurement/purchase-orders/[id]")
  }
}
