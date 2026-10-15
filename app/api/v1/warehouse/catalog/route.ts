import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { listWarehouseCatalog } from "@/lib/server/warehouse-catalog"
import { parseWarehouseCatalogQuery } from "@/lib/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * Super Admin's Global Products, read-only, for the warehouse: every global
 * product's code, name, unit, status, base price, stock, picture and category.
 * There is no write method here, and the warehouse changes nothing in the
 * catalogue (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const parsed = parseWarehouseCatalogQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    return NextResponse.json(await listWarehouseCatalog(parsed.value), { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
