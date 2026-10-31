import { requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { PROCUREMENT_MANAGE_ROLES } from "@/lib/procurement-access"
import { searchProcurementProducts } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"

/**
 * The product picker for requisitions and purchase orders: active catalogue
 * products by name or code, at most 25, no price. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_MANAGE_ROLES])
    if (roleError) return roleError
    const query = new URL(req.url).searchParams.get("q") ?? ""
    return json({ items: await searchProcurementProducts(db, query) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/products")
  }
}
