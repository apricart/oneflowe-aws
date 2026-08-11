import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, users, branches, roles, organizations } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

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

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")
        const userIdsRaw = url.searchParams.get("userIds")
        const groupIdsRaw = url.searchParams.get("groupIds")
        const compareMonthsRaw = url.searchParams.get("compareMonths")
        const compareYearsRaw = url.searchParams.get("compareYears")

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
        const userIds = userIdsRaw ? userIdsRaw.split(',').filter(id => id.length > 5) : [] 
        const groupIds = groupIdsRaw ? groupIdsRaw.split(',').map(Number).filter(n => !Number.isNaN(n)) : []
        const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []

        // RBAC & Filter Context Parsing
        let organizationIds: number[] = []
        if (organizationIdsParam) {
            organizationIds = organizationIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        } else if (userOrgId) {
            organizationIds = [userOrgId]
        }

        let branchIds: number[] = []
        if (branchIdsParam) {
            branchIds = branchIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        } else if (groupIds.length > 0) {
            const b = await db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, groupIds))
            branchIds = b.map(br => br.id)
        } else if (userRole === "BRANCH_ADMIN" || userRole === "BRANCH_MANAGER" || userRole === "ORDER_PORTAL") {
            branchIds = [userBranchId]
        } else if (organizationIds.length > 0) {
            const b = await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
            branchIds = b.map(br => br.id)
        } else if (userOrgId) {
            const b = await db.select({ id: branches.id }).from(branches).where(eq(branches.organizationId, userOrgId))
            branchIds = b.map(br => br.id)
        } else {
            // Super admin with no filters -> all branches (caution: high volume)
            const b = await db.select({ id: branches.id }).from(branches)
            branchIds = b.map(br => br.id)
        }

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches resolved" }, { status: 400 })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions: any[] = [inArray(orders.branchId, branchIds)]
        
        if (userIds.length > 0) {
            baseConditions.push(inArray(orders.createdByUserId, userIds))
        }
        if (parsedMonths.length > 0) {
            baseConditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql.raw(", "))})`)
        }
        if (parsedYears.length > 0) {
            baseConditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql.raw(", "))})`)
        }

        if (parsedMonths.length === 0 && parsedYears.length === 0) {
            if (startDate) baseConditions.push(gte(orders.createdAt, startDate))
            if (endDate) baseConditions.push(lte(orders.createdAt, endDate))
        }

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
        let comparisonSummary = null
        if (compare && startDateParam && endDateParam) {
            let prevEnd: Date
            
            if (compareStartDateParam && compareEndDateParam) {
                prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
            } else {
                const start = parseStartDateParam(startDateParam) || new Date(startDateParam)
                const end = parseEndDateParam(endDateParam) || new Date(endDateParam)
                const duration = end.getTime() - start.getTime()
                prevEnd = new Date(start.getTime() - 1)
            }

            const [compStats] = await db
                .select({
                    compOrders: metricExpressions.totalOrderCount,
                    compFulfilled: metricExpressions.fulfilledCount,
                    compSpent: metricExpressions.revenue,
                    compUsers: sql<number>`count(distinct ${orders.createdByUserId})`.mapWith(Number)
                })
                .from(orders)
                .innerJoin(users, eq(orders.createdByUserId, users.id))
                .innerJoin(roles, eq(users.roleId, roles.id))
                .where(
                    and(
                        inArray(orders.branchId, branchIds),
                        eq(roles.name, "ORDER_PORTAL"),
                        (() => {
                            const compCond: any[] = []
                            if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                                if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                                if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                            } else if (prevEnd) {
                                compCond.push(lte(orders.createdAt, prevEnd))
                            }
                            if (userIds.length > 0) {
                                compCond.push(inArray(orders.createdByUserId, userIds))
                            }
                            return and(...compCond)
                        })()
                    )
                )

            comparisonSummary = {
                totalOrders: Number(compStats?.compOrders || 0),
                totalFulfilled: Number(compStats?.compFulfilled || 0),
                totalSpentCents: Number(compStats?.compSpent || 0),
                totalUsers: Number(compStats?.compUsers || 0)
            }
        }

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
            let compareTrend: any[] = []
            if (compare && (parsedCompMonths.length > 0 || parsedCompYears.length > 0 || (compareStartDateParam && compareEndDateParam))) {
                compareTrend = await db
                    .select({
                        date: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
                        revenue: metricExpressions.revenue,
                        qtyOrdered: metricExpressions.totalOrderCount,
                    })
                    .from(orders)
                    .innerJoin(users, eq(orders.createdByUserId, users.id))
                    .innerJoin(roles, eq(users.roleId, roles.id))
                    .where(
                        and(
                            inArray(orders.branchId, branchIds),
                            eq(roles.name, "ORDER_PORTAL"),
                            (() => {
                                const compCond: any[] = []
                                if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                                    if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                                    if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                                } else {
                                    const cEnd = parseEndDateParam(compareEndDateParam!)
                                    if (cEnd) compCond.push(lte(orders.createdAt, cEnd))
                                }
                                if (userIds.length > 0) {
                                    compCond.push(inArray(orders.createdByUserId, userIds))
                                }
                                return and(...compCond)
                            })()
                        )
                    )
                    .groupBy(sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)
            }

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
