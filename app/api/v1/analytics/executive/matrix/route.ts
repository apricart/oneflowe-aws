import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { EXECUTIVE_DIMENSIONS, EXECUTIVE_METRICS, resolveMatrixGrain, resolveQuantityUnit } from "@/lib/executive-analytics"
import { parseMatrixRequest } from "@/lib/executive-analytics-request"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  isLineScoped,
  loadMatrix,
  loadUnitsInScope,
  type ExecutiveFilters,
} from "@/lib/server/executive-analytics-queries"
import { resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * The two-way grid of the Product Performance screen: requesters against
 * products, one figure per pair, never combined.
 *
 * "By requester" with three products in focus answers "how much did each
 * person consume of the three together"; this answers "how much did each
 * person consume of *each*". It is a different shape — rows × columns × cells
 * — which is why it is its own route rather than a third mode on `/compare`,
 * whose one-value-per-entity response three screens and the download already
 * depend on.
 *
 * Authorization is `resolveExecutiveScope`, exactly as on every executive
 * route: the branch fence comes from the caller's own user row and assignment
 * rows, a requested `organizationIds` / `branchIds` / `groupIds` can only
 * narrow it, and every role outside `EXECUTIVE_ANALYTICS_ROLES` is refused
 * before a query runs. There is no `keys` folding here — both axes'
 * selections travel as the ordinary `userIds` / `productIds` filters the
 * screen already sends — so there is no second scoping path to audit.
 *
 * The grid is bounded to `MATRIX_MAX_ENTITIES` on each side and pinned to the
 * ranked members before the cells are read, so the largest answer is 144
 * aggregates whatever the tenant's size. It runs three grouped reads per call
 * and is rate limited for that reason.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const sessionUserId = (session?.user as { id?: string } | undefined)?.id
    const limited = await withRateLimit("search", sessionUserId)
    if (limited) return limited

    const url = new URL(req.url)

    const scope = await resolveExecutiveScope(session, url.searchParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

    const parsed = parseMatrixRequest(url.searchParams, new Date(), scope.role)
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
    }

    const metricDefinition = EXECUTIVE_METRICS[parsed.metric]
    const grain = resolveMatrixGrain(parsed.rows, parsed.columns, parsed.metric, { lineScoped: isLineScoped(baseFilters) })

    // Every grid that touches order lines resolves its unit, exactly as the
    // comparison does, so a quantity is never added across litres and packs.
    const unitsInScope = metricDefinition.unitSensitive || grain === "line"
      ? await loadUnitsInScope(scope, baseFilters)
      : []
    const unitResolution = resolveQuantityUnit(unitsInScope, parsed.requestedUnit)

    const description = {
      rowDimension: parsed.rows,
      columnDimension: parsed.columns,
      rowLabel: EXECUTIVE_DIMENSIONS[parsed.rows].label,
      columnLabel: EXECUTIVE_DIMENSIONS[parsed.columns].label,
      metric: parsed.metric,
      grain,
      format: metricDefinition.format,
      label: metricDefinition.label,
      formula: metricDefinition.formula,
      period: {
        startDate: parsed.startDate.toISOString(),
        endDate: parsed.endDate.toISOString(),
      },
      quantityUnit: {
        selected: unitResolution.unit,
        conflict: unitResolution.conflict,
        available: unitResolution.units,
      },
      limits: { rows: parsed.limit, columns: parsed.limit },
    }

    if (metricDefinition.unitSensitive && unitResolution.conflict) {
      return NextResponse.json({
        ...description,
        rows: [],
        columns: [],
        cells: [],
        blocked: {
          reason: "unit-conflict",
          message: `${metricDefinition.label} cannot be totalled across ${unitResolution.units.join(", ")}. Choose one unit of measure, or narrow the selection to products sharing one.`,
        },
      })
    }

    const filters: ExecutiveFilters = { ...baseFilters, unit: unitResolution.unit }
    const { rows, columns, cells } = await loadMatrix(scope, filters, parsed.rows, parsed.columns, parsed.metric, parsed.limit)

    return NextResponse.json({ ...description, rows, columns, cells })
  } catch (error) {
    console.error("Executive analytics grid failed:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
