import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { listWarehousePurchaseOrders } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * The approved purchase orders receiving into the warehouses this account
 * works: supplier, quantities and progress — never a cost.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    return json({ items: await listWarehousePurchaseOrders(db, warehouseIds), stockLedgerOn: usesWarehouseStock() })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/warehouse/procurement/purchase-orders")
  }
}
