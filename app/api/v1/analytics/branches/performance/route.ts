import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, branches, organizations, groups } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
import { metricExpressions, REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { resolveMultiBranchAnalyticsIds } from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

type BranchPerformanceFilters = {
    organizationId: number | null
    groupIds: number[]
    branchIds: number[]
    months: number[]
    years: number[]
    compareMonths: number[]
    compareYears: number[]
    startDate: string | null
    endDate: string | null
    compareStartDate: string | null
    compareEndDate: string | null
}

function parseNumberList(value: string | null, isValid = (number: number) => !Number.isNaN(number)) {
    return value ? value.split(',').map(Number).filter(isValid) : []
}

function parseBranchFilters(searchParams: URLSearchParams, userRole: string, userOrganizationId: number | null) {
    const requestedOrganizationId = searchParams.get("organizationId")
    let organizationId = userOrganizationId
    if (userRole === "SUPER_ADMIN") {
        organizationId = requestedOrganizationId ? Number.parseInt(requestedOrganizationId) : null
    }
    const isMonth = (number: number) => !Number.isNaN(number) && number >= 1 && number <= 12
    const isYear = (number: number) => !Number.isNaN(number) && number > 2000
    return {
        organizationId,
        groupIds: parseNumberList(searchParams.get("groupIds")),
        branchIds: parseNumberList(searchParams.get("branchIds")),
        months: parseNumberList(searchParams.get("months"), isMonth),
        years: parseNumberList(searchParams.get("years"), isYear),
        compareMonths: parseNumberList(searchParams.get("compareMonths"), isMonth),
        compareYears: parseNumberList(searchParams.get("compareYears"), isYear),
        startDate: searchParams.get("startDate"),
        endDate: searchParams.get("endDate"),
        compareStartDate: searchParams.get("compareStartDate"),
        compareEndDate: searchParams.get("compareEndDate"),
    } satisfies BranchPerformanceFilters
}

function getScopeConditions(filters: BranchPerformanceFilters) {
    return [
        REVENUE_ELIGIBLE_FILTER,
        filters.organizationId ? eq(branches.organizationId, filters.organizationId) : undefined,
        filters.groupIds.length > 0 ? inArray(branches.groupId, filters.groupIds) : undefined,
        filters.branchIds.length > 0 ? inArray(branches.id, filters.branchIds) : undefined,
    ]
}

function addBranchPeriodConditions(conditions: any[], months: number[], years: number[], start?: Date | null, end?: Date | null) {
    if (months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    if (months.length > 0 || years.length > 0) return
    if (start) conditions.push(gte(orders.createdAt, start))
    if (end) conditions.push(lte(orders.createdAt, end))
}

function getComparisonRange(filters: BranchPerformanceFilters) {
    if (filters.compareStartDate && filters.compareEndDate) {
        return {
            start: parseStartDateParam(filters.compareStartDate) || new Date(filters.compareStartDate),
            end: parseEndDateParam(filters.compareEndDate) || new Date(filters.compareEndDate),
        }
    }
    if (filters.startDate && filters.endDate) {
        const start = parseStartDateParam(filters.startDate) || new Date(filters.startDate)
        const end = parseEndDateParam(filters.endDate) || new Date(filters.endDate)
        const duration = end.getTime() - start.getTime()
        return { start: new Date(start.getTime() - duration - 1), end: new Date(start.getTime() - 1) }
    }
    return { start: new Date(), end: new Date() }
}

function getComparisonConditions(filters: BranchPerformanceFilters) {
    const conditions = getScopeConditions(filters)
    const range = getComparisonRange(filters)
    addBranchPeriodConditions(conditions, filters.compareMonths, filters.compareYears, range.start, range.end)
    return conditions
}

async function getAvailableYears(conditions: any[]) {
    const rows = await db
        .select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
        .from(orders)
        .innerJoin(branches, eq(orders.branchId, branches.id))
        .where(and(...conditions))
        .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`)
        .orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))
    return { years: rows.map((row) => row.year) }
}

async function getBranchTrend(conditions: any[], filters: BranchPerformanceFilters, compare: boolean) {
    const trend = await db
        .select({
            date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
            revenue: metricExpressions.revenue,
            orders: metricExpressions.totalOrderCount,
        })
        .from(orders)
        .innerJoin(branches, eq(orders.branchId, branches.id))
        .where(and(...conditions))
        .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
        .orderBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
    const compareTrend = compare
        ? await db
            .select({
                date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
                revenue: metricExpressions.revenue,
            })
            .from(orders)
            .innerJoin(branches, eq(orders.branchId, branches.id))
            .where(and(...getComparisonConditions(filters)))
            .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
        : []
    return { trend, compareTrend }
}

async function getBranchSummary(conditions: any[], filters: BranchPerformanceFilters, compare: boolean) {
    const [summary] = await db
        .select({
            totalOrders: metricExpressions.totalOrderCount,
            fulfilledOrders: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' AND COALESCE(${orders.refundAmountCents}, 0) = 0 THEN 1 END)`.mapWith(Number),
            totalRevenue: metricExpressions.revenue,
            totalRefunds: metricExpressions.totalRefundAmount,
            activeBranches: sql<number>`count(distinct ${branches.id})`.mapWith(Number),
        })
        .from(orders)
        .innerJoin(branches, eq(orders.branchId, branches.id))
        .where(and(...conditions))
    const [comparison] = compare
        ? await db
            .select({
                totalOrders: metricExpressions.totalOrderCount,
                totalRevenue: metricExpressions.revenue,
                totalRefunds: metricExpressions.totalRefundAmount,
            })
            .from(orders)
            .innerJoin(branches, eq(orders.branchId, branches.id))
            .where(and(...getComparisonConditions(filters)))
        : [null]
    return { summary, comparison }
}

async function getBranchItems(filters: BranchPerformanceFilters, conditions: any[]) {
    const items = await db
        .select({
            id: branches.id,
            name: branches.name,
            status: branches.status,
            organizationName: organizations.name,
            groupName: groups.name,
            totalOrders: sql<number>`count(${orders.id})`.mapWith(Number),
            fulfilledOrders: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' AND COALESCE(${orders.refundAmountCents}, 0) = 0 THEN 1 END)`.mapWith(Number),
            revenue: metricExpressions.revenue,
            refunds: sql<number>`coalesce(sum(${orders.refundAmountCents}), 0)`.mapWith(Number),
        })
        .from(branches)
        .leftJoin(organizations, eq(branches.organizationId, organizations.id))
        .leftJoin(groups, eq(branches.groupId, groups.id))
        .leftJoin(orders, and(eq(orders.branchId, branches.id), ...conditions))
        .where(and(...getScopeConditions(filters).slice(1)))
        .groupBy(branches.id, organizations.name, groups.name)
        .orderBy(desc(metricExpressions.revenue))
    return { items }
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrganizationId = (session.user as any).organizationId
        const pricesHidden = await shouldHidePricesForRole(userRole, userOrganizationId)
        const respond = (payload: any) => NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden }) : { ...payload, pricesHidden },
        )
        const searchParams = new URL(req.url).searchParams
        const requestedFilters = parseBranchFilters(searchParams, userRole, userOrganizationId)

        // A multi-branch role reports on the branches assigned to it and on
        // nothing else, so its assignments replace whatever branch filter the
        // request carried. An empty assignment set is refused, never widened.
        const assignedBranchIds = resolveMultiBranchAnalyticsIds({
            role: userRole,
            assignedBranchIds: await loadAnalyticsAssignedBranchIds(userRole, (session.user as any).id),
            requestedBranchIds: requestedFilters.branchIds,
        })
        if (assignedBranchIds?.length === 0) {
            return NextResponse.json({ error: "Branch context missing" }, { status: 403 })
        }
        const filters = assignedBranchIds
            ? { ...requestedFilters, branchIds: assignedBranchIds }
            : requestedFilters

        const conditions = getScopeConditions(filters)
        if (searchParams.get("allTime") === "true") return respond(await getAvailableYears(conditions))

        addBranchPeriodConditions(
            conditions,
            filters.months,
            filters.years,
            parseStartDateParam(filters.startDate),
            parseEndDateParam(filters.endDate),
        )
        const compare = searchParams.get("compare") === "true"
        if (searchParams.get("trendOnly") === "true") {
            return respond(await getBranchTrend(conditions, filters, compare))
        }
        if (searchParams.get("summaryOnly") === "true") {
            return respond(await getBranchSummary(conditions, filters, compare))
        }
        return respond(await getBranchItems(filters, conditions))
    } catch (error: any) {
        console.error("Branch Performance API failed:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
