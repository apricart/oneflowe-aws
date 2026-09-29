import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import {
  EXECUTIVE_DIMENSIONS,
  EXECUTIVE_METRICS,
  metricDefinitionForStatusSet,
  resolveQuantityUnit,
} from "@/lib/executive-analytics"
import { applyEntityKeys, isScopeKeyedDimension, parseDrillDownRequest } from "@/lib/executive-analytics-request"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  loadDrillDownLines,
  loadUnitsInScope,
  type ExecutiveFilters,
} from "@/lib/server/executive-analytics-queries"
import { resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * The detail behind a clicked bar, point or slice.
 *
 * A chart answers "how much". This answers "which rows", for exactly the bar
 * the reader clicked and under exactly the filters and period the chart was
 * drawn with — the two must reconcile, or the drill-down is worse than none.
 *
 * It is the one surface in the Analytics Center that returns individual records
 * rather than aggregates, so three things are true of it deliberately:
 *
 *  * **Scope is re-derived, never received.** `resolveExecutiveScope` reads the
 *    caller's own user row; a branch or organization key from the chart is
 *    folded into the scope parameters first (`applyEntityKeys`) so it is
 *    *intersected* with that fence rather than trusted. Clicking another
 *    tenant's bar — which nothing in the UI can produce — narrows to nothing.
 *  * **It is bounded.** `limit` is clamped to `DRILLDOWN_MAX_ROWS` and the
 *    offset to `DRILLDOWN_MAX_OFFSET`, so no caller can walk the order book
 *    through it. It is rate limited as a listing endpoint.
 *  * **Sorting is an allowlist.** The sort key selects a pre-written
 *    expression; no request string reaches an ORDER BY.
 *
 * Prices are returned without redaction because every role that can reach this
 * endpoint at all — Super Admin, Head Office and the multi-branch approver —
 * already reads prices everywhere else; `lib/price-visibility.ts` restricts
 * Branch Admin and Order Portal, neither of which has any Executive Analytics
 * surface.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const sessionUserId = (session?.user as { id?: string } | undefined)?.id
    const limited = await withRateLimit("search", sessionUserId)
    if (limited) return limited

    const url = new URL(req.url)

    // Same ordering as the comparison endpoint, and for the same reason: a
    // branch, group or organization key must be inside the scope parameters
    // before the fence is resolved, so it can only narrow what the caller
    // already had.
    const requestedDimension = url.searchParams.get("dimension")
    const scopeParams = isScopeKeyedDimension(requestedDimension)
      ? applyEntityKeys(withKeyAsKeys(url.searchParams), requestedDimension)
      : url.searchParams

    const scope = await resolveExecutiveScope(session, scopeParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

    const parsed = parseDrillDownRequest(url.searchParams, new Date(), scope.role)
    if (!parsed.ok) {
      const forbidden = parsed.error.startsWith("Forbidden")
      return NextResponse.json({ error: parsed.error }, { status: forbidden ? 403 : 400 })
    }

    const baseFilters: ExecutiveFilters = {
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      categoryIds: parsed.categoryIds,
      productIds: parsed.productIds,
      groupIds: parsed.groupIds,
      userIds: parsed.userIds,
      unit: null,
      statusSet: parsed.statusSet,
    }

    // Quantity comparisons count every ordered line quantity regardless of its
    // unit label, and Amount is monetary, so neither retains the retired unit
    // filter. Average Unit Price remains unit-sensitive.
    const metricDefinition = EXECUTIVE_METRICS[parsed.metric]
    const unitsInScope = metricDefinition.unitSensitive ? await loadUnitsInScope(scope, baseFilters) : []
    const requestedUnit = metricDefinition.unitSensitive ? parsed.requestedUnit : null
    const unitResolution = resolveQuantityUnit(unitsInScope, requestedUnit)
    const filters: ExecutiveFilters = {
      ...baseFilters,
      unit: requestedUnit && unitResolution.unit ? unitResolution.unit : null,
    }

    const result = await loadDrillDownLines(scope, filters, {
      sort: parsed.sort,
      direction: parsed.direction,
      limit: parsed.limit,
      offset: parsed.offset,
    })

    return NextResponse.json({
      dimension: parsed.dimension,
      dimensionLabel: EXECUTIVE_DIMENSIONS[parsed.dimension].label,
      metric: parsed.metric,
      metricLabel: metricDefinitionForStatusSet(parsed.metric, parsed.statusSet).label,
      entityKey: parsed.entityKey,
      periodKey: parsed.period,
      period: { startDate: parsed.startDate.toISOString(), endDate: parsed.endDate.toISOString() },
      sort: parsed.sort,
      direction: parsed.direction,
      limit: parsed.limit,
      offset: parsed.offset,
      statuses: parsed.statusSet,
      quantityUnit: {
        selected: filters.unit,
        conflict: unitResolution.conflict,
        available: unitResolution.units,
      },
      ...result,
    })
  } catch (error) {
    console.error("Executive analytics drill-down failed:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

/**
 * The drill-down names the clicked entity as `key`; `applyEntityKeys` reads
 * `keys`. Copying it across here keeps the scope-resolution path byte-identical
 * to the comparison endpoint's rather than giving this route a second, subtly
 * different way to fold an entity into the fence.
 */
function withKeyAsKeys(searchParams: URLSearchParams): URLSearchParams {
  const key = searchParams.get("key")
  if (!key) return searchParams
  const merged = new URLSearchParams(searchParams)
  merged.set("keys", key)
  return merged
}
