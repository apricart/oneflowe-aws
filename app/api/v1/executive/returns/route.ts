import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { listCustomerReturns, loadExecutiveWarehouseIds } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"

/**
 * Customer returns at the warehouses this Apricart Executive is an executive
 * member of, read live; any other warehouse's are not listed.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole(["APRICART_EXECUTIVE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const warehouseIds = await loadExecutiveWarehouseIds(db, user.id)
    return json({ items: await listCustomerReturns(db, { warehouseIds }), hasWarehouses: warehouseIds.length > 0 })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/executive/returns")
  }
}
