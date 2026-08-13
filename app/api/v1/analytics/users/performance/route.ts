import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, users, branches, roles, organizations } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value
        ? value.split(',').map(Number).filter((number) => !Number.isNaN(number) && isValid(number))
        : []
}

async function resolvePerformanceBranchIds({
    requestedBranchIds,
    groupIds,
    userRole,
    userBranchId,
    organizationIds,
    userOrganizationId,
}: {
    requestedBranchIds: number[]
    groupIds: number[]
    userRole: string
    userBranchId: number
    organizationIds: number[]
    userOrganizationId: number
}) {
    if (requestedBranchIds.length > 0) return requestedBranchIds
    if (groupIds.length > 0) {
        const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, groupIds))
        return rows.map((branch) => branch.id)
    }
    if (["BRANCH_ADMIN", "BRANCH_MANAGER", "ORDER_PORTAL"].includes(userRole)) return [userBranchId]
    if (organizationIds.length > 0) {
        const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
        return rows.map((branch) => branch.id)
    }
    if (userOrganizationId) {
        const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.organizationId, userOrganizationId))
        return rows.map((branch) => branch.id)
    }
    const rows = await db.select({ id: branches.id }).from(branches)
    return rows.map((branch) => branch.id)
}

function addPerformanceDateConditions(
    conditions: any[],
    months: number[],
    years: number[],
    startDate?: Date | null,
    endDate?: Date | null,
) {
    if (months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    if (months.length > 0 || years.length > 0) return
    if (startDate) conditions.push(gte(orders.createdAt, startDate))
    if (endDate) conditions.push(lte(orders.createdAt, endDate))
}

function buildPerformanceConditions(branchIds: number[], userIds: string[], months: number[], years: number[], start?: Date, end?: Date) {
    const conditions: any[] = [inArray(orders.branchId, branchIds)]
    if (userIds.length > 0) conditions.push(inArray(orders.createdByUserId, userIds))
    addPerformanceDateConditions(conditions, months, years, start, end)
    return conditions
}

function getComparisonEnd(startDate: string, compareStart: string | null, compareEnd: string | null) {
    if (compareStart && compareEnd) {
        return parseEndDateParam(compareEnd) || new Date(compareEnd)
    }
    const start = parseStartDateParam(startDate) || new Date(startDate)
    return new Date(start.getTime() - 1)
}

function buildComparisonConditions(branchIds: number[], userIds: string[], months: number[], years: number[], end?: Date | null) {
    const conditions: any[] = [inArray(orders.branchId, branchIds), eq(roles.name, "ORDER_PORTAL")]
    addPerformanceDateConditions(conditions, months, years, undefined, end)
    if (userIds.length > 0) conditions.push(inArray(orders.createdByUserId, userIds))
    return conditions
}

async function loadPerformanceComparison(
    branchIds: number[],
    userIds: string[],
    months: number[],
    years: number[],
    end?: Date | null,
) {
    const [stats] = await db
        .select({
            compOrders: metricExpressions.totalOrderCount,
            compFulfilled: metricExpressions.fulfilledCount,
            compSpent: metricExpressions.revenue,
            compUsers: sql<number>`count(distinct ${orders.createdByUserId})`.mapWith(Number),
        })
        .from(orders)
        .innerJoin(users, eq(orders.createdByUserId, users.id))
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(...buildComparisonConditions(branchIds, userIds, months, years, end)))
    return {
        totalOrders: Number(stats?.compOrders || 0),
        totalFulfilled: Number(stats?.compFulfilled || 0),
        totalSpentCents: Number(stats?.compSpent || 0),
        totalUsers: Number(stats?.compUsers || 0),
    }
}

async function loadComparisonTrend(branchIds: number[], userIds: string[], months: number[], years: number[], endDate: string | null) {
    const parsedEnd = parseEndDateParam(endDate)
    return db
        .select({
            date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
            revenue: metricExpressions.revenue,
            qtyOrdered: metricExpressions.totalOrderCount,
        })
        .from(orders)
        .innerJoin(users, eq(orders.createdByUserId, users.id))
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(...buildComparisonConditions(branchIds, userIds, months, years, parsedEnd)))
        .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId
        const pricesHidden = await shouldHidePricesForRole(userRole, userOrgId)
        const respond = (payload: any) => NextResponse.json(pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden }) : { ...payload, pricesHidden })

        const url = new URL(req.url)
        const startDateParam = url.searchParams.get("startDate")
        const endDateParam = url.searchParams.get("endDate")
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const branchIdsParam = url.searchParams.get("branchIds")
        const compare = url.searchParams.get("compare") === "true"
        const summaryOnly = url.searchParams.get("summaryOnly") === "true"
        const trendOnly = url.searchParams.get("trendOnly") === "true"
        const allTime = url.searchParams.get("allTime") === "true"
        const compareStartDateParam = url.searchParams.get("compareStartDate")
        const compareEndDateParam = url.searchParams.get("compareEndDate")

        const userIdsRaw = url.searchParams.get("userIds")
        const parsedMonths = parseNumberList(url.searchParams.get("months"), (number) => number >= 1 && number <= 12)
        const parsedYears = parseNumberList(url.searchParams.get("years"), (number) => number > 2000)
        const userIds = userIdsRaw ? userIdsRaw.split(',').filter(id => id.length > 5) : [] 
        const groupIds = parseNumberList(url.searchParams.get("groupIds"), () => true)
        const parsedCompMonths = parseNumberList(url.searchParams.get("compareMonths"), (number) => number >= 1 && number <= 12)
        const parsedCompYears = parseNumberList(url.searchParams.get("compareYears"), (number) => number > 2000)

        // RBAC & Filter Context Parsing
        const organizationIds = organizationIdsParam ? parseNumberList(organizationIdsParam) : [userOrgId].filter(Boolean)
        const branchIds = await resolvePerformanceBranchIds({
            requestedBranchIds: parseNumberList(branchIdsParam),
            groupIds,
            userRole,
            userBranchId,
            organizationIds,
            userOrganizationId: userOrgId,
        })

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches resolved" }, { status: 400 })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions = buildPerformanceConditions(branchIds, userIds, parsedMonths, parsedYears, startDate, endDate)

        // Aggregate User Metrics
        const q = db
            .select({
                userId: users.id,
                userName: users.fullName,
                userEmail: sql<string>`REGEXP_REPLACE(${users.email}, '^deleted_[0-9]+_', '')`,
                employeeId: sql<string>`COALESCE(${users.employeeId}, SPLIT_PART(${users.id}::text, '-', 1))`,
                branchName: branches.name,
                organizationName: organizations.name,
                tids: sql<string>`STRING_AGG(${orders.tid}, ',')`,
                status: sql<string>`CASE WHEN ${users.deletedAt} IS NOT NULL THEN 'DELETED' WHEN ${users.isActive} = TRUE THEN 'ACTIVE' ELSE 'INACTIVE' END`,
                totalOrders: sql<number>`count(${orders.id})`,
                fulfilledOrders: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' THEN 1 END)`,
                refundedOrders: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END)`,
                totalSpentCents: metricExpressions.revenue,
            })
            .from(users)
            .innerJoin(orders, eq(orders.createdByUserId, users.id))
            .innerJoin(roles, eq(users.roleId, roles.id))
            .leftJoin(branches, eq(users.branchId, branches.id))
            .leftJoin(organizations, eq(orders.organizationId, organizations.id))
            .where(and(...baseConditions, eq(roles.name, "ORDER_PORTAL")))
            .groupBy(users.id, branches.name, organizations.name, users.deletedAt, users.isActive)
            .orderBy(desc(metricExpressions.revenue))

        const results = await q

        // COMPARISON logic for overall KPIs
        const comparisonSummary = compare && startDateParam && endDateParam
            ? await loadPerformanceComparison(
                branchIds,
                userIds,
                parsedCompMonths,
                parsedCompYears,
                getComparisonEnd(startDateParam, compareStartDateParam, compareEndDateParam),
            )
            : null

        if (allTime) {
            // Get distinct years from orders
            const distinctYears = await db
                .select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
                .from(orders)
                .innerJoin(users, eq(orders.createdByUserId, users.id))
                .innerJoin(roles, eq(users.roleId, roles.id))
                .where(and(inArray(orders.branchId, branchIds), eq(roles.name, "ORDER_PORTAL")))
                .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`)
                .orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))

            return respond({
                years: distinctYears.map(y => y.year)
            })
        }

        if (summaryOnly) {
            return respond({
                data: {
                    totalOrders: results.reduce((sum, u) => sum + Number(u.totalOrders || 0), 0),
                    fulfilledOrders: results.reduce((sum, u) => sum + Number(u.fulfilledOrders || 0), 0),
                    totalSpentCents: results.reduce((sum, u) => sum + Number(u.totalSpentCents || 0), 0),
                    totalUsers: results.length
                },
                comparison: comparisonSummary
            })
        }

        if (trendOnly) {
            // Aggregate orders by month
            const trendData = await db
                .select({
                    date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
                    revenue: metricExpressions.revenue,
                    qtyOrdered: metricExpressions.totalOrderCount,
                    qtyFulfilled: metricExpressions.fulfilledCount,
                    qtyRefunded: metricExpressions.refundedCount,
                })
                .from(orders)
                .innerJoin(users, eq(orders.createdByUserId, users.id))
                .innerJoin(roles, eq(users.roleId, roles.id))
                .where(and(...baseConditions, eq(roles.name, "ORDER_PORTAL")))
                .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
                .orderBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)

            // Comparison trend if requested
            const hasComparisonTrend = compare && (
                parsedCompMonths.length > 0
                || parsedCompYears.length > 0
                || Boolean(compareStartDateParam && compareEndDateParam)
            )
            const compareTrend = hasComparisonTrend
                ? await loadComparisonTrend(branchIds, userIds, parsedCompMonths, parsedCompYears, compareEndDateParam)
                : []

            return respond({
                data: results, // Keep users list for fallback or top performers
                trend: trendData,
                compareTrend,
                comparison: comparisonSummary
            })
        }

        return respond({
            data: results,
            comparison: comparisonSummary
        })
    } catch (error: any) {
        console.error("User Performance Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch user performance" }, { status: 500 })
    }
}
