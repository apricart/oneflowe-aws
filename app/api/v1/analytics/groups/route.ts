import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, branches, orders, organizations, budgets } from "@/db/schema"
import { and, eq, sql, isNull, gte, lte, desc, inArray } from "drizzle-orm"
import { metricExpressions, REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { buildAppMonthPeriods, getAppMonthPeriod, parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

const nonDeletedGroupCondition = sql`${groups.status} != 'deleted'`

function parseNumberList(value: string | null, isValid = (number: number) => !Number.isNaN(number)) {
    return value ? value.split(",").map(Number).filter(isValid) : []
}

function buildGroupOrderConditions(context: any) {
    const conditions: any[] = [REVENUE_ELIGIBLE_FILTER]
    if (context.months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    }
    if (context.years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    }
    if (context.months.length === 0 && context.years.length === 0) {
        const start = context.startDate ? parseStartDateParam(context.startDate) : null
        const end = context.endDate ? parseEndDateParam(context.endDate) : null
        if (start) conditions.push(gte(orders.createdAt, start))
        if (end) conditions.push(lte(orders.createdAt, end))
    }
    return conditions
}

function buildGroupBudgetPeriods(context: any): string[] {
    if (context.months.length > 0 && context.years.length > 0) {
        return context.years.flatMap((year: number) => context.months.map((month: number) => `${year}-${String(month).padStart(2, "0")}`))
    }
    if (context.startDate && context.endDate) {
        return buildAppMonthPeriods(
            parseStartDateParam(context.startDate) || new Date(context.startDate),
            parseEndDateParam(context.endDate) || new Date(context.endDate),
        )
    }
    return [getAppMonthPeriod(new Date())]
}

function getComparisonRange(context: any) {
    if (context.explicitStart && context.explicitEnd) {
        return {
            start: parseStartDateParam(context.explicitStart) || new Date(context.explicitStart),
            end: parseEndDateParam(context.explicitEnd) || new Date(context.explicitEnd),
        }
    }
    if (context.startDate && context.endDate) {
        const start = parseStartDateParam(context.startDate) || new Date(context.startDate)
        const end = parseEndDateParam(context.endDate) || new Date(context.endDate)
        const duration = end.getTime() - start.getTime()
        return { start: new Date(start.getTime() - duration - 1), end: new Date(start.getTime() - 1) }
    }
    const now = new Date()
    return { start: now, end: now }
}

function buildGroupComparisonDateCondition(context: any) {
    const conditions: any[] = []
    if (context.months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    }
    if (context.years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    }
    if (conditions.length === 0) conditions.push(gte(orders.createdAt, context.range.start), lte(orders.createdAt, context.range.end))
    return and(...conditions)
}

function buildGroupScopeConditions(context: any) {
    return [
        context.organizationId ? eq(groups.organizationId, context.organizationId) : undefined,
        nonDeletedGroupCondition,
        context.groupIds.length > 0 ? inArray(groups.id, context.groupIds) : undefined,
        context.branchIds.length > 0 ? inArray(branches.id, context.branchIds) : undefined,
    ]
}

async function loadGroupTrend(context: any) {
    const trend = await db.select({
        date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
        revenue: metricExpressions.revenue,
        orders: metricExpressions.totalOrderCount,
    }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).innerJoin(groups, eq(branches.groupId, groups.id))
        .where(and(context.orderWhere, ...buildGroupScopeConditions(context)))
        .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`).orderBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
    if (!context.compare) return { trend, compareTrend: [] }
    const dateCondition = buildGroupComparisonDateCondition(context)
    const compareTrend = await db.select({
        date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
        revenue: metricExpressions.revenue,
    }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).innerJoin(groups, eq(branches.groupId, groups.id))
        .where(and(REVENUE_ELIGIBLE_FILTER, ...buildGroupScopeConditions(context), dateCondition))
        .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
    return { trend, compareTrend }
}

function buildRefundConditions(context: any) {
    const conditions: any[] = [
        sql`COALESCE(${orders.refundAmountCents}, 0) > 0`,
        nonDeletedGroupCondition,
        inArray(groups.id, context.groupIds),
    ]
    if (context.organizationId) conditions.push(eq(groups.organizationId, context.organizationId))
    if (context.branchIds.length > 0) conditions.push(inArray(branches.id, context.branchIds))
    const dateConditions = buildGroupOrderConditions(context).slice(1)
    conditions.push(...dateConditions)
    return conditions
}

function indexGroupBudgets(rows: any[]) {
    const matrix: Record<number, Record<string, { allocated: number; credited: number }>> = {}
    const branchesByGroup: Record<number, Set<number>> = {}
    rows.forEach((row) => {
        if (!row.groupId) return
        branchesByGroup[row.groupId] ??= new Set()
        branchesByGroup[row.groupId].add(row.branchId)
        if (!row.period) return
        matrix[row.branchId] ??= {}
        matrix[row.branchId][row.period] = {
            allocated: row.amountAllocatedCents || 0,
            credited: row.amountCreditedCents || 0,
        }
    })
    return { matrix, branchesByGroup }
}

function calculateGroupBudgetMap(groupIds: number[], periods: string[], matrix: any, branchesByGroup: any) {
    return Object.fromEntries(groupIds.map((groupId) => {
        const branchIds = [...(branchesByGroup[groupId] || new Set<number>())]
        const total = branchIds.reduce((groupTotal: number, branchId: number) => groupTotal + periods.reduce((branchTotal, period) => {
            const record = matrix[branchId]?.[period]
            return branchTotal + (record ? record.allocated + record.credited : 0)
        }, 0), 0)
        return [groupId, total]
    }))
}

function indexBranchStats(rows: any[], periods: string[], matrix: any, refundMap: Record<number, number>) {
    const stats: Record<number, any[]> = {}
    rows.forEach((row) => {
        if (!row.groupId) return
        const totalBudget = periods.reduce((total, period) => {
            const record = matrix[row.id]?.[period]
            return total + (record ? record.allocated + record.credited : 0)
        }, 0)
        stats[row.groupId] ??= []
        stats[row.groupId].push({ ...row, refunds: refundMap[row.id] || 0, totalBudget })
    })
    return stats
}

async function loadGroupSupportingData(context: any) {
    if (context.groupIds.length === 0) {
        return { refundByGroup: {}, budgetByGroup: {}, branchesByGroup: {} }
    }
    const refundConditions = buildRefundConditions(context)
    const [groupRefunds, branchRefunds, budgetRows, branchRows] = await Promise.all([
        db.select({
            groupId: groups.id,
            totalRefundCents: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
        }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).innerJoin(groups, eq(branches.groupId, groups.id))
            .where(and(...refundConditions)).groupBy(groups.id),
        db.select({
            branchId: branches.id,
            totalRefundCents: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
        }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).innerJoin(groups, eq(branches.groupId, groups.id))
            .where(and(...refundConditions)).groupBy(branches.id),
        db.select({
            branchId: branches.id,
            groupId: branches.groupId,
            period: budgets.period,
            amountAllocatedCents: budgets.amountAllocatedCents,
            amountCreditedCents: budgets.amountCreditedCents,
        }).from(branches).leftJoin(budgets, and(eq(budgets.branchId, branches.id), inArray(budgets.period, context.periods)))
            .where(inArray(branches.groupId, context.groupIds)),
        db.select({
            id: branches.id,
            name: branches.name,
            status: branches.status,
            groupId: branches.groupId,
            orders: sql<number>`count(${orders.id})::int`,
            revenue: metricExpressions.revenue,
            refunds: sql<number>`coalesce(sum(${orders.refundAmountCents}), 0)::int`,
            rejected: sql<number>`count(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END)::int`,
        }).from(branches).leftJoin(orders, and(
            eq(orders.branchId, branches.id),
            context.orderWhere,
            context.branchIds.length > 0 ? inArray(orders.branchId, context.branchIds) : undefined,
        )).where(inArray(branches.groupId, context.groupIds)).groupBy(branches.id).orderBy(desc(metricExpressions.revenue)),
    ])
    const refundByGroup = Object.fromEntries(groupRefunds.map((row) => [row.groupId, row.totalRefundCents || 0]))
    const refundByBranch = Object.fromEntries(branchRefunds.map((row) => [row.branchId, row.totalRefundCents || 0]))
    const { matrix, branchesByGroup } = indexGroupBudgets(budgetRows)
    return {
        refundByGroup,
        budgetByGroup: calculateGroupBudgetMap(context.groupIds, context.periods, matrix, branchesByGroup),
        branchesByGroup: indexBranchStats(branchRows, context.periods, matrix, refundByBranch),
    }
}

async function loadGroupComparison(context: any) {
    if (!context.enabled) return null
    const dateCondition = buildGroupComparisonDateCondition(context)
    const scope = buildGroupScopeConditions(context)
    const [stats, refunds] = await Promise.all([
        db.select({
            totalOrders: metricExpressions.totalOrderCount,
            totalAmountCents: metricExpressions.revenue,
        }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).leftJoin(groups, eq(branches.groupId, groups.id))
            .where(and(REVENUE_ELIGIBLE_FILTER, ...scope, dateCondition)),
        db.select({
            totalRefunds: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
        }).from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).leftJoin(groups, eq(branches.groupId, groups.id))
            .where(and(sql`COALESCE(${orders.refundAmountCents}, 0) > 0`, ...scope, dateCondition)),
    ])
    return {
        totalOrders: stats[0]?.totalOrders || 0,
        totalRevenue: stats[0]?.totalAmountCents || 0,
        totalRefunds: refunds[0]?.totalRefunds || 0,
    }
}

function resolveGroupOrganizationId(role: string, organizationId: number | null, requestedId: string | null) {
    if (role !== "SUPER_ADMIN" || !requestedId) return organizationId
    const parsed = Number.parseInt(requestedId)
    return Number.isFinite(parsed) ? parsed : organizationId
}

async function loadGroupYears(organizationId: number | null) {
    const years = await db.select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
        .from(orders).innerJoin(branches, eq(orders.branchId, branches.id)).innerJoin(groups, eq(branches.groupId, groups.id))
        .where(and(REVENUE_ELIGIBLE_FILTER, organizationId ? eq(groups.organizationId, organizationId) : undefined, nonDeletedGroupCondition))
        .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`).orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))
    return years.map((row) => row.year)
}

function buildGroupConditions(organizationId: number | null, groupIds: number[]) {
    return [
        organizationId ? eq(groups.organizationId, organizationId) : undefined,
        nonDeletedGroupCondition,
        groupIds.length > 0 ? inArray(groups.id, groupIds) : undefined,
    ].filter(Boolean) as any
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const normalizedRole = typeof role === "string" ? role.toUpperCase().replace(/\s+/g, "_") : role
        const userOrganizationId = role === "SUPER_ADMIN" ? null : (session.user as any).organizationId
        const { searchParams } = new URL(req.url)
        const orgIdParam = searchParams.get("organizationId")
        const groupIdsParam = searchParams.get("groupIds")
        const branchIdsParam = searchParams.get("branchIds")
        const startDate = searchParams.get("startDate")
        const endDate = searchParams.get("endDate")
        const compare = searchParams.get("compare") === "true"
        const compareStartDateParam = searchParams.get("compareStartDate")
        const compareEndDateParam = searchParams.get("compareEndDate")

        const monthsRaw = searchParams.get("months")
        const yearsRaw = searchParams.get("years")
        const compareMonthsRaw = searchParams.get("compareMonths")
        const compareYearsRaw = searchParams.get("compareYears")

        const parsedMonths = parseNumberList(monthsRaw, (number) => !Number.isNaN(number) && number >= 1 && number <= 12)
        const parsedYears = parseNumberList(yearsRaw, (number) => !Number.isNaN(number) && number > 2000)
        const parsedCompMonths = parseNumberList(compareMonthsRaw, (number) => !Number.isNaN(number) && number >= 1 && number <= 12)
        const parsedCompYears = parseNumberList(compareYearsRaw, (number) => !Number.isNaN(number) && number > 2000)

        const summaryOnly = searchParams.get("summaryOnly") === "true"
        const trendOnly = searchParams.get("trendOnly") === "true"
        const allTime = searchParams.get("allTime") === "true"

        const orgId = resolveGroupOrganizationId(role, userOrganizationId, orgIdParam)

        if (!orgId && role !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Organization ID required" }, { status: 400 })
        }
        const pricesHidden = await shouldHidePricesForRole(normalizedRole, orgId)
        const respond = (payload: any) => NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden: true }) : payload
        )

        const parsedGroupIds = parseNumberList(groupIdsParam)
        const parsedBranchIds = parseNumberList(branchIdsParam)

        // ━━━ Mode: All Time (Year Selection) ━━━
        if (allTime) return NextResponse.json({ years: await loadGroupYears(orgId) })

        // Build order conditions for date filtering
        const orderWhere = and(...buildGroupOrderConditions({ months: parsedMonths, years: parsedYears, startDate, endDate }))

        // Calculate periods for budget summing
        const periodList = buildGroupBudgetPeriods({ months: parsedMonths, years: parsedYears, startDate, endDate })

        // Build group conditions
        const groupConditions = buildGroupConditions(orgId, parsedGroupIds)

        // ━━━ Mode: Trend Only (Bar Chart) ━━━
        const comparisonRange = getComparisonRange({
            explicitStart: compareStartDateParam, explicitEnd: compareEndDateParam, startDate, endDate,
        })
        if (trendOnly) return respond(await loadGroupTrend({
            orderWhere,
            organizationId: orgId,
            groupIds: parsedGroupIds,
            branchIds: parsedBranchIds,
            compare,
            months: parsedCompMonths,
            years: parsedCompYears,
            range: comparisonRange,
        }))

        // 1. Fetch Group stats with branch-level breakdown
        const groupStats = await db
            .select({
                id: groups.id,
                name: groups.name,
                status: groups.status,
                organizationId: groups.organizationId,
                organizationName: organizations.name,
                totalOrders: sql<number>`count(${orders.id})::int`,
                totalAmountCents: metricExpressions.revenue,
                totalRefundCents: sql<number>`coalesce(sum(${orders.refundAmountCents}), 0)::int`,
                rejectedOrders: sql<number>`count(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END)::int`,
                branchCount: sql<number>`count(distinct ${branches.id})::int`,
                branches: sql<any>`
                    COALESCE(
                        JSON_AGG(
                            DISTINCT JSONB_BUILD_OBJECT(
                                'id', ${branches.id},
                                'name', ${branches.name}
                            )
                        ) FILTER (WHERE ${branches.id} IS NOT NULL),
                        '[]'
                    )
                `
            })
            .from(groups)
            .leftJoin(organizations, eq(groups.organizationId, organizations.id))
            .leftJoin(branches, eq(branches.groupId, groups.id))
            .leftJoin(orders, and(
                eq(orders.branchId, branches.id),
                orderWhere,
                parsedBranchIds.length > 0 ? inArray(orders.branchId, parsedBranchIds) : undefined
            ))
            .where(and(...groupConditions))
            .groupBy(groups.id, organizations.id)
            .orderBy(desc(metricExpressions.revenue))

        const groupIdsList = groupStats.map((group) => group.id)
        const supportingData = await loadGroupSupportingData({
            groupIds: groupIdsList,
            organizationId: orgId,
            branchIds: parsedBranchIds,
            months: parsedMonths,
            years: parsedYears,
            startDate,
            endDate,
            periods: periodList,
            orderWhere,
        })
        const refundByGroupMap = supportingData.refundByGroup
        const groupBudgetMap = supportingData.budgetByGroup
        const branchStatsMap = supportingData.branchesByGroup
        const groupsWithBranches = groupStats.map(group => ({
            ...group,
            totalRefundCents: refundByGroupMap[group.id] || 0,
            totalBudget: groupBudgetMap[group.id] || 0,
            branches: branchStatsMap[group.id] || []
        }))

        // 3. Calculate summary statistics
        const totalGroups = groupsWithBranches.length
        const totalOrders = groupsWithBranches.reduce((sum, g) => sum + g.totalOrders, 0)
        const totalRevenue = groupsWithBranches.reduce((sum, g) => sum + g.totalAmountCents, 0)
        const totalRefunds = groupsWithBranches.reduce((sum, g) => sum + g.totalRefundCents, 0)
        const avgRevenuePerGroup = totalGroups > 0 ? Math.round(totalRevenue / totalGroups) : 0

        // 4. Ungrouped Branches (For summary too)
        const ungroupedConditions = []
        if (orgId) ungroupedConditions.push(eq(branches.organizationId, orgId))
        ungroupedConditions.push(isNull(branches.groupId), eq(branches.status, 'active'))

        const ungroupedStats = await db
            .select({
                id: branches.id,
                name: branches.name,
                organizationId: branches.organizationId,
                organizationName: organizations.name,
                totalOrders: sql<number>`count(${orders.id})::int`,
                totalAmountCents: metricExpressions.revenue,
            })
            .from(branches)
            .leftJoin(organizations, eq(branches.organizationId, organizations.id))
            .leftJoin(orders, and(eq(orders.branchId, branches.id), orderWhere))
            .where(and(...ungroupedConditions))
            .groupBy(branches.id, organizations.id)
            .orderBy(desc(metricExpressions.revenue))

        const totalUngroupedRevenue = ungroupedStats.reduce((sum, b) => sum + b.totalAmountCents, 0)
        const totalUngroupedOrders = ungroupedStats.reduce((sum, b) => sum + b.totalOrders, 0)

        const comparisonSummary = await loadGroupComparison({
            enabled: compare && Boolean(startDate || parsedCompMonths.length > 0),
            organizationId: orgId,
            groupIds: parsedGroupIds,
            branchIds: parsedBranchIds,
            months: parsedCompMonths,
            years: parsedCompYears,
            range: comparisonRange,
        })
        const outSummary = {
            totalGroups,
            totalOrders: totalOrders + totalUngroupedOrders,
            totalRevenue: totalRevenue + totalUngroupedRevenue,
            totalRefunds: totalRefunds,
            avgRevenuePerGroup
        }

        if (summaryOnly) {
            return respond({ summary: outSummary, comparison: comparisonSummary })
        }

        return respond({
            summary: outSummary,
            comparison: comparisonSummary,
            groups: groupsWithBranches,
            ungroupedBranches: ungroupedStats
        })

    } catch (e: any) {
        console.error("Error in group analytics API:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
