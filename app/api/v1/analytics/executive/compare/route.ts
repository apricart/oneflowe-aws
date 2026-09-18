import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import {
  EXECUTIVE_METRICS,
  chartMode,
  chartTypesFor,
  growthPct,
  resolveGrain,
  resolveQuantityUnit,
  withCumulativeShare,
} from "@/lib/executive-analytics"
import { applyEntityKeys, isScopeKeyedDimension, parseComparisonRequest, previousWindow } from "@/lib/executive-analytics-request"
import {
  isLineScoped,
  loadComparison,
  loadEntitySeries,
  loadProductPriceByBranch,
  loadUnitsInScope,
  type ExecutiveFilters,
} from "@/lib/server/executive-analytics-queries"
import { resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * Level 2 of the Executive Analytics Center: the Explore / Compare workbench.
 *
 * One endpoint answers "compare these <entities> by <metric> as a <chart>" for
 * every combination the registry lists, instead of a page's worth of
 * copy-pasted routes. It is emphatically not a query builder: `dimension`,
 * `metric` and `chart` are matched against the registry and then used to
 * *select* a pre-written aggregation, and every id is bound as a parameter.
 *
 * Authorization runs in two independent places, deliberately:
 *
 *  * `resolveExecutiveScope` decides which rows exist for this caller, and the
 *    branch, organization and group halves of an entity selection are routed
 *    through it — so ticking another tenant's branch narrows to nothing rather
 *    than reaching it. That is why `applyEntityKeys` runs *before* the scope is
 *    resolved.
 *  * `parseComparisonRequest` refuses a dimension reserved to another role, so
 *    the organization comparison is closed to Head Office on the server and not
 *    merely absent from its menu.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const url = new URL(req.url)

    // The dimension is needed before scope resolution so a branch, group or
    // organization selection is folded into the scope parameters and gets
    // intersected with the caller's own reach. It is re-validated immediately
    // below; nothing is trusted from this read.
    const requestedDimension = url.searchParams.get("dimension")
    const scopeParams = isScopeKeyedDimension(requestedDimension)
      ? applyEntityKeys(url.searchParams, requestedDimension)
      : url.searchParams

    const scope = await resolveExecutiveScope(session, scopeParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

    const parsed = parseComparisonRequest(url.searchParams, new Date(), scope.role)
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
    const grain = resolveGrain(parsed.dimension, parsed.metric, { lineScoped: isLineScoped(baseFilters) })

    const unitsInScope = metricDefinition.unitSensitive || grain === "line"
      ? await loadUnitsInScope(scope, baseFilters)
      : []
    const unitResolution = resolveQuantityUnit(unitsInScope, parsed.requestedUnit)

    // A unit-sensitive metric is refused across mixed units rather than
    // producing a total of incompatible things.
    if (metricDefinition.unitSensitive && unitResolution.conflict) {
      return NextResponse.json({
        dimension: parsed.dimension,
        metric: parsed.metric,
        chart: parsed.chart,
        mode: chartMode(parsed.chart),
        rows: [],
        series: [],
        periods: [],
        chartTypes: chartTypesFor({ dimension: parsed.dimension, metric: parsed.metric, entityCount: 0 }),
        quantityUnit: { selected: null, conflict: true, available: unitResolution.units },
        blocked: {
          reason: "unit-conflict",
          message: `${metricDefinition.label} cannot be totalled across ${unitResolution.units.join(", ")}. Choose one unit of measure, or narrow the selection to products sharing one.`,
        },
      })
    }

    const filters: ExecutiveFilters = { ...baseFilters, unit: unitResolution.unit }
    const { previousStart, previousEnd } = previousWindow(parsed.startDate, parsed.endDate)

    // The price drilldown: one product, one unit, branch against branch.
    const drilldownProductId = Number(url.searchParams.get("priceProductId"))
    if (Number.isInteger(drilldownProductId) && drilldownProductId > 0) {
      return NextResponse.json(await priceDrilldown(scope, filters, drilldownProductId, unitResolution.unit))
    }

    const mode = chartMode(parsed.chart)

    if (mode === "series") {
      const { periods, series } = await loadEntitySeries(
        scope, filters, parsed.dimension, parsed.metric, Math.min(parsed.limit, 8),
      )
      return NextResponse.json({
        ...describeRequest(parsed, grain, unitResolution),
        mode,
        periods,
        series,
        rows: [],
        chartTypes: chartTypesFor({ dimension: parsed.dimension, metric: parsed.metric, entityCount: series.length }),
      })
    }

    const [rows, previousRows] = await Promise.all([
      loadComparison(scope, filters, parsed.dimension, parsed.metric, parsed.limit),
      parsed.dimension === "month"
        ? Promise.resolve([])
        : loadComparison(
          scope,
          { ...filters, startDate: previousStart, endDate: previousEnd },
          parsed.dimension,
          parsed.metric,
          parsed.limit,
        ),
    ])

    const previousByKey = new Map(previousRows.map((row) => [row.key, row.value]))
    const enriched = rows.map((row) => ({
      ...row,
      previousValue: previousByKey.get(row.key) ?? 0,
      changePct: growthPct(row.value, previousByKey.get(row.key) ?? 0),
    }))

    // Concentration is only meaningful for an additive measure — a cumulative
    // share of average prices or percentages would be nonsense.
    const concentrationEligible = ["spend", "quantity", "orders", "budgetRemaining"].includes(parsed.metric)

    return NextResponse.json({
      ...describeRequest(parsed, grain, unitResolution),
      mode,
      periods: [],
      series: [],
      rows: concentrationEligible
        ? withCumulativeShare(enriched, (row) => row.value)
        : enriched.map((row) => ({ ...row, share: 0, cumulativeShare: 0 })),
      concentrationEligible,
      chartTypes: chartTypesFor({ dimension: parsed.dimension, metric: parsed.metric, entityCount: rows.length }),
    })
  } catch (error) {
    console.error("Executive analytics comparison failed:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

/** One product, one unit, every branch that bought it: the price comparison. */
async function priceDrilldown(
  scope: Awaited<ReturnType<typeof resolveExecutiveScope>> & { ok: true },
  filters: ExecutiveFilters,
  productId: number,
  unit: string | null,
) {
  const rows = await loadProductPriceByBranch(scope, filters, productId, unit)
  const unitsPresent = Array.from(new Set(rows.map((row) => row.unit)))
  return {
    dimension: "branch",
    metric: "avgUnitPrice",
    productId,
    rows,
    quantityUnit: { selected: unit, conflict: unitsPresent.length > 1, available: unitsPresent },
    comparable: rows.length > 1,
    message: rows.length > 1
      ? null
      : "Price comparison requires purchases of this product from at least two branches in the selected period.",
  }
}

function describeRequest(
  parsed: { dimension: any; metric: any; chart: any; startDate: Date; endDate: Date },
  grain: string,
  unitResolution: { unit: string | null; conflict: boolean; units: string[] },
) {
  const { previousStart, previousEnd } = previousWindow(parsed.startDate, parsed.endDate)
  const metricDefinition = EXECUTIVE_METRICS[parsed.metric as keyof typeof EXECUTIVE_METRICS]
  return {
    dimension: parsed.dimension,
    metric: parsed.metric,
    chart: parsed.chart,
    grain,
    format: metricDefinition.format,
    label: metricDefinition.label,
    formula: metricDefinition.formula,
    period: {
      startDate: parsed.startDate.toISOString(),
      endDate: parsed.endDate.toISOString(),
      previousStartDate: previousStart.toISOString(),
      previousEndDate: previousEnd.toISOString(),
    },
    quantityUnit: {
      selected: unitResolution.unit,
      conflict: unitResolution.conflict,
      available: unitResolution.units,
    },
  }
}
