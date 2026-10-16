import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { listWarehouseTaxonomy } from "@/lib/server/warehouse-catalog"
import { parseWarehouseTaxonomyQuery } from "@/lib/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * Super Admin's Subcategories list, read-only, for the warehouse: names, counts and
 * dates of Apricart's catalogue taxonomy. GET only
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const parsed = parseWarehouseTaxonomyQuery(new URL(req.url).searchParams, "subcategory")
    if (!parsed.ok) return error(parsed.error, 400)

    return NextResponse.json(await listWarehouseTaxonomy(parsed.value, "subcategory"), { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/taxonomy/subcategories")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
