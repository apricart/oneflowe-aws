import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { searchProcurementProducts } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"

/**
 * The product picker for the warehouse's requisitions and returns: active
 * catalogue products by name or code, no price. Only an account that works a
 * warehouse gets an answer. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    if ((await loadWarehouseMemberships(db, user.id)).length === 0) return json({ items: [] })
    const query = new URL(req.url).searchParams.get("q") ?? ""
    return json({ items: await searchProcurementProducts(db, query) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/warehouse/procurement/products")
  }
}
