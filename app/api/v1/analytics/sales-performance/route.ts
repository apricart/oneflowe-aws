import { NextRequest } from "next/server"
import { and,count,desc,eq,gte,inArray,isNull,lte,ne,or,sql } from "drizzle-orm"
import { requireApiRole,ok,error } from "@/lib/api"
import { db } from "@/lib/db"
import { orders,branches,organizations,orderItems,refunds,refundItems,roles,users } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { getCached,generateCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"
import { isMultiBranchAnalyticsRole,resolveMultiBranchAnalyticsIds } from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"
import { deliveredTotalCountExpression } from "@/lib/server/order-delivery-status-sql"
import { isViewerRole,resolveViewerBranchIds,resolveViewerScope } from "@/lib/viewer-access"

// GROUP_USER reads the same dashboard as an administrator, but over the branch
// set assigned to it rather than a tenant or a single branch. It is resolved
// separately below and never through the ladder the other roles use, so their
// behaviour is untouched.
const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "VIEWER"] as const
type Role = typeof allowedRoles[number]
type SalesGranularity = "hourly" | "daily" | "monthly" | "yearly"

const dashboardStatusMetricSelection = {
    pendingCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
    approvedCount: metricExpressions.approvedCount,
    fulfilledCount: metricExpressions.fulfilledCount,
    partialCount: metricExpressions.partialCount,
    refundedCount: metricExpressions.refundedCount,
    rejectedCount: metricExpressions.rejectedCount,
    deliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
    notDeliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
    // Delivered at any order status, which `deliveredCount` above is not — that
    // one is the narrower approved-and-delivered bucket the three existing
    // dashboards print as "Delivered/Unacknowledged". Added for the Viewer
    // dashboard, which reports both; the older field is untouched so its
    // readers do not move. See `lib/order-delivery-status.ts`.
    deliveredTotalCount: deliveredTotalCountExpression,
    pendingAmountCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN ${orders.totalCents} ELSE 0 END), 0)`.mapWith(Number),
    approvedAmountCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) = 'APPROVED' THEN GREATEST(${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0), 0) ELSE 0 END), 0)`.mapWith(Number),
    valueFulfilledCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN GREATEST(${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0), 0) ELSE 0 END), 0)`.mapWith(Number),
    valueRefundedCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN COALESCE(${orders.refundAmountCents}, 0) ELSE 0 END), 0)`.mapWith(Number),
    valueRejectedCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN ${orders.totalCents} ELSE 0 END), 0)`.mapWith(Number),
}

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && isValid(number)) : []
}

/** An organization/branch pair, or the refusal to send back instead. */
type ResolvedSalesScope = {
    organizationId?: number | null
    branchId?: number | null
    error?: string
}

async function resolveSalesScope(role: Role | undefined, scope: any, searchParams: URLSearchParams): Promise<ResolvedSalesScope> {
    if (role === "BRANCH_ADMIN") {
        return { organizationId: scope?.organizationId ?? null, branchId: scope?.branchId ?? null }
    }
    // Read-only account: its organization is always the session's, and its
    // branch is the session's whenever it is pinned to one — so a pinned Viewer
    // naming a sibling branch on the query string still reads its own. An
    // unpinned Viewer's requested branch is verified against the tenant below,
    // by the same path Head Office takes.
    if (isViewerRole(role)) {
        const viewerScope = resolveViewerScope({
            organizationId: scope?.organizationId,
            branchId: scope?.branchId,
            requestedBranchId: Number(searchParams.get("branchId")) || null,
        })
        if (viewerScope.error) return { error: viewerScope.error }
        if (!viewerScope.branchId || scope?.branchId) return viewerScope
        return verifyBranchInOrganization(viewerScope.organizationId, viewerScope.branchId)
    }
    // The branch filter for a multi-branch role comes from its assignments, not
    // from the request; it is applied by the caller as an explicit branch list.
    if (isMultiBranchAnalyticsRole(role)) {
        return { organizationId: scope?.organizationId ?? null, branchId: null }
    }
    if (role === "SUPER_ADMIN") {
        return {
            organizationId: Number(searchParams.get("organizationId")) || null,
            branchId: Number(searchParams.get("branchId")) || null,
        }
    }
    if (role !== "HEAD_OFFICE") return { error: "Access denied: Invalid user role" }
    const organizationId = scope?.organizationId ?? null
    const branchId = Number(searchParams.get("branchId")) || null
    if (!branchId) return { organizationId, branchId: null }
    return verifyBranchInOrganization(organizationId, branchId)
}

/**
 * A requested branch, confirmed to belong to the caller's own tenant. Shared by
 * Head Office and by an unpinned Viewer, which get the same treatment: the
 * organization comes from the session, and the branch on the query string is
 * only honoured once it is shown to be inside it.
 */
async function verifyBranchInOrganization(
    organizationId: number | null,
    branchId: number,
): Promise<ResolvedSalesScope> {
    // A caller with no tenant of its own cannot own a branch either. Refused
    // here rather than comparing against NULL in SQL, which matches nothing and
    // reached the same refusal a row later.
    if (!organizationId) return { error: "Access denied: Branch not found in your organization" }
    try {
        const [allowedBranch] = await db.select({ id: branches.id }).from(branches).where(and(
            eq(branches.id, branchId),
            eq(branches.organizationId, organizationId),
        )).limit(1)
        return allowedBranch
            ? { organizationId, branchId }
            : { error: "Access denied: Branch not found in your organization" }
    } catch (caughtError) {
        console.error("[Security] Error verifying branch access:", caughtError)
        return { error: "Access verification failed" }
    }
}

function resolveSalesGranularity(
    forced: string | null,
    months: number[],
    years: number[],
    differenceInDays: number,
): SalesGranularity {
    if (["hourly", "daily", "monthly", "yearly"].includes(forced || "")) {
        return forced as "hourly" | "daily" | "monthly" | "yearly"
    }
    if (months.length > 0) {
        return months.length > 1 || years.length > 1 ? "monthly" : "daily"
    }
    if (years.length > 0) {
        return years.length > 1 ? "yearly" : "monthly"
    }
    if (differenceInDays <= 1) return "hourly"
    if (differenceInDays <= 32) return "daily"
    if (differenceInDays <= 400) return "monthly"
    return "yearly"
}

function addSalesStatusCondition(conditions: any[], status: string | undefined) {
    if (!status || status === "ALL") return
    if (status === "REJECTED") {
        conditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
    } else if (status === "FULFILLED") {
        conditions.push(inArray(sql`UPPER(${orders.status})`, ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"]))
    } else if (status === "DELIVERED") {
        conditions.push(eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED"))
    } else if (status === "NOT_DELIVERED") {
        conditions.push(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`)
    } else {
        conditions.push(eq(sql`UPPER(${orders.status})`, status))
    }
}

function addSalesScopeConditions(conditions: any[], scope: any) {
    if (scope.organizationIds.length > 0) conditions.push(inArray(orders.organizationId, scope.organizationIds))
    else if (scope.organizationId) conditions.push(eq(orders.organizationId, scope.organizationId))
    if (scope.branchIds.length > 0) conditions.push(inArray(orders.branchId, scope.branchIds))
    else if (scope.branchId) conditions.push(eq(orders.branchId, scope.branchId))
    if (scope.groupIds.length > 0) conditions.push(inArray(branches.groupId, scope.groupIds))
    else if (scope.groupId) conditions.push(eq(branches.groupId, scope.groupId))
}

function getSalesDateExpressions(granularity: "hourly" | "daily" | "monthly" | "yearly") {
    if (granularity === "hourly") return {
        date: sql`date_trunc('hour', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`,
        label: sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'HH12:MI AM')`,
    }
    if (granularity === "daily") return {
        date: sql`date_trunc('day', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`,
        label: sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'DD Mon')`,
    }
    if (granularity === "monthly") return {
        date: sql`date_trunc('month', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`,
        label: sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'Mon YYYY')`,
    }
    return {
        date: sql`date_trunc('year', (${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`,
        label: sql<string>`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`,
    }
}

function buildSalesConditions(context: any, includeStatus = true) {
    const conditions: any[] = []
    const dashboardCreatedAt = sql`(${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`
    if (context.months.length === 0 && context.years.length === 0) {
        conditions.push(gte(orders.createdAt, context.startDate), lte(orders.createdAt, context.endDate))
    }
    if (context.months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${dashboardCreatedAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    }
    if (context.years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${dashboardCreatedAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    }
    if (includeStatus) addSalesStatusCondition(conditions, context.status)
    addSalesScopeConditions(conditions, context)
    return conditions
}

async function loadSalesSeries(whereClause: any, dateExpr: any, labelExpr: any) {
    const eligible = sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`
    const [seriesRows, quantityRows, refundRows] = await Promise.all([
        db.select({
            bucket: dateExpr,
            label: labelExpr,
            totalSales: metricExpressions.revenue,
            netSales: metricExpressions.revenue,
            orderCount: sql<number>`COALESCE(COUNT(1), 0)`.mapWith(Number),
        }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause)
            .groupBy(dateExpr, labelExpr).orderBy(dateExpr),
        db.select({
            label: labelExpr,
            grossQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${eligible} THEN COALESCE(${orderItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
        }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(orderItems, eq(orderItems.orderId, orders.id)).where(whereClause)
            .groupBy(dateExpr, labelExpr).orderBy(dateExpr),
        db.select({
            label: labelExpr,
            refundedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${eligible} THEN COALESCE(${refundItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
        }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(refunds, and(eq(refunds.orderId, orders.id), eq(sql`UPPER(${refunds.status})`, "APPROVED")))
            .leftJoin(refundItems, eq(refundItems.refundId, refunds.id)).where(whereClause)
            .groupBy(dateExpr, labelExpr).orderBy(dateExpr),
    ])
    const quantities = new Map(quantityRows.map((row) => [String(row.label), Number(row.grossQuantity || 0)]))
    const refunded = new Map(refundRows.map((row) => [String(row.label), Number(row.refundedQuantity || 0)]))
    return seriesRows.map((row) => ({
        label: row.label,
        sales: (row.totalSales || 0) / 100,
        netSales: (row.netSales || 0) / 100,
        orders: Number(row.orderCount || 0),
        itemQuantity: Math.max(0, (quantities.get(String(row.label)) || 0) - (refunded.get(String(row.label)) || 0)),
    }))
}

function summarizeSalesSeries(seriesData: any[]) {
    const totalSales = seriesData.reduce((sum, row) => sum + row.sales, 0)
    const totalNetSales = seriesData.reduce((sum, row) => sum + row.netSales, 0)
    const totalOrders = seriesData.reduce((sum, row) => sum + row.orders, 0)
    const totalItemsSold = seriesData.reduce((sum, row) => sum + row.itemQuantity, 0)
    const activePeriods = seriesData.filter((row) => row.sales > 0)
    const activeQuantityPeriods = seriesData.filter((row) => row.itemQuantity > 0)
    return {
        totalSales,
        totalNetSales,
        totalOrders,
        totalItemsSold,
        avgSales: activePeriods.length > 0 ? totalSales / activePeriods.length : 0,
        avgItemsSold: activeQuantityPeriods.length > 0 ? totalItemsSold / activeQuantityPeriods.length : 0,
        peakPeriod: seriesData.length > 0 ? seriesData.reduce((max, row) => row.sales > max.sales ? row : max, seriesData[0]) : null,
        peakQuantityPeriod: seriesData.length > 0 ? seriesData.reduce((max, row) => row.itemQuantity > max.itemQuantity ? row : max, seriesData[0]) : null,
    }
}

function buildComparisonDateConditions(context: any) {
    const conditions: any[] = []
    const dashboardCreatedAt = sql`(${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`
    if (context.months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${dashboardCreatedAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    }
    if (context.years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${dashboardCreatedAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    }
    if (context.months.length > 0 || context.years.length > 0) return conditions

    if (context.explicitStart && context.explicitEnd) {
        const start = parseStartDateParam(context.explicitStart) || new Date(context.explicitStart)
        const end = parseEndDateParam(context.explicitEnd) || new Date(context.explicitEnd)
        conditions.push(gte(orders.createdAt, start), lte(orders.createdAt, end))
    } else if (context.primaryMonths.length === 0 && context.primaryYears.length === 0) {
        const duration = context.primaryEnd.getTime() - context.primaryStart.getTime()
        conditions.push(
            gte(orders.createdAt, new Date(context.primaryStart.getTime() - duration - 1)),
            lte(orders.createdAt, new Date(context.primaryStart.getTime() - 1)),
        )
    }
    return conditions
}

function addComparisonStatusCondition(conditions: any[], status: string | undefined) {
    if (!status || status === "ALL") return
    if (status === "REJECTED") {
        conditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
    } else if (status === "DELIVERED") {
        conditions.push(eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED"))
    } else if (status === "NOT_DELIVERED") {
        conditions.push(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`)
    } else {
        conditions.push(eq(sql`UPPER(${orders.status})`, status))
    }
}

function buildComparisonConditions(context: any) {
    const dateConditions = buildComparisonDateConditions(context)
    const filtered = [...dateConditions]
    const allStatuses = [...dateConditions]
    addComparisonStatusCondition(filtered, context.status)
    addSalesScopeConditions(filtered, context)
    addSalesScopeConditions(allStatuses, context)
    return { filtered, allStatuses }
}

async function loadComparisonStatusCounts(whereClause: any) {
    const [counts] = await db.select({
        ...dashboardStatusMetricSelection,
        fulfilledNetSales: metricExpressions.revenue,
    }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause)
    return counts
}

async function loadScopedUserCount(context: {
    organizationIds: number[]
    organizationId: number | null
    branchIds: number[]
    branchId: number | null
    groupIds: number[]
    groupId: number | null
}) {
    const conditions: any[] = [
        isNull(users.deletedAt),
        ne(roles.name, "SUPER_ADMIN"),
    ]
    if (context.organizationIds.length > 0) conditions.push(inArray(users.organizationId, context.organizationIds))
    else if (context.organizationId) conditions.push(eq(users.organizationId, context.organizationId))
    if (context.branchIds.length > 0) conditions.push(inArray(users.branchId, context.branchIds))
    else if (context.branchId) conditions.push(eq(users.branchId, context.branchId))
    if (context.groupIds.length > 0) conditions.push(inArray(branches.groupId, context.groupIds))
    else if (context.groupId) conditions.push(eq(branches.groupId, context.groupId))

    const [result] = await db.select({ totalUsers: count(users.id) })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .leftJoin(branches, eq(users.branchId, branches.id))
        .where(and(...conditions))
    return Number(result?.totalUsers || 0)
}

async function loadScopedBranchCount(context: {
    organizationIds: number[]
    organizationId: number | null
    branchIds: number[]
    branchId: number | null
    groupIds: number[]
    groupId: number | null
}) {
    const conditions: any[] = []
    if (context.organizationIds.length > 0) conditions.push(inArray(branches.organizationId, context.organizationIds))
    else if (context.organizationId) conditions.push(eq(branches.organizationId, context.organizationId))
    if (context.branchIds.length > 0) conditions.push(inArray(branches.id, context.branchIds))
    else if (context.branchId) conditions.push(eq(branches.id, context.branchId))
    if (context.groupIds.length > 0) conditions.push(inArray(branches.groupId, context.groupIds))
    else if (context.groupId) conditions.push(eq(branches.groupId, context.groupId))

    const [result] = await db.select({ totalBranches: count(branches.id) })
        .from(branches)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
    return Number(result?.totalBranches || 0)
}

async function loadSalesComparison(context: any) {
    if (!context.enabled) return null
    const { filtered, allStatuses } = buildComparisonConditions(context)
    const seriesData = await loadSalesSeries(and(...filtered), context.dateExpression, context.labelExpression)
    const summary = summarizeSalesSeries(seriesData)
    const counts = await loadComparisonStatusCounts(and(...allStatuses))
    return {
        totalSales: summary.totalSales,
        totalNetSales: summary.totalNetSales,
        totalOrders: summary.totalOrders,
        totalItemsSold: summary.totalItemsSold,
        fulfilledCount: counts?.fulfilledCount || 0,
        partialCount: counts?.partialCount || 0,
        fulfilledNetSales: (counts?.fulfilledNetSales || 0) / 100,
        refundedCount: counts?.refundedCount || 0,
        rejectedCount: counts?.rejectedCount || 0,
        approvedCount: counts?.approvedCount || 0,
        pendingCount: counts?.pendingCount || 0,
        deliveredCount: counts?.deliveredCount || 0,
        notDeliveredCount: counts?.notDeliveredCount || 0,
        deliveredTotalCount: counts?.deliveredTotalCount || 0,
        pendingAmountCents: counts?.pendingAmountCents || 0,
        approvedAmountCents: counts?.approvedAmountCents || 0,
        valueFulfilledCents: counts?.valueFulfilledCents || 0,
        valueRefundedCents: counts?.valueRefundedCents || 0,
        valueRejectedCents: counts?.valueRejectedCents || 0,
        seriesData,
    }
}

export async function GET(req: NextRequest) {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    const scope = await getRequestScope()
    const role = scope?.role as Role | undefined

    const { searchParams } = new URL(req.url)
    const branchIdsParam = searchParams.get("branchIds") // comma-separated
    const organizationIdsParam = searchParams.get("organizationIds") // comma-separated
    const groupIdParam = searchParams.get("groupId")
    const groupIdsParam = searchParams.get("groupIds")
    const statusParam = searchParams.get("status") // PENDING | FULFILLED | REFUNDED | all
    const startDateParam = searchParams.get("startDate")
    const endDateParam = searchParams.get("endDate")
    const compareStartDateParam = searchParams.get("compareStartDate")
    const compareEndDateParam = searchParams.get("compareEndDate")

    const monthsRaw = searchParams.get("months")
    const yearsRaw = searchParams.get("years")
    const parsedMonths = parseNumberList(monthsRaw, (number) => number >= 1 && number <= 12)
    const parsedYears = parseNumberList(yearsRaw, (number) => number > 2000)
    const parsedCompMonths = parseNumberList(searchParams.get("compareMonths"), (number) => number >= 1 && number <= 12)
    const parsedCompYears = parseNumberList(searchParams.get("compareYears"), (number) => number > 2000)
    const includeStatusCounts = searchParams.get("includeStatusCounts") === "true"

    let groupId: number | null = null
    const resolvedScope = await resolveSalesScope(role, scope, searchParams)
    if (resolvedScope.error) return error(resolvedScope.error)
    const organizationId = resolvedScope.organizationId ?? null
    const branchId = resolvedScope.branchId ?? null
    const pricesHidden = await shouldHidePricesForRole(role, scope?.organizationId)

    // A multi-branch role never chooses its own scope: the assignments are read
    // on the server and a requested branch list can only narrow them. An empty
    // result is a refusal — it must never fall through to the tenant-wide query
    // the ladder below would otherwise run.
    const assignedBranchIds = await loadAnalyticsAssignedBranchIds(role, scope?.userId)
    const scopedBranchIds = assignedBranchIds === null
        ? null
        : resolveMultiBranchAnalyticsIds({
            role: role as string,
            assignedBranchIds,
            requestedBranchIds: parseNumberList(branchIdsParam),
        }) ?? []
    if (scopedBranchIds !== null && scopedBranchIds.length === 0) {
        return error("Access denied: no branches are assigned to your account", 403)
    }

    // A pinned Viewer collapses to its own branch whatever `branchIds` asked
    // for; an unpinned one may narrow within its own tenant, which the
    // organization predicate below fences.
    const viewerBranchIds = isViewerRole(role)
        ? resolveViewerBranchIds({
            branchId: scope?.branchId,
            requestedBranchIds: parseNumberList(branchIdsParam),
        })
        : null

    const branchIds = viewerBranchIds ?? scopedBranchIds ?? parseNumberList(branchIdsParam)
    // The tenant is re-asserted from the session for a multi-branch role and
    // for a Viewer, rather than read from the request: `organizationIds` on the
    // query string takes precedence over the session's organization in
    // `addSalesScopeConditions`, so a read-only account must never reach it.
    const organizationIds = scopedBranchIds === null && !isViewerRole(role)
        ? parseNumberList(organizationIdsParam)
        : []

    if (groupIdParam && groupIdParam !== "null" && groupIdParam !== "0") {
        groupId = Number(groupIdParam)
    }

    let groupIds: number[] = []
    if (groupIdsParam) {
        groupIds = parseNumberList(groupIdsParam)
    } else if (groupId) {
        groupIds = [groupId]
    }

    // Date range - default to today
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(now)
    todayEnd.setHours(23, 59, 59, 999)

    const startDate = parseStartDateParam(startDateParam) || todayStart
    const endDate = parseEndDateParam(endDateParam) || todayEnd

    // Determine granularity for series: hourly for 1 day, daily for ≤32 days, monthly for ≤400 days, yearly for more
    const diffMs = endDate.getTime() - startDate.getTime()
    const diffDays = diffMs / (1000 * 60 * 60 * 24)
    
    const granularity = resolveSalesGranularity(searchParams.get("granularity"), parsedMonths, parsedYears, diffDays)

    const cacheKey = generateCacheKey("sales-perf", {
        role, organizationId, branchId,
        branchIds: branchIds.join(","),
        organizationIds: organizationIds.join(","),
        groupIds: groupIds.join(","),
        status: statusParam,
        start: startDate.toISOString().slice(0, 16),
        end: endDate.toISOString().slice(0, 16),
        compareStart: compareStartDateParam || "",
        compareEnd: compareEndDateParam || "",
        months: parsedMonths.join(","),
        years: parsedYears.join(","),
        compareMonths: parsedCompMonths.join(","),
        compareYears: parsedCompYears.join(","),
        granularity,
        includeStatusCounts: includeStatusCounts ? "1" : "0",
        pricesHidden,
    })

    const fetchData = async () => {
        const upperStatus = statusParam?.toUpperCase()
        const salesContext = {
            organizationIds,
            organizationId,
            branchIds,
            branchId,
            groupIds,
            groupId,
            months: parsedMonths,
            years: parsedYears,
            startDate,
            endDate,
            status: upperStatus,
        }
        const conditions = buildSalesConditions(salesContext)

        const whereClause = and(...conditions)
        const revenueEligibleStatus = sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`

        // ── Series data ──
        const { date: dateExpr, label: labelExpr } = getSalesDateExpressions(granularity)

        const {
            seriesData,
            totalSales,
            totalNetSales,
            totalOrders,
            totalItemsSold,
            avgSales,
            avgItemsSold,
            peakPeriod,
            peakQuantityPeriod,
        } = await (async () => {
        const seriesRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                totalSales: metricExpressions.revenue,
                netSales: metricExpressions.revenue,
                orderCount: sql<number>`COALESCE(COUNT(1), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const seriesQuantityRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                grossQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${orderItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const seriesRefundQuantityRows = await db
            .select({
                bucket: dateExpr,
                label: labelExpr,
                refundedQuantity: sql<number>`COALESCE(SUM(CASE WHEN ${revenueEligibleStatus} THEN COALESCE(${refundItems.quantity}, 0) ELSE 0 END), 0)`.mapWith(Number),
            })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(refunds, and(eq(refunds.orderId, orders.id), eq(sql`UPPER(${refunds.status})`, "APPROVED")))
            .leftJoin(refundItems, eq(refundItems.refundId, refunds.id))
            .where(whereClause)
            .groupBy(dateExpr, labelExpr)
            .orderBy(dateExpr)

        const grossQuantityByLabel = new Map(seriesQuantityRows.map((r) => [String(r.label), Number(r.grossQuantity || 0)]))
        const refundedQuantityByLabel = new Map(seriesRefundQuantityRows.map((r) => [String(r.label), Number(r.refundedQuantity || 0)]))

        const seriesData = seriesRows.map(r => ({
            label: r.label,
            sales: (r.totalSales || 0) / 100,
            netSales: (r.netSales || 0) / 100,
            orders: Number(r.orderCount || 0),
            itemQuantity: Math.max(0, (grossQuantityByLabel.get(String(r.label)) || 0) - (refundedQuantityByLabel.get(String(r.label)) || 0)),
        }))

        // ── Aggregates ──
        const totalSales = seriesData.reduce((s, r) => s + r.sales, 0)
        const totalNetSales = seriesData.reduce((s, r) => s + r.netSales, 0)
        const totalOrders = seriesData.reduce((s, r) => s + r.orders, 0)
        const totalItemsSold = seriesData.reduce((s, r) => s + r.itemQuantity, 0)
        const activePeriods = seriesData.filter(r => r.sales > 0)
        const activeQuantityPeriods = seriesData.filter(r => r.itemQuantity > 0)
        const avgSales = activePeriods.length > 0 ? totalSales / activePeriods.length : 0
        const avgItemsSold = activeQuantityPeriods.length > 0 ? totalItemsSold / activeQuantityPeriods.length : 0

        const peakPeriod = (() => {
          if (seriesData.length > 0) {
            return seriesData.reduce((max, r) => r.sales > max.sales ? r : max, seriesData[0])
          }
          return null
        })()
        const peakQuantityPeriod = (() => {
          if (seriesData.length > 0) {
            return seriesData.reduce((max, r) => r.itemQuantity > max.itemQuantity ? r : max, seriesData[0])
          }
          return null
        })()
        return {
            seriesData,
            totalSales,
            totalNetSales,
            totalOrders,
            totalItemsSold,
            avgSales,
            avgItemsSold,
            peakPeriod,
            peakQuantityPeriod,
        }
        })()

        // ── Branch breakdown ──
        const branchSales = await (async () => {
        const branchConditions: any[] = [...conditions] // Apply primary date matrices 
        
        if (statusParam && statusParam !== "all") {
            branchConditions.push(sql`UPPER(${orders.status}) = ${statusParam.toUpperCase()}`)
        } else {
            branchConditions.push(
                sql`UPPER(${orders.status}) IN ('APPROVED', 'FULFILLED', 'REFUNDED', 'PENDING', 'REJECTED', 'CANCELLED')`
            )
        }
        
        if (organizationIds.length > 0) {
            branchConditions.push(inArray(orders.organizationId, organizationIds))
        } else if (organizationId) {
            branchConditions.push(eq(orders.organizationId, organizationId))
        }
        if (branchIds.length > 0) {
            branchConditions.push(inArray(orders.branchId, branchIds))
        } else if (branchId) {
            branchConditions.push(eq(orders.branchId, branchId))
        }
        if (groupIds.length > 0) {
            branchConditions.push(inArray(branches.groupId, groupIds))
        } else if (groupId) {
            branchConditions.push(eq(branches.groupId, groupId))
        }

        let branchQuery = db
            .select({
                branchId: branches.id,
                branchName: branches.name,
                totalSales: metricExpressions.revenue,
                totalNetSales: metricExpressions.revenue,
                orderCount: sql<number>`COALESCE(COUNT(${orders.id}), 0)`.mapWith(Number),
            })
            .from(branches)
            .leftJoin(orders, and(eq(orders.branchId, branches.id), and(...branchConditions)))

        // The breakdown selects from `branches`, so its own filter decides which
        // branches are named at all — the order conditions above only decide
        // their totals. A multi-branch role is therefore narrowed to its
        // assigned branches here as well; every other role keeps the
        // tenant-wide list it already had.
        const branchListConditions: any[] = []
        if (organizationIds.length > 0) {
            branchListConditions.push(inArray(branches.organizationId, organizationIds))
        } else if (organizationId) {
            branchListConditions.push(eq(branches.organizationId, organizationId))
        }
        if (scopedBranchIds !== null) {
            branchListConditions.push(inArray(branches.id, scopedBranchIds))
        }
        // A pinned Viewer reads its own branch alone, so the breakdown names
        // no sibling either (`tests/integration/viewer-isolation-sweep.test.ts`).
        if (viewerBranchIds && viewerBranchIds.length > 0) {
            branchListConditions.push(inArray(branches.id, viewerBranchIds))
        }
        if (branchListConditions.length > 0) {
            branchQuery = branchQuery.where(and(...branchListConditions)) as any
        }

        const branchRows = await branchQuery
            .groupBy(branches.id, branches.name)
            .orderBy(desc(metricExpressions.revenue))
            .limit(20)

        return branchRows.map(r => ({
            branchId: r.branchId,
            branchName: r.branchName || "Unnamed",
            sales: (r.totalSales || 0) / 100,
            netSales: (r.totalNetSales || 0) / 100,
            orders: Number(r.orderCount || 0),
        }))
        })()

        // ── Organization breakdown (Super Admin only, when no org is selected) ──
        const organizationSales = await (async () => {
        if (role === "SUPER_ADMIN" && !organizationId) {
            const orgRows = await db
                .select({
                    organizationId: organizations.id,
                    organizationName: organizations.name,
                    totalSales: metricExpressions.revenue,
                    totalNetSales: metricExpressions.revenue,
                    orderCount: sql<number>`COALESCE(COUNT(${orders.id}), 0)`.mapWith(Number),
                })
                .from(organizations)
                .leftJoin(orders, and(eq(orders.organizationId, organizations.id), whereClause))
                .groupBy(organizations.id, organizations.name)
                .orderBy(desc(metricExpressions.revenue))
                .limit(20)

            return orgRows.map(r => ({
                organizationId: r.organizationId,
                organizationName: r.organizationName || "Unnamed",
                sales: (r.totalSales || 0) / 100,
                netSales: (r.totalNetSales || 0) / 100,
                orders: Number(r.orderCount || 0),
            }))
        }
        return []
        })()

        // ── Comparison Logic ──
        const comparison = await loadSalesComparison({
            enabled: searchParams.get("compare") === "true" && Boolean(startDate || compareStartDateParam || parsedCompMonths.length > 0 || parsedCompYears.length > 0),
            months: parsedCompMonths,
            years: parsedCompYears,
            explicitStart: compareStartDateParam,
            explicitEnd: compareEndDateParam,
            primaryStart: startDate,
            primaryEnd: endDate,
            primaryMonths: parsedMonths,
            primaryYears: parsedYears,
            status: upperStatus,
            organizationIds,
            organizationId,
            branchIds,
            branchId,
            groupIds,
            groupId,
            dateExpression: dateExpr,
            labelExpression: labelExpr,
        })

        // ── Status counts (single query, replaces 6 separate per-status API calls) ──
        const statusCounts = await (async (): Promise<{
            pendingCount: number
            approvedCount: number
            fulfilledCount: number
            partialCount: number
            refundedCount: number
            rejectedCount: number
            deliveredCount: number
            notDeliveredCount: number
            deliveredTotalCount: number
            pendingAmountCents: number
            approvedAmountCents: number
            valueFulfilledCents: number
            valueRefundedCents: number
            valueRejectedCents: number
        } | null> => {

        if (includeStatusCounts && (!statusParam || statusParam.toUpperCase() === "ALL")) {
            const [counts] = await db.select(dashboardStatusMetricSelection)
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .where(whereClause)

            if (counts) {
                return {
                    pendingCount: counts.pendingCount,
                    approvedCount: counts.approvedCount,
                    fulfilledCount: counts.fulfilledCount,
                    partialCount: counts.partialCount,
                    refundedCount: counts.refundedCount,
                    rejectedCount: counts.rejectedCount,
                    deliveredCount: counts.deliveredCount,
                    notDeliveredCount: counts.notDeliveredCount,
                    deliveredTotalCount: counts.deliveredTotalCount,
                    pendingAmountCents: counts.pendingAmountCents,
                    approvedAmountCents: counts.approvedAmountCents,
                    valueFulfilledCents: counts.valueFulfilledCents,
                    valueRefundedCents: counts.valueRefundedCents,
                    valueRejectedCents: counts.valueRejectedCents,
                }
            }
        }
        return null
        })()

        const metricScope = { organizationIds, organizationId, branchIds, branchId, groupIds, groupId }
        const [totalUsers, totalBranches] = includeStatusCounts
            ? await Promise.all([
                loadScopedUserCount(metricScope),
                loadScopedBranchCount(metricScope),
            ])
            : [undefined, undefined]

        return {
            granularity,
            seriesData,
            totalSales,
            totalNetSales,
            totalOrders,
            totalItemsSold,
            avgItemsSold,
            avgSales,
            peakPeriod,
            peakQuantityPeriod,
            branchSales,
            organizationSales,
            comparison,
            statusCounts,
            totalUsers,
            totalBranches,
        }
    }

    const data = await getCached(cacheKey, fetchData, CACHE_TTL.ANALYTICS)
    return ok(pricesHidden ? redactAnalyticsPrices({ ...data, pricesHidden }) : { ...data, pricesHidden })
}
