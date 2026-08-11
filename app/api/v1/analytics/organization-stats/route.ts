import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, users, branches, organizations } from "@/db/schema"
import { and, eq, gte, lte, sql, count, inArray, isNull } from "drizzle-orm"
import { metricExpressions } from "@/lib/metric-utils"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { shouldIncludeHeadOfficeUsers } from "@/lib/organization-report-scope"

export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const url = new URL(req.url)
    const startDateParam = url.searchParams.get("startDate")
    const endDateParam = url.searchParams.get("endDate")
    const compare = url.searchParams.get("compare") === "true"
    const compareStartDateParam = url.searchParams.get("compareStartDate")
    const compareEndDateParam = url.searchParams.get("compareEndDate")
    
    const orgIdsParam = url.searchParams.get("organizationIds")
    const orgIdParam = url.searchParams.get("organizationId")
    const groupIdsParam = url.searchParams.get("groupIds")
    const branchIdsParam = url.searchParams.get("branchIds")
    const statusParam = url.searchParams.get("status") // branch status

    const monthsRaw = url.searchParams.get("months")
    const yearsRaw = url.searchParams.get("years")
    const compareMonthsRaw = url.searchParams.get("compareMonths")
    const compareYearsRaw = url.searchParams.get("compareYears")

    const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
    const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
    const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
    const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []

    const userRole = (session.user as any).role || ""
    const userOrgId = (session.user as any).organizationId

    const branchConditions = []
    
    // RBAC: If not super admin, must filter by user's organization
    if (userRole !== "SUPER_ADMIN" && userOrgId) {
        branchConditions.push(eq(branches.organizationId, userOrgId))
    }

    if (orgIdsParam) {
        const ids = orgIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n))
        if (ids.length > 0) {
            branchConditions.push(inArray(branches.organizationId, ids))
        }
    } else if (orgIdParam && orgIdParam !== "all" && orgIdParam !== "0") {
        branchConditions.push(eq(branches.organizationId, Number(orgIdParam)))
    }
    
    if (branchIdsParam) {
        const ids = branchIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n))
        if (ids.length > 0) {
            branchConditions.push(inArray(branches.id, ids))
        }
    }

    if (groupIdsParam) {
        const ids = groupIdsParam.split(",").map(Number).filter(n => !Number.isNaN(n) && n > 0)
        if (ids.length > 0) {
            branchConditions.push(inArray(branches.groupId, ids))
        }
    }
    
    if (statusParam && statusParam !== "all") {
        branchConditions.push(eq(branches.status, statusParam))
    }

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
        
        // Date filtering logic
        if (mArray.length > 0) {
            conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(mArray, sql.raw(", "))})`)
        }
        if (yArray.length > 0) {
            conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(yArray, sql.raw(", "))})`)
        }
        
        // Fallback to explicit dates if no arrays provided
        if (mArray.length === 0 && yArray.length === 0 && start && end) {
            const startBoundary = parseStartDateParam(start)
            const endBoundary = parseEndDateParam(end)
            if (startBoundary) conditions.push(gte(orders.createdAt, startBoundary))
            if (endBoundary) conditions.push(lte(orders.createdAt, endBoundary))
        } else if (mArray.length === 0 && yArray.length === 0 && !start && !end) {
            // No filters provided (All Time implies no conditions on createdAt)
        }

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

    // 3. Aggregate data by Organization for the Table
    const orgMap: Record<number, any> = {}

    branchStats.forEach(b => {
        const orgId = b.organizationId || 0
        if (!orgMap[orgId]) {
            orgMap[orgId] = {
                organizationId: orgId,
                organizationName: b.organizationName || "Unknown Organization",
                organizationStatus: b.organizationStatus || "active",
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
                comparison: compare ? {
                    revenue: 0,
                    orderCount: 0,
                    fulfilledCount: 0,
                    refundedCount: 0
                } : null
            }
        }

        const org = orgMap[orgId]
        org.branchCount++
        if (b.branchStatus === 'active') org.activeBranchCount++
        else org.inactiveBranchCount++

        org.totalUserCount += b.totalUserCount
        org.activeUserCount += b.activeUserCount

        const mA = metricsA.find(m => m.branchId === b.branchId)
        if (mA) {
            org.revenue += (mA.revenueCents || 0) / 100
            org.orderCount += (mA.orderCount || 0)
            org.fulfilledCount += (mA.fulfilledCount || 0)
            org.refundedCount += (mA.refundedCount || 0)
            org.refundedRevenue += (mA.refundedRevenueCents || 0) / 100
        }

        if (compare) {
            const mB = metricsB.find(m => m.branchId === b.branchId)
            if (mB) {
                org.comparison.revenue += (mB.revenueCents || 0) / 100
                org.comparison.orderCount += (mB.orderCount || 0)
                org.comparison.fulfilledCount += (mB.fulfilledCount || 0)
                org.comparison.refundedCount += (mB.refundedCount || 0)
            }
        }
    })

    // Add head office users into each org's totals
    headOfficeUserRows.forEach(ho => {
        if (ho.organizationId != null && orgMap[ho.organizationId]) {
            orgMap[ho.organizationId].totalUserCount += ho.totalUserCount
            orgMap[ho.organizationId].activeUserCount += ho.activeUserCount
        }
    })

    const results = Object.values(orgMap)

    const forcedGranularity = url.searchParams.get("granularity") as "daily" | "monthly" | "yearly" | null
    const isValidGranularity = ["daily", "monthly", "yearly"].includes(forcedGranularity || "")

    // 4. Fetch Trend Data for Charts (Keep grouped by date)
    const fetchTrend = async (start: string | null, end: string | null, mArray: number[] = [], yArray: number[] = []) => {
        if (branchIdsInScope.length === 0) return []
        const conditions: any[] = [inArray(orders.branchId, branchIdsInScope)]
        
        let grouping = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM')`
        
        if (isValidGranularity) {
            if (forcedGranularity === "yearly") {
                grouping = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`
            } else if (forcedGranularity === "daily") {
                grouping = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`
            }
        } else if (mArray.length > 0) {
            // Month filter active
            const isMonthly = mArray.length > 1 || yArray.length > 1
            grouping = isMonthly 
                ? sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM')`
                : sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD')`
        } else if (yArray.length > 0) {
            // Year filter active
            const isYearly = yArray.length > 1
            grouping = isYearly 
                ? sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`
                : sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY-MM')`
        } else if (!start && !end) {
            // "All Time" default
            grouping = sql`TO_CHAR((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi', 'YYYY')`
        }

        if (mArray.length > 0) conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(mArray, sql.raw(", "))})`)
        if (yArray.length > 0) conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(yArray, sql.raw(", "))})`)
        
        if (mArray.length === 0 && yArray.length === 0 && start && end) {
            const startBoundary = parseStartDateParam(start)
            const endBoundary = parseEndDateParam(end)
            if (startBoundary) conditions.push(gte(orders.createdAt, startBoundary))
            if (endBoundary) conditions.push(lte(orders.createdAt, endBoundary))
        }

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
