import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { fenceAdmitsOrganization, listWarehouseProductRequests, loadWarehouseCatalogFence } from "@/lib/server/warehouse-catalog-tenant"
import { parseWarehouseProductRequestsQuery } from "@/lib/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * Super Admin's Product Requests, read-only: what the organizations the
 * warehouse serves have asked for and where each stands. No requester or
 * reviewer is named. An organization outside that is 404. GET only — the
 * warehouse neither raises nor decides a request
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

    const parsed = parseWarehouseProductRequestsQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    const fence = await loadWarehouseCatalogFence(user.id)
    if (parsed.value.organizationId !== null && !fenceAdmitsOrganization(fence, parsed.value.organizationId)) {
      return error("Organization not found", 404)
    }

    return NextResponse.json(
      await listWarehouseProductRequests(parsed.value, fence.organizations.map((organization) => organization.id)),
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/product-requests")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
