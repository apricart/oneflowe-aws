import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadProductPriceHistory } from "@/lib/server/product-price-history"
import { loadWarehouseCatalogFence } from "@/lib/server/warehouse-catalog-tenant"
import { warehousePriceHistoryUnknownKey } from "@/lib/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * Super Admin's Product Price History, read-only, through the same loader:
 * global price changes, and organization and group changes of the
 * organizations the warehouse serves; branch rows only for its own branches.
 * An organization, group or branch outside that is 404. GET only
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

    const params = new URL(req.url).searchParams
    const unknownKey = warehousePriceHistoryUnknownKey(params)
    if (unknownKey) return error(`Unknown filter: ${unknownKey}`, 400)

    const fence = await loadWarehouseCatalogFence(user.id)
    const result = await loadProductPriceHistory(params, {
      role: "WAREHOUSE",
      organizationIds: fence.organizations.map((organization) => organization.id),
      branchIds: fence.branchIds,
    })
    if (!result.ok) return error(result.error, result.status)
    return NextResponse.json(result.body, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/price-history")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
