import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { fenceAdmitsOrganization, listWarehouseOrganizationProducts, loadWarehouseCatalogFence } from "@/lib/server/warehouse-catalog-tenant"
import { parseWarehouseOrganizationProductsQuery } from "@/lib/warehouse-catalog"

export const dynamic = "force-dynamic"

/**
 * Super Admin's Organization Products, read-only, for one organization the
 * warehouse serves: each product's base, organization and effective price,
 * status and assignment date. Any other organization is 404. GET only
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

    const parsed = parseWarehouseOrganizationProductsQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    const fence = await loadWarehouseCatalogFence(user.id)
    if (!fenceAdmitsOrganization(fence, parsed.value.organizationId)) return error("Organization not found", 404)
    const organization = fence.organizations.find((candidate) => candidate.id === parsed.value.organizationId)!

    return NextResponse.json(
      await listWarehouseOrganizationProducts(parsed.value, organization),
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/catalog/organization-products")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
