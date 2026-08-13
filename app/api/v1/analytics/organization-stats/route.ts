import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, users, branches, organizations } from "@/db/schema"
import { and, eq, gte, lte, sql, count, inArray, isNull } from "drizzle-orm"
import { metricExpressions } from "@/lib/metric-utils"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { shouldIncludeHeadOfficeUsers } from "@/lib/organization-report-scope"

function parseNumberList(value: string | null, requirePositive = false) {
    return value
        ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && (!requirePositive || number > 0))
        : []
}

function buildBranchConditions(searchParams: URLSearchParams, userRole: string, userOrganizationId: number | null) {
    const conditions: any[] = []
    if (userRole !== "SUPER_ADMIN" && userOrganizationId) {
        conditions.push(eq(branches.organizationId, userOrganizationId))
    }
    const organizationIds = parseNumberList(searchParams.get("organizationIds"))
    const organizationId = searchParams.get("organizationId")
    if (organizationIds.length > 0) {
        conditions.push(inArray(branches.organizationId, organizationIds))
    } else if (organizationId && !["all", "0"].includes(organizationId)) {
        conditions.push(eq(branches.organizationId, Number(organizationId)))
    }
    const branchIds = parseNumberList(searchParams.get("branchIds"))
    const groupIds = parseNumberList(searchParams.get("groupIds"), true)
    if (branchIds.length > 0) conditions.push(inArray(branches.id, branchIds))
    if (groupIds.length > 0) conditions.push(inArray(branches.groupId, groupIds))
    const status = searchParams.get("status")
    if (status && status !== "all") conditions.push(eq(branches.status, status))
    return conditions
}

function addOrderDateConditions(conditions: any[], start: string | null, end: string | null, months: number[], years: number[]) {
    if (months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    if (months.length > 0 || years.length > 0) return
    const startBoundary = parseStartDateParam(start)
    const endBoundary = parseEndDateParam(end)
    if (startBoundary) conditions.push(gte(orders.createdAt, startBoundary))
    if (endBoundary) conditions.push(lte(orders.createdAt, endBoundary))
}

function createOrganizationSummary(branch: any, compare: boolean) {
    return {
        organizationId: branch.organizationId || 0,
        organizationName: branch.organizationName || "Unknown Organization",
        organizationStatus: branch.organizationStatus || "active",
        branchCount: 0,
        activeBranchCount: 0,
        inactiveBranchCount: 0,
        totalUserCount: 0,
        activeUserCount: 0,
        revenue: 0,
        orderCount: 0,
        fulfilledCount: 0,
        refundedCount: 0,
        refundedRevenue: 0,
        comparison: compare ? { revenue: 0, orderCount: 0, fulfilledCount: 0, refundedCount: 0 } : null,
    }
}

function addMetric(summary: any, metric: any) {
    if (!metric) return
    summary.revenue += (metric.revenueCents || 0) / 100
    summary.orderCount += metric.orderCount || 0
    summary.fulfilledCount += metric.fulfilledCount || 0
    summary.refundedCount += metric.refundedCount || 0
    summary.refundedRevenue += (metric.refundedRevenueCents || 0) / 100
}

function addComparisonMetric(summary: any, metric: any) {
    if (!metric || !summary.comparison) return
    summary.comparison.revenue += (metric.revenueCents || 0) / 100
    summary.comparison.orderCount += metric.orderCount || 0
    summary.comparison.fulfilledCount += metric.fulfilledCount || 0
    summary.comparison.refundedCount += metric.refundedCount || 0
}

function aggregateOrganizations(branchStats: any[], metrics: any[], comparisonMetrics: any[], compare: boolean) {
    const organizationMap: Record<number, any> = {}
    branchStats.forEach((branch) => {
        const organizationId = branch.organizationId || 0
        organizationMap[organizationId] ||= createOrganizationSummary(branch, compare)
        const summary = organizationMap[organizationId]
        summary.branchCount++
        summary.activeBranchCount += branch.branchStatus === "active" ? 1 : 0
        summary.inactiveBranchCount += branch.branchStatus === "active" ? 0 : 1
        summary.totalUserCount += branch.totalUserCount
        summary.activeUserCount += branch.activeUserCount
        addMetric(summary, metrics.find((metric) => metric.branchId === branch.branchId))
        addComparisonMetric(summary, comparisonMetrics.find((metric) => metric.branchId === branch.branchId))
    })
    return organizationMap
}

function addHeadOfficeUsers(organizationMap: Record<number, any>, rows: any[]) {
    rows.forEach((row) => {
        if (row.organizationId == null || !organizationMap[row.organizationId]) return
        organizationMap[row.organizationId].totalUserCount += row.totalUserCount
        organizationMap[row.organizationId].activeUserCount += row.activeUserCount
    })
}

function getTrendGrouping(
    forcedGranularity: string | null,
    months: number[],
    years: number[],
    start: string | null,
    end: string | null,
) {
    const monthly = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM')`
    const yearly = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`
    const daily = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`
    if (forcedGranularity === "yearly") return yearly
    if (forcedGranularity === "daily") return daily
    if (forcedGranularity === "monthly") return monthly
    if (months.length > 0) return months.length > 1 || years.length > 1 ? monthly : daily
    if (years.length > 0) return years.length > 1 ? yearly : monthly
    return start || end ? monthly : yearly
}

export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const url = new URL(req.url)
    const startDateParam = url.searchParams.get("startDate")
    const endDateParam = url.searchParams.get("endDate")
    const compare = url.searchParams.get("compare") === "true"
    const compareStartDateParam = url.searchParams.get("compareStartDate")
    const compareEndDateParam = url.searchParams.get("compareEndDate")
    
    const groupIdsParam = url.searchParams.get("groupIds")
    const branchIdsParam = url.searchParams.get("branchIds")

    const parsedMonths = parseNumberList(url.searchParams.get("months"), true).filter((number) => number <= 12)
    const parsedYears = parseNumberList(url.searchParams.get("years"), true).filter((number) => number > 2000)
    const parsedCompMonths = parseNumberList(url.searchParams.get("compareMonths"), true).filter((number) => number <= 12)
    const parsedCompYears = parseNumberList(url.searchParams.get("compareYears"), true).filter((number) => number > 2000)

    const userRole = (session.user as any).role || ""
    const userOrgId = (session.user as any).organizationId

    const branchConditions = buildBranchConditions(url.searchParams, userRole, userOrgId)

    // 1. Fetch Branches with Org info and User counts
    const branchStats = await db.select({
        branchId: branches.id,
        branchName: branches.name,
        organizationId: branches.organizationId,
        organizationName: organizations.name,
        organizationStatus: organizations.status,
        branchStatus: branches.status,
        activeUserCount: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.branchId} = ${branches.id} AND ${users.isActive} = true AND ${users.deletedAt} IS NULL)`.mapWith(Number),
        totalUserCount: sql<number>`(SELECT COUNT(*) FROM ${users} WHERE ${users.branchId} = ${branches.id} AND ${users.deletedAt} IS NULL)`.mapWith(Number),
    })
    .from(branches)
    .leftJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(and(...branchConditions))

    const branchIdsInScope = branchStats.map(b => b.branchId)

    // Collect org IDs already in scope (inherits RBAC from branchConditions above)
    const orgIdsInScope = [...new Set(
        branchStats.map(b => b.organizationId).filter((id): id is number => id != null)
    )]

    // Head-office users belong to an organization but not a branch. Include
    // them for organization-wide reports, but never in an explicitly
    // branch/group-scoped total.
    const includeHeadOfficeUsers = shouldIncludeHeadOfficeUsers(branchIdsParam, groupIdsParam)
    const headOfficeUserRows = includeHeadOfficeUsers && orgIdsInScope.length > 0
        ? await db.select({
            organizationId: users.organizationId,
            totalUserCount: sql<number>`COUNT(*)`.mapWith(Number),
            activeUserCount: sql<number>`COUNT(CASE WHEN ${users.isActive} = true THEN 1 END)`.mapWith(Number),
        })
        .from(users)
        .where(and(
            inArray(users.organizationId, orgIdsInScope),
            isNull(users.branchId),
            isNull(users.deletedAt),
        ))
        .groupBy(users.organizationId)
        : []

    const fetchMetrics = async (start: string | null, end: string | null, mArray: number[] = [], yArray: number[] = []) => {
        if (branchIdsInScope.length === 0) return []
        
        const conditions: any[] = [inArray(orders.branchId, branchIdsInScope)]
        
        addOrderDateConditions(conditions, start, end, mArray, yArray)

        return await db.select({
            branchId: orders.branchId,
            revenueCents: metricExpressions.revenue,
            orderCount: count(orders.id),
            fulfilledCount: sql<number>`COUNT(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' THEN 1 END)`.mapWith(Number),
            refundedCount: sql<number>`COUNT(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END)`.mapWith(Number),
            refundedRevenueCents: sql<number>`SUM(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN ${orders.totalCents} ELSE 0 END)`.mapWith(Number),
            rejectedCount: sql<number>`COUNT(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END)`.mapWith(Number),
        })
        .from(orders)
        .where(and(...conditions))
        .groupBy(orders.branchId)
    }

    const [metricsA, metricsB] = await Promise.all([
        fetchMetrics(startDateParam, endDateParam, parsedMonths, parsedYears),
        compare ? fetchMetrics(compareStartDateParam, compareEndDateParam, parsedCompMonths, parsedCompYears) : Promise.resolve([])
    ])

    const orgMap = aggregateOrganizations(branchStats, metricsA, metricsB, compare)
    addHeadOfficeUsers(orgMap, headOfficeUserRows)
    const results = Object.values(orgMap)

    const forcedGranularity = url.searchParams.get("granularity") as "daily" | "monthly" | "yearly" | null
    // 4. Fetch Trend Data for Charts (Keep grouped by date)
    const fetchTrend = async (start: string | null, end: string | null, mArray: number[] = [], yArray: number[] = []) => {
        if (branchIdsInScope.length === 0) return []
        const conditions: any[] = [inArray(orders.branchId, branchIdsInScope)]
        const grouping = getTrendGrouping(forcedGranularity, mArray, yArray, start, end)
        addOrderDateConditions(conditions, start, end, mArray, yArray)

        return await db.select({
            period: grouping,
            revenue: sql<number>`${metricExpressions.revenue} / 100`.mapWith(Number),
            orders: metricExpressions.totalOrderCount,
        })
        .from(orders)
        .where(and(...conditions))
        .groupBy(grouping)
        .orderBy(grouping)
    }

    const [trendA, trendB] = await Promise.all([
        fetchTrend(startDateParam, endDateParam, parsedMonths, parsedYears),
        compare ? fetchTrend(compareStartDateParam, compareEndDateParam, parsedCompMonths, parsedCompYears) : Promise.resolve([])
    ])

    return NextResponse.json({ 
        items: results,
        trend: trendA,
        comparisonTrend: trendB 
    })
}
