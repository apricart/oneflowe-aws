import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { listWarehouseCatalogCategories } from "@/lib/server/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * The categories and subcategories the warehouse's catalogue can be filtered
 * by: those a global product is filed under, read-only
 * (plans/OF-WAREHOUSE-read-only-product-catalog.md).
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const unknownKey = [...new URL(req.url).searchParams.keys()][0]
    if (unknownKey !== undefined) return error(`Unknown filter: ${unknownKey}`, 400)

    return NextResponse.json(
      { categories: await listWarehouseCatalogCategories() },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/categories")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
