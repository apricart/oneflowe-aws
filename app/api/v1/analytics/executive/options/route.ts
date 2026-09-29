import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import {
  EXECUTIVE_DIMENSIONS,
  dimensionsForRole,
  isDimensionAllowedForRole,
  isExecutiveDimension,
} from "@/lib/executive-analytics"
import { parseExecutiveRequest } from "@/lib/executive-analytics-request"
import { loadEntityOptions, type ExecutiveFilters } from "@/lib/server/executive-analytics-queries"
import { resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * The entity picker's source of truth: which branches, products, people,
 * groups, categories or tenants this caller may compare.
 *
 * This endpoint hands out *names*, which makes it the one surface where a
 * scoping mistake would leak something even though it returns no figures. Two
 * guards apply, and both are server-side:
 *
 *  * every list is derived from rows inside the caller's resolved fence, so a
 *    tenant whose orders are not visible cannot have its people or products
 *    named here;
 *  * a dimension reserved to one role is refused outright, so Head Office
 *    cannot enumerate organizations by calling the endpoint directly.
 *
 * With no `dimension`, it returns the menu of dimensions the caller may use,
 * which is what the workbench builds its first selector from.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const url = new URL(req.url)

    const scope = await resolveExecutiveScope(session, url.searchParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

    const dimension = url.searchParams.get("dimension")

    if (!dimension) {
      return NextResponse.json({
        role: scope.role,
        dimensions: dimensionsForRole(scope.role).map((entry) => ({
          id: entry.id,
          label: entry.label,
          entityNoun: entry.entityNoun,
          metrics: entry.metrics,
          selectable: entry.selectable,
        })),
      })
    }

    if (!isExecutiveDimension(dimension)) {
      return NextResponse.json({ error: "Unsupported dimension" }, { status: 400 })
    }
    if (!isDimensionAllowedForRole(dimension, scope.role)) {
      return NextResponse.json({ error: "Forbidden: Insufficient permissions" }, { status: 403 })
    }
    if (!EXECUTIVE_DIMENSIONS[dimension].selectable) {
      return NextResponse.json({ dimension, options: [], selectable: false })
    }

    const parsed = parseExecutiveRequest(url.searchParams)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const filters: ExecutiveFilters = {
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      categoryIds: parsed.categoryIds,
      productIds: parsed.productIds,
      groupIds: parsed.groupIds,
      userIds: parsed.userIds,
      unit: null,
      statusSet: parsed.statusSet,
    }

    const options = await loadEntityOptions(scope, filters, dimension)
    return NextResponse.json({ dimension, selectable: true, options })
  } catch (error) {
    console.error("Executive analytics options failed:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
