import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadWarehouseCatalogFence } from "@/lib/server/warehouse-catalog-tenant"

export const dynamic = "force-dynamic"

/**
 * The organizations the warehouse's catalogue covers: those whose branches it
 * serves, re-read on every request. GET only
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

    const unknownKey = [...new URL(req.url).searchParams.keys()][0]
    if (unknownKey !== undefined) return error(`Unknown filter: ${unknownKey}`, 400)

    const fence = await loadWarehouseCatalogFence(user.id)
    return NextResponse.json({ organizations: fence.organizations }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/organizations")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
