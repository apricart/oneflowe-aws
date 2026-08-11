import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, branches, organizations, groups } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
import { metricExpressions, REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const pricesHidden = await shouldHidePricesForRole(userRole, userOrgId)
        const respond = (payload: any) => NextResponse.json(pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden }) : { ...payload, pricesHidden })

        const url = new URL(req.url)
        const startDateParam = url.searchParams.get("startDate")
        const endDateParam = url.searchParams.get("endDate")
        const organizationIdParam = url.searchParams.get("organizationId")
        const groupIdsParam = url.searchParams.get("groupIds")
        const branchIdsParam = url.searchParams.get("branchIds")
        
        const summaryOnly = url.searchParams.get("summaryOnly") === "true"
        const trendOnly = url.searchParams.get("trendOnly") === "true"
        const allTime = url.searchParams.get("allTime") === "true"
        
        const compare = url.searchParams.get("compare") === "true"
        const compareStartDateParam = url.searchParams.get("compareStartDate")
        const compareEndDateParam = url.searchParams.get("compareEndDate")

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")
        const compareMonthsRaw = url.searchParams.get("compareMonths")
        const compareYearsRaw = url.searchParams.get("compareYears")

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
        const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []

        // RBAC Check
        let finalOrgId = userRole === "SUPER_ADMIN" ? null : userOrgId
        if (userRole === "SUPER_ADMIN" && organizationIdParam) {
            finalOrgId = Number.parseInt(organizationIdParam)
        }

        const parsedGroupIds = groupIdsParam ? groupIdsParam.split(',').map(Number).filter(id => !Number.isNaN(id)) : []
        const parsedBranchIds = branchIdsParam ? branchIdsParam.split(',').map(Number).filter(id => !Number.isNaN(id)) : []

        const conditions: any[] = [REVENUE_ELIGIBLE_FILTER]
        if (finalOrgId) conditions.push(eq(branches.organizationId, finalOrgId))
        if (parsedGroupIds.length > 0) conditions.push(inArray(branches.groupId, parsedGroupIds))
        if (parsedBranchIds.length > 0) conditions.push(inArray(branches.id, parsedBranchIds))

        // ━━━ Mode: All Time (Year Selection) ━━━
        if (allTime) {
            const distinctYears = await db
                .select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
                .from(orders)
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .where(and(...conditions))
                .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`)
                .orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))

            return respond({
                years: distinctYears.map(y => y.year)
            })
        }

        // Date Conditions
        if (parsedMonths.length > 0) {
            conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql.raw(", "))})`)
        }
        if (parsedYears.length > 0) {
            conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql.raw(", "))})`)
        }

        if (parsedMonths.length === 0 && parsedYears.length === 0) {
            const start = parseStartDateParam(startDateParam)
            const end = parseEndDateParam(endDateParam)
            if (start) conditions.push(gte(orders.createdAt, start))
            if (end) conditions.push(lte(orders.createdAt, end))
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
                .where(and(...conditions))
                .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
                .orderBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)

            let compareTrend: any[] = []
            if (compare) {
                let prevStart: Date, prevEnd: Date
                if (compareStartDateParam && compareEndDateParam) {
                    prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam); prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
                } else if (startDateParam && endDateParam) {
                    const start = parseStartDateParam(startDateParam) || new Date(startDateParam); const end = parseEndDateParam(endDateParam) || new Date(endDateParam)
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
                    .where(and(
                        REVENUE_ELIGIBLE_FILTER,
                        finalOrgId ? eq(branches.organizationId, finalOrgId) : undefined,
                        parsedGroupIds.length > 0 ? inArray(branches.groupId, parsedGroupIds) : undefined,
                        parsedBranchIds.length > 0 ? inArray(branches.id, parsedBranchIds) : undefined,
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

        // ━━━ Mode: Summary Only (KPI Cards) ━━━
        if (summaryOnly) {
            const [stats] = await db
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

            let comparisonSummary = null
            if (compare) {
                let prevStart: Date, prevEnd: Date
                if (compareStartDateParam && compareEndDateParam) {
                    prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam); prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
                } else if (startDateParam && endDateParam) {
                    const start = parseStartDateParam(startDateParam) || new Date(startDateParam); const end = parseEndDateParam(endDateParam) || new Date(endDateParam)
                    const duration = end.getTime() - start.getTime()
                    prevStart = new Date(start.getTime() - duration - 1); prevEnd = new Date(start.getTime() - 1)
                } else {
                    prevStart = new Date(); prevEnd = new Date()
                }

                const [compStats] = await db
                    .select({
                        totalOrders: metricExpressions.totalOrderCount,
                        totalRevenue: metricExpressions.revenue,
                        totalRefunds: metricExpressions.totalRefundAmount,
                    })
                    .from(orders)
                    .innerJoin(branches, eq(orders.branchId, branches.id))
                    .where(and(
                        REVENUE_ELIGIBLE_FILTER,
                        finalOrgId ? eq(branches.organizationId, finalOrgId) : undefined,
                        parsedGroupIds.length > 0 ? inArray(branches.groupId, parsedGroupIds) : undefined,
                        parsedBranchIds.length > 0 ? inArray(branches.id, parsedBranchIds) : undefined,
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
                
                comparisonSummary = compStats
            }

            return respond({ summary: stats, comparison: comparisonSummary })
        }

        // Default: Full Report (Tier 3)
        const branchResults = await db
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
            .where(and(
                finalOrgId ? eq(branches.organizationId, finalOrgId) : undefined, 
                parsedGroupIds.length > 0 ? inArray(branches.groupId, parsedGroupIds) : undefined,
                parsedBranchIds.length > 0 ? inArray(branches.id, parsedBranchIds) : undefined
            ))
            .groupBy(branches.id, organizations.name, groups.name)
            .orderBy(desc(metricExpressions.revenue))

        return respond({ items: branchResults })

    } catch (error: any) {
        console.error("Branch Performance API failed:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
