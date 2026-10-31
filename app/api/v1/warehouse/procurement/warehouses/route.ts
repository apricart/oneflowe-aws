import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { listWarehousesById } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * The Apricart warehouses this warehouse account works — its active operator
 * memberships, read live — for its requisition, receiving and return forms.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    return json({ items: await listWarehousesById(db, warehouseIds), stockLedgerOn: usesWarehouseStock() })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/warehouse/procurement/warehouses")
  }
}
