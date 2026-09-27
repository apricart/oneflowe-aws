import { categories, globalProducts, orderItems, orders, refundItems, refunds } from "@/db/schema"
import { authOptions } from "@/lib/auth-options"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { db } from "@/lib/db"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import {
  buildConsumptionTrend,
  CONSUMPTION_TREND_MAX_MONTHS,
  CONSUMPTION_TREND_MAX_SERIES,
  parseConsumptionTrendSeriesLimit,
  productTrendMonthKey,
  resolveTrendMonths,
  type ConsumptionTrendRow,
} from "@/lib/product-consumption-trend"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  isBranchScopedAnalyticsRole,
  normalizePositiveIds,
  parseRequestedOrganizationIds,
  resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"
import { resolveProductBranches } from "@/lib/server/product-analytics-scope"
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import { getServerSession } from "next-auth"
import { NextResponse, type NextRequest } from "next/server"

/**
 * Quantity consumed, by month, one line per product.
 *
 * The bar chart beside this one on the Product Intelligence screen answers
 * *how much*; this answers *when*, which is the question a reader asks next and
 * could not previously ask at all.
 *
 * It is its own route rather than a field on `/analytics/products/performance`
 * for three reasons recorded in `plans/OF-PRODUCT-monthly-consumption-trend.md`:
 * that route is read four times per page load and none of those callers want a
 * product × month matrix; this one carries a filter (category) and two bounds
 * (series, months) the other has no use for; and the response shape is
 * different enough that folding it in would make one route answer two
 * questions.
 *
 * The statuses counted are the product report's own, so a figure here can be
 * reconciled against the table below it. Consumption is fulfilled quantity net
 * of approved refunds — a count of units, not the budget module's `spent +
 * held`.
 */
const PERFORMANCE_STATUSES = new Set([
  "FULFILLED",
  "REFUNDED",
  "APPROVED",
  "PARTIAL",
  "PARTIALLY_FULFILLED",
])

function parseIdList(value: string | null, isValid: (candidate: number) => boolean = () => true) {
  if (!value) return []
  return normalizePositiveIds(value.split(",")).filter(isValid)
}

/**
 * Everything the query string is allowed to say, turned into integers and
 * dates before any of it reaches SQL. Nothing here widens the caller's reach —
 * the branch and organization fences are resolved separately, from the session.
 */
function parseTrendRequest(searchParams: URLSearchParams) {
  return {
    months: parseIdList(searchParams.get("months"), (month) => month >= 1 && month <= 12),
    years: parseIdList(searchParams.get("years"), (year) => year > 2000),
    productIds: parseIdList(searchParams.get("productIds")),
    categoryIds: parseIdList(searchParams.get("categoryIds")),
    seriesLimit: parseConsumptionTrendSeriesLimit(searchParams.get("limit")),
    startDate: parseStartDateParam(searchParams.get("startDate")),
    endDate: parseEndDateParam(searchParams.get("endDate")),
  }
}

type TrendRequest = ReturnType<typeof parseTrendRequest>

/**
 * The window predicate.
 *
 * Same precedence as the product routes: an explicit month/year selection
 * replaces the date range rather than intersecting with it, so the two controls
 * can never silently cancel each other out.
 */
function windowConditions({ months, years, startDate, endDate }: TrendRequest) {
  const conditions: any[] = []
  if (months.length > 0 || years.length > 0) {
    if (months.length > 0) {
      conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
      conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    return conditions
  }
  if (startDate) conditions.push(gte(orders.createdAt, startDate))
  if (endDate) conditions.push(lte(orders.createdAt, endDate))
  return conditions
}

/**
 * The products under the selected categories, as a subquery on
 * `order_items.global_product_id`.
 *
 * The filter offers top-level categories while products hang off
 * subcategories, so a literal match on the selected ids matches nothing and
 * the chart silently empties. This is the rule `categoryProductFilter` in
 * `lib/server/executive-analytics-queries.ts` already applies, for the same
 * reason.
 */
function categoryProductFilter(categoryIds: number[]) {
  return inArray(
    orderItems.globalProductId,
    db
      .select({ id: globalProducts.id })
      .from(globalProducts)
      .innerJoin(categories, eq(categories.id, globalProducts.categoryId))
      .where(or(
        inArray(categories.id, categoryIds),
        inArray(categories.parentId, categoryIds),
      )),
  )
}

/**
 * Refunded units per order line, counting only refunds that actually took
 * effect. A requested-but-unapproved refund has removed nothing from the
 * branch and must not reduce what the chart says it consumed.
 */
async function loadRefundQuantities(orderItemIds: number[]) {
  if (orderItemIds.length === 0) return new Map<number, number>()
  const rows = await db
    .select({ orderItemId: refundItems.orderItemId, qty: refundItems.quantity })
    .from(refundItems)
    .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
    .where(and(
      inArray(refundItems.orderItemId, orderItemIds),
      inArray(sql`UPPER(${refunds.status})`, ["APPROVED", "COMPLETED"]),
    ))

  const refunded = new Map<number, number>()
  for (const row of rows) {
    if (!row.orderItemId) continue
    refunded.set(row.orderItemId, (refunded.get(row.orderItemId) || 0) + row.qty)
  }
  return refunded
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const sessionUser = session.user as {
      id?: string
      role?: string
      organizationId?: number
      branchId?: unknown
    }
    // One grouped read plus a refund read per call, over a window bounded to 24
    // months — cheap per call, but an aggregate a caller could otherwise sweep,
    // which is the same reason the executive matrix route is limited.
    const limited = await withRateLimit("search", sessionUser.id)
    if (limited) return limited

    const userRole = (sessionUser.role || "").toUpperCase().replace(/\s+/g, "_")
    const userOrgId = sessionUser.organizationId ?? null
    const url = new URL(req.url)
    const searchParams = url.searchParams

    const organizationIds = resolveAnalyticsOrganizationIds({
      role: userRole,
      userOrganizationId: userOrgId,
      requestedOrganizationIds: parseRequestedOrganizationIds({
        organizationIds: searchParams.get("organizationIds"),
        organizationId: searchParams.get("organizationId"),
      }),
    })

    if (userRole !== "SUPER_ADMIN" && organizationIds.length === 0) {
      return NextResponse.json({ error: "Organization not assigned" }, { status: 403 })
    }

    const groupIds = parseIdList(searchParams.get("groupIds"))
    const branchIds = await resolveProductBranches({
      role: userRole,
      userBranchId: sessionUser.branchId,
      assignedBranchIds: await loadAnalyticsAssignedBranchIds(userRole, sessionUser.id),
      userOrganizationId: userOrgId,
      organizationIds,
      requestedBranchIds: parseIdList(searchParams.get("branchIds")),
      groupIds,
    })

    if (branchIds.length === 0) {
      const status = isBranchScopedAnalyticsRole(userRole) ? 403 : 400
      return NextResponse.json({ error: "No permitted branches resolved" }, { status })
    }

    const request = parseTrendRequest(searchParams)

    const conditions: any[] = [
      inArray(orders.branchId, branchIds),
      sql`UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`,
      ...windowConditions(request),
    ]
    if (request.productIds.length > 0) {
      conditions.push(inArray(orderItems.globalProductId, request.productIds))
    }
    if (request.categoryIds.length > 0) {
      conditions.push(categoryProductFilter(request.categoryIds))
    }

    const lines = await db
      .select({
        orderItemId: orderItems.id,
        productId: orderItems.globalProductId,
        productName: globalProducts.name,
        productCode: globalProducts.productCode,
        status: orders.status,
        createdAt: orders.createdAt,
        qtyOrdered: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
      .where(and(...conditions))

    const refundQuantities = await loadRefundQuantities(lines.map((line) => line.orderItemId))

    const rows: ConsumptionTrendRow[] = lines.map((line) => {
      const counted = PERFORMANCE_STATUSES.has((line.status || "").toUpperCase())
      const refunded = refundQuantities.get(line.orderItemId) || 0
      return {
        productId: line.productId ?? 0,
        productName: line.productName || "Unknown product",
        productCode: line.productCode,
        monthKey: productTrendMonthKey(line.createdAt ?? new Date(0)),
        qtyOrdered: line.qtyOrdered,
        qtyConsumed: counted ? Math.max(0, line.qtyOrdered - refunded) : 0,
      }
    })

    const axis = resolveTrendMonths({
      ...request,
      observedMonths: rows.map((row) => row.monthKey),
    })
    const trend = buildConsumptionTrend(rows, { months: axis, limit: request.seriesLimit })

    return NextResponse.json({
      ...trend,
      // No price is computed or returned here — the chart is a count of units —
      // but the flag travels so the card can label itself the way the rest of
      // the screen does for a price-restricted role.
      pricesHidden: await shouldHidePricesForRole(userRole, userOrgId),
      limits: {
        series: request.seriesLimit,
        maxSeries: CONSUMPTION_TREND_MAX_SERIES,
        maxMonths: CONSUMPTION_TREND_MAX_MONTHS,
      },
    })
  } catch (error) {
    console.error("Product consumption trend request failed: ", error)
    return NextResponse.json({ error: "Failed to fetch consumption trend" }, { status: 500 })
  }
}
