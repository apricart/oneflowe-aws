import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, branches, orders, organizations, budgets } from "@/db/schema"
import { and, eq, sql, isNull, gte, lte, desc, inArray } from "drizzle-orm"
import { metricExpressions, REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { buildAppMonthPeriods, getAppMonthPeriod, parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const normalizedRole = typeof role === "string" ? role.toUpperCase().replace(/\s+/g, "_") : role
        let orgId = role === "SUPER_ADMIN" ? null : (session.user as any).organizationId
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

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter((n: any) => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter((n: any) => !Number.isNaN(n) && n > 2000) : []
        const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter((n: any) => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter((n: any) => !Number.isNaN(n) && n > 2000) : []

        const summaryOnly = searchParams.get("summaryOnly") === "true"
        const trendOnly = searchParams.get("trendOnly") === "true"
        const allTime = searchParams.get("allTime") === "true"

        if (orgIdParam && role === "SUPER_ADMIN") {
            const parsedOrgId = Number.parseInt(orgIdParam)
            if (Number.isFinite(parsedOrgId)) orgId = parsedOrgId
        }

        if (!orgId && role !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Organization ID required" }, { status: 400 })
        }
        const pricesHidden = await shouldHidePricesForRole(normalizedRole, orgId)
        const respond = (payload: any) => NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden: true }) : payload
        )

        const parsedGroupIds = groupIdsParam ? groupIdsParam.split(',').map(Number).filter(id => !Number.isNaN(id)) : []
        const parsedBranchIds = branchIdsParam ? branchIdsParam.split(',').map(Number).filter(id => !Number.isNaN(id)) : []
        const nonDeletedGroupCondition = sql`${groups.status} != 'deleted'`

        // ━━━ Mode: All Time (Year Selection) ━━━
        if (allTime) {
            const distinctYears = await db
                .select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
                .from(orders)
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .innerJoin(groups, eq(branches.groupId, groups.id))
                .where(and(
                    REVENUE_ELIGIBLE_FILTER,
                    orgId ? eq(groups.organizationId, orgId) : undefined,
                    nonDeletedGroupCondition
                ))
                .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`)
                .orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))

            return NextResponse.json({
                years: distinctYears.map(y => y.year)
            })
        }

        // Build order conditions for date filtering
        const orderConditions: any[] = [REVENUE_ELIGIBLE_FILTER]
        
        if (parsedMonths.length > 0) {
            orderConditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql.raw(", "))})`)
        }
        if (parsedYears.length > 0) {
            orderConditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql.raw(", "))})`)
        }

        if (parsedMonths.length === 0 && parsedYears.length === 0) {
            if (startDate) {
                const start = parseStartDateParam(startDate)
                if (start) orderConditions.push(gte(orders.createdAt, start))
            }
            if (endDate) {
                const end = parseEndDateParam(endDate)
                if (end) orderConditions.push(lte(orders.createdAt, end))
            }
        }

        const orderWhere = and(...orderConditions)

        // Calculate periods for budget summing
        const periodList: string[] = []
        if (parsedMonths.length > 0 && parsedYears.length > 0) {
            parsedYears.forEach(y => {
                parsedMonths.forEach(m => {
                    periodList.push(`${y}-${String(m).padStart(2, '0')}`)
                })
            })
        } else if (startDate && endDate) {
            periodList.push(...buildAppMonthPeriods(
                parseStartDateParam(startDate) || new Date(startDate),
                parseEndDateParam(endDate) || new Date(endDate)
            ))
        } else {
            // Default to current month if no filters
            periodList.push(getAppMonthPeriod(new Date()))
        }

        // Build group conditions
        const groupConditions = []
        if (orgId) {
            groupConditions.push(eq(groups.organizationId, orgId))
        }
        groupConditions.push(nonDeletedGroupCondition)
        if (parsedGroupIds.length > 0) {
            groupConditions.push(sql`${groups.id} IN (${sql.join(parsedGroupIds, sql.raw(", "))})`)
        }

        // ━━━ Mode: Trend Only (Bar Chart) ━━━
        if (trendOnly) {
            const trendData = await db
                .select({
                    date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
                    revenue: metricExpressions.revenue,
                    orders: metricExpressions.totalOrderCount,
                })
                .from(orders)
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .innerJoin(groups, eq(branches.groupId, groups.id))
                .where(and(
                    orderWhere,
                    orgId ? eq(groups.organizationId, orgId) : undefined,
                    nonDeletedGroupCondition,
                    parsedGroupIds.length > 0 ? sql`${groups.id} IN (${sql.join(parsedGroupIds, sql.raw(", "))})` : undefined,
                    parsedBranchIds.length > 0 ? sql`${branches.id} IN (${sql.join(parsedBranchIds, sql.raw(", "))})` : undefined
                ))
                .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
                .orderBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)

            let compareTrend: any[] = []
            if (compare) {
                let prevStart: Date, prevEnd: Date
                if (compareStartDateParam && compareEndDateParam) {
                    prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam); prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
                } else if (startDate && endDate) {
                    const start = parseStartDateParam(startDate) || new Date(startDate); const end = parseEndDateParam(endDate) || new Date(endDate)
                    const duration = end.getTime() - start.getTime()
                    prevStart = new Date(start.getTime() - duration - 1); prevEnd = new Date(start.getTime() - 1)
                } else {
                    prevStart = new Date(); prevEnd = new Date()
                }

                compareTrend = await db
                    .select({
                        date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
                        revenue: metricExpressions.revenue,
                    })
                    .from(orders)
                    .innerJoin(branches, eq(orders.branchId, branches.id))
                    .innerJoin(groups, eq(branches.groupId, groups.id))
                    .where(and(
                        REVENUE_ELIGIBLE_FILTER,
                        orgId ? eq(groups.organizationId, orgId) : undefined,
                        nonDeletedGroupCondition,
                        parsedGroupIds.length > 0 ? sql`${groups.id} IN (${sql.join(parsedGroupIds, sql.raw(", "))})` : undefined,
                        parsedBranchIds.length > 0 ? sql`${branches.id} IN (${sql.join(parsedBranchIds, sql.raw(", "))})` : undefined,
                        (() => {
                            const compCond: any[] = []
                            if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                                if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                                if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                            } else {
                                compCond.push(gte(orders.createdAt, prevStart), lte(orders.createdAt, prevEnd))
                            }
                            return and(...compCond)
                        })()
                    ))
                    .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
            }

            return respond({ trend: trendData, compareTrend })
        }

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

        const groupIdsList = groupStats.map(g => g.id)
        const refundByGroupMap: Record<number, number> = {}
        const refundByBranchMap: Record<number, number> = {}
        const branchStatsMap: Record<number, any[]> = {}
        const groupBudgetMap: Record<number, number> = {}

        if (groupIdsList.length > 0) {
            const refundConditions: any[] = [
                sql`COALESCE(${orders.refundAmountCents}, 0) > 0`,
                nonDeletedGroupCondition,
                inArray(groups.id, groupIdsList)
            ]

            if (orgId) {
                refundConditions.push(eq(groups.organizationId, orgId))
            }
            if (parsedBranchIds.length > 0) {
                refundConditions.push(inArray(branches.id, parsedBranchIds))
            }
            if (parsedMonths.length > 0) {
                refundConditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql.raw(", "))})`)
            }
            if (parsedYears.length > 0) {
                refundConditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql.raw(", "))})`)
            }
            if (parsedMonths.length === 0 && parsedYears.length === 0) {
                if (startDate) {
                    const start = parseStartDateParam(startDate)
                    if (start) refundConditions.push(gte(orders.createdAt, start))
                }
                if (endDate) {
                    const end = parseEndDateParam(endDate)
                    if (end) refundConditions.push(lte(orders.createdAt, end))
                }
            }

            const [groupRefundStats, branchRefundStats] = await Promise.all([
                db
                    .select({
                        groupId: groups.id,
                        totalRefundCents: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
                    })
                    .from(orders)
                    .innerJoin(branches, eq(orders.branchId, branches.id))
                    .innerJoin(groups, eq(branches.groupId, groups.id))
                    .where(and(...refundConditions))
                    .groupBy(groups.id),
                db
                    .select({
                        branchId: branches.id,
                        totalRefundCents: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
                    })
                    .from(orders)
                    .innerJoin(branches, eq(orders.branchId, branches.id))
                    .innerJoin(groups, eq(branches.groupId, groups.id))
                    .where(and(...refundConditions))
                    .groupBy(branches.id)
            ])

            groupRefundStats.forEach(row => {
                refundByGroupMap[row.groupId] = row.totalRefundCents || 0
            })

            branchRefundStats.forEach(row => {
                refundByBranchMap[row.branchId] = row.totalRefundCents || 0
            })

            // Calculate group budgets from actual budget rows only.
            // Missing period rows should not project the branch baseline into reports.
            const allBudgets = await db
                .select({
                    branchId: branches.id,
                    groupId: branches.groupId,
                    period: budgets.period,
                    amountAllocatedCents: budgets.amountAllocatedCents,
                    amountCreditedCents: budgets.amountCreditedCents,
                })
                .from(branches)
                .leftJoin(budgets, and(
                    eq(budgets.branchId, branches.id),
                    inArray(budgets.period, periodList)
                ))
                .where(inArray(branches.groupId, groupIdsList))

            // Map branch -> period -> budget
            const branchBudgetMatrix: Record<number, Record<string, { allocated: number, credited: number }>> = {}
            const branchesInGroups: Record<number, Set<number>> = {}

            allBudgets.forEach(b => {
                if (!b.groupId) return
                if (!branchesInGroups[b.groupId]) branchesInGroups[b.groupId] = new Set()
                branchesInGroups[b.groupId].add(b.branchId)
                
                if (b.period) {
                    if (!branchBudgetMatrix[b.branchId]) branchBudgetMatrix[b.branchId] = {}
                    branchBudgetMatrix[b.branchId][b.period] = {
                        allocated: b.amountAllocatedCents || 0,
                        credited: b.amountCreditedCents || 0
                    }
                }
            })

            // Sum up for each group
            groupIdsList.forEach(gid => {
                let totalGroupBudget = 0
                const branchIds = branchesInGroups[gid] || new Set<number>()
                
                branchIds.forEach(bid => {
                    periodList.forEach(period => {
                        const record = branchBudgetMatrix[bid]?.[period]
                        if (record) totalGroupBudget += record.allocated + record.credited
                    })
                })
                groupBudgetMap[gid] = totalGroupBudget
            })

            // Now fetch the branch stats for expansion view
            const allBranchStats = await db
                .select({
                    id: branches.id,
                    name: branches.name,
                    status: branches.status,
                    groupId: branches.groupId,
                    orders: sql<number>`count(${orders.id})::int`,
                    revenue: metricExpressions.revenue,
                    refunds: sql<number>`coalesce(sum(${orders.refundAmountCents}), 0)::int`,
                    rejected: sql<number>`count(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END)::int`,
                })
                .from(branches)
                .leftJoin(orders, and(
                    eq(orders.branchId, branches.id),
                    orderWhere,
                    parsedBranchIds.length > 0 ? inArray(orders.branchId, parsedBranchIds) : undefined
                ))
                .where(inArray(branches.groupId, groupIdsList))
                .groupBy(branches.id)
                .orderBy(desc(metricExpressions.revenue))

            allBranchStats.forEach(bs => {
                if (bs.groupId) {
                    if (!branchStatsMap[bs.groupId]) branchStatsMap[bs.groupId] = []
                    
                    // Calculate individual branch budget for expansion view
                    let totalBranchBudget = 0
                    periodList.forEach(period => {
                        const record = branchBudgetMatrix[bs.id]?.[period]
                        if (record) totalBranchBudget += record.allocated + record.credited
                    })

                    branchStatsMap[bs.groupId].push({
                        ...bs,
                        refunds: refundByBranchMap[bs.id] || 0,
                        totalBudget: totalBranchBudget
                    })
                }
            })
        }

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

        // Comparison logic
        let comparisonSummary = null
        if (compare && (startDate || parsedCompMonths.length > 0)) {
            let prevStart: Date, prevEnd: Date
            if (compareStartDateParam && compareEndDateParam) {
                prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam); prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
            } else if (startDate && endDate) {
                const start = parseStartDateParam(startDate) || new Date(startDate)
                const end = parseEndDateParam(endDate) || new Date(endDate)
                const duration = end.getTime() - start.getTime()
                prevStart = new Date(start.getTime() - duration - 1); prevEnd = new Date(start.getTime() - 1)
            } else {
                prevStart = new Date(); prevEnd = new Date()
            }

            const compStats = await db
                .select({
                    totalOrders: metricExpressions.totalOrderCount,
                    totalAmountCents: metricExpressions.revenue,
                })
                .from(orders)
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .where(and(
                    REVENUE_ELIGIBLE_FILTER,
                    orgId ? eq(branches.organizationId, orgId) : undefined,
                    nonDeletedGroupCondition,
                    parsedGroupIds.length > 0 ? sql`${groups.id} IN (${sql.join(parsedGroupIds, sql.raw(", "))})` : undefined,
                    parsedBranchIds.length > 0 ? sql`${branches.id} IN (${sql.join(parsedBranchIds, sql.raw(", "))})` : undefined,
                    (() => {
                        const compCond: any[] = []
                        if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                            if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                            if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                        } else {
                            compCond.push(gte(orders.createdAt, prevStart), lte(orders.createdAt, prevEnd))
                        }
                        return and(...compCond)
                    })()
                ))

            const compRefundConditions: any[] = [
                sql`COALESCE(${orders.refundAmountCents}, 0) > 0`,
                nonDeletedGroupCondition,
                orgId ? eq(branches.organizationId, orgId) : undefined,
                parsedGroupIds.length > 0 ? sql`${groups.id} IN (${sql.join(parsedGroupIds, sql.raw(", "))})` : undefined,
                parsedBranchIds.length > 0 ? sql`${branches.id} IN (${sql.join(parsedBranchIds, sql.raw(", "))})` : undefined,
                (() => {
                    const compCond: any[] = []
                    if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                        if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                        if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                    } else {
                        compCond.push(gte(orders.createdAt, prevStart), lte(orders.createdAt, prevEnd))
                    }
                    return and(...compCond)
                })()
            ]

            const compRefundStats = await db
                .select({
                    totalRefunds: sql<number>`COALESCE(SUM(${orders.refundAmountCents}), 0)::int`,
                })
                .from(orders)
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .where(and(...compRefundConditions))

            const compSummary = compStats[0]
            comparisonSummary = {
                totalOrders: compSummary?.totalOrders || 0,
                totalRevenue: compSummary?.totalAmountCents || 0,
                totalRefunds: compRefundStats[0]?.totalRefunds || 0
            }
        }

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
