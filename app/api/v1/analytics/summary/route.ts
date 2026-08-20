import { stringifyPrimitive } from "@/lib/stringify-primitive"
import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, users, roles, branches, organizations, groups, groupOrders, orderItems, refunds, refundItems } from "@/db/schema"
import { and, desc, eq, gte, ilike, lte, or, sql, sum, count, inArray } from "drizzle-orm"
import { metricExpressions } from "@/lib/metric-utils"
import { escapeLikePattern } from "@/lib/utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import {
    isMultiBranchAnalyticsRole,
    parseRequestedOrganizationIds,
    resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && isValid(number)) : []
}

async function loadSummaryUserContext(userId: string, fallbackRole: string) {
    try {
        const [user] = await db.select({
            branchId: users.branchId,
            organizationId: users.organizationId,
            roleName: roles.name,
        }).from(users).leftJoin(roles, eq(users.roleId, roles.id)).where(eq(users.id, userId)).limit(1)
        return {
            role: user?.roleName || fallbackRole,
            branchId: user?.branchId || null,
            organizationId: user?.organizationId || null,
        }
    } catch (caughtError) {
        console.error("Failed to fetch user context", caughtError)
        return { role: fallbackRole, branchId: null, organizationId: null }
    }
}

function addSummarySearchCondition(conditions: any[], search: string | null) {
    const normalized = search?.trim() || ""
    if (!normalized) return null
    if (normalized.length > 100) return "Search query must be at most 100 characters"
    const escaped = normalized.replace(/[\\%_]/g, String.raw`\$&`)
    const pattern = `%${escaped}%`
    conditions.push(or(
        ilike(orders.tid, pattern),
        sql`CAST(${orders.createdByUserId} AS text) ILIKE ${pattern}`,
        sql`EXISTS (
            SELECT 1 FROM ${users} AS report_users
            WHERE report_users.id = ${orders.createdByUserId}
            AND (report_users.full_name ILIKE ${pattern} OR report_users.employee_id ILIKE ${pattern})
        )`,
    ))
    return null
}

/**
 * Narrows the report to one group order, matched on the human-facing reference
 * (for example `GRP-9445434D4F`).
 *
 * Written as a subquery on `orders.groupOrderId` rather than a join because the
 * same condition list feeds the KPI, chart and table queries, which join only
 * the branch table. The lookup is pinned to the organizations already resolved
 * for the caller, so a reference belonging to another tenant matches nothing.
 */
function addSummaryGroupOrderCondition(
    conditions: any[],
    reference: string | null,
    scopedOrganizationIds: number[],
) {
    const normalized = reference?.trim() || ""
    if (!normalized) return null
    if (normalized.length > 64) return "Group order ID must be at most 64 characters"

    const pattern = `%${escapeLikePattern(normalized)}%`
    conditions.push(inArray(
        orders.groupOrderId,
        db
            .select({ id: groupOrders.id })
            .from(groupOrders)
            .where(and(
                ilike(groupOrders.reference, pattern),
                scopedOrganizationIds.length > 0
                    ? inArray(groupOrders.organizationId, scopedOrganizationIds)
                    : undefined,
            )),
    ))
    return null
}

function addSummaryStatusCondition(conditions: any[], status: string | null) {
    if (!status || status.toLowerCase() === "all") return
    conditions.push(status.toUpperCase() === "REJECTED"
        ? sql`UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED')`
        : eq(sql`UPPER(${orders.status})`, status.toUpperCase()))
}

function addSelectedSummaryScope(conditions: any[], context: any) {
    const scopedOrganizationIds = context.organizationIds
    if (scopedOrganizationIds.length > 0) conditions.push(inArray(orders.organizationId, scopedOrganizationIds))
    if (context.branchIds.length > 0) conditions.push(inArray(orders.branchId, context.branchIds))
    else if (context.branchId && !["all", "null"].includes(context.branchId)) conditions.push(eq(orders.branchId, Number(context.branchId)))
    if (context.groupIds.length > 0) conditions.push(inArray(branches.groupId, context.groupIds))
    else if (context.groupId && !["all", "null"].includes(context.groupId)) conditions.push(eq(branches.groupId, Number(context.groupId)))
}

function addSummaryScopeConditions(conditions: any[], context: any) {
    if (context.role === "SUPER_ADMIN") {
        addSelectedSummaryScope(conditions, context)
        return null
    }
    if (context.role === "HEAD_OFFICE") {
        if (context.organizationIds.length > 0) addSelectedSummaryScope(conditions, context)
        return null
    }
    if (["BRANCH_ADMIN", "BRANCH_MANAGER"].includes(context.role)) {
        if (!context.currentBranchId) return "Branch context missing"
        conditions.push(eq(orders.branchId, context.currentBranchId))
        return null
    }
    // A multi-branch role is pinned to the branches assigned to it. The tenant
    // is re-asserted alongside, so a stale assignment cannot reach another
    // organization's orders, and an empty set denies rather than widens.
    if (isMultiBranchAnalyticsRole(context.role)) {
        if (!context.assignedBranchIds?.length) return "Branch context missing"
        if (context.organizationIds.length > 0) {
            conditions.push(inArray(orders.organizationId, context.organizationIds))
        }
        conditions.push(inArray(orders.branchId, context.assignedBranchIds))
        return null
    }
    return "Access denied"
}

function addSummaryDateConditions(conditions: any[], context: any) {
    if (context.months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    }
    if (context.years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    }
    if (context.months.length > 0 || context.years.length > 0) return
    const start = context.startDate ? parseStartDateParam(context.startDate) : null
    const end = context.endDate ? parseEndDateParam(context.endDate) : null
    if (start) conditions.push(gte(orders.createdAt, start))
    if (end) conditions.push(lte(orders.createdAt, end))
}

function resolveSummaryGroupIds(groupIdsRaw: string | null, groupId: string | null) {
    if (groupIdsRaw) return parseNumberList(groupIdsRaw)
    return groupId && groupId !== "all" ? [Number(groupId)] : []
}

function buildSummaryResponse(pricesHidden: boolean, payload: any) {
    return NextResponse.json(pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden }) : { ...payload, pricesHidden })
}

function buildComparisonConditions(baseConditions: any[], context: any) {
    const conditions = baseConditions.filter((condition) => {
        const serialized = stringifyPrimitive(condition)
        return !serialized.includes("createdAt") && !serialized.includes("created_at")
            && !serialized.includes("EXTRACT(MONTH") && !serialized.includes("EXTRACT(YEAR")
    })
    addSummaryDateConditions(conditions, {
        months: context.months,
        years: context.years,
        startDate: context.explicitStart,
        endDate: context.explicitEnd,
    })
    if (context.months.length > 0 || context.years.length > 0 || (context.explicitStart && context.explicitEnd)) return conditions
    if (context.primaryStart && context.primaryEnd && context.primaryMonths.length === 0 && context.primaryYears.length === 0) {
        const start = parseStartDateParam(context.primaryStart) || new Date(context.primaryStart)
        const end = parseEndDateParam(context.primaryEnd) || new Date(context.primaryEnd)
        const duration = end.getTime() - start.getTime()
        conditions.push(gte(orders.createdAt, new Date(start.getTime() - duration - 1)), lte(orders.createdAt, new Date(start.getTime() - 1)))
    }
    return conditions
}

async function loadSummaryComparison(baseConditions: any[], context: any) {
    if (!context.enabled) return null
    const whereClause = and(...buildComparisonConditions(baseConditions, context))
    const [summaryRows, itemRows] = await Promise.all([
        db.select({
            totalSales: metricExpressions.revenue,
            orderCount: metricExpressions.orderVolume,
            refundedCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END), 0)`.mapWith(Number),
            rejectedCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END), 0)`.mapWith(Number),
            approvedCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' THEN 1 END), 0)`.mapWith(Number),
        }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause),
        db.select({ totalItemsSold: sum(orderItems.quantity) }).from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id)).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause),
    ])
    return {
        totalSales: summaryRows[0]?.totalSales || 0,
        totalOrders: summaryRows[0]?.orderCount || 0,
        refundedCount: summaryRows[0]?.refundedCount || 0,
        rejectedCount: summaryRows[0]?.rejectedCount || 0,
        approvedCount: summaryRows[0]?.approvedCount || 0,
        totalItemsSold: Number(itemRows[0]?.totalItemsSold) || 0,
    }
}

async function loadSummaryYears(whereClause: any) {
    const rows = await db.select({ year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})::int` })
        .from(orders).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause)
        .groupBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`).orderBy(desc(sql`EXTRACT(YEAR FROM ${orders.createdAt})`))
    return rows.map(({ year }) => year)
}

export async function GET(req: NextRequest) {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const userId = (session.user as any).id

    const userContext = await loadSummaryUserContext(userId, (session.user as any).role)
    const roleName = userContext.role
    const currentUserBranchId = userContext.branchId
    const currentUserOrgId = userContext.organizationId

    const url = new URL(req.url)
    const startDate = url.searchParams.get("startDate")
    const endDate = url.searchParams.get("endDate")
    const branchId = url.searchParams.get("branchId")
    const branchIdsRaw = url.searchParams.get("branchIds")
    const organizationId = url.searchParams.get("organizationId")
    const organizationIdsRaw = url.searchParams.get("organizationIds")
    const groupId = url.searchParams.get("groupId")
    const groupIdsRaw = url.searchParams.get("groupIds")
    const statusParam = url.searchParams.get("status")
    const searchParam = url.searchParams.get("q")
    const compare = url.searchParams.get("compare") === "true"
    const compareStartDateParam = url.searchParams.get("compareStartDate")
    const compareEndDateParam = url.searchParams.get("compareEndDate")

    // Parsing branchIds
    const parsedBranchIds = parseNumberList(branchIdsRaw)
    const parsedGroupIds = resolveSummaryGroupIds(groupIdsRaw, groupId)

    const page = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("page"))) || 1, 1), 10_000)
    const requestedLimit = Math.trunc(Number(url.searchParams.get("limit"))) || 50
    const limit = Math.min(Math.max(requestedLimit, 1), 100)
    const offset = (page - 1) * limit

    const monthsRaw = url.searchParams.get("months")
    const yearsRaw = url.searchParams.get("years")
    const compareMonthsRaw = url.searchParams.get("compareMonths")
    const compareYearsRaw = url.searchParams.get("compareYears")

    const requestedOrganizationIds = parseRequestedOrganizationIds({
        organizationIds: organizationIdsRaw,
        organizationId,
    })

    const parsedMonths = parseNumberList(monthsRaw, (number) => number >= 1 && number <= 12)
    const parsedYears = parseNumberList(yearsRaw, (number) => number > 2000)
    const parsedCompMonths = parseNumberList(compareMonthsRaw, (number) => number >= 1 && number <= 12)
    const parsedCompYears = parseNumberList(compareYearsRaw, (number) => number > 2000)

    const conditions: any[] = []

    const searchError = addSummarySearchCondition(conditions, searchParam)
    if (searchError) return NextResponse.json({ error: searchError }, { status: 400 })

    // Status filter
    addSummaryStatusCondition(conditions, statusParam)

    // Security: RBAC
    const normalizedRole = (roleName || "").toUpperCase().replace(/\s+/g, '_')
    const scopedOrganizationIds = resolveAnalyticsOrganizationIds({
        role: normalizedRole,
        userOrganizationId: currentUserOrgId,
        requestedOrganizationIds,
    })
    const pricesHidden = await shouldHidePricesForRole(normalizedRole, currentUserOrgId)
    const respond = (payload: any) => buildSummaryResponse(pricesHidden, payload)
    console.log(`[Summary API] User: ${userId}, Role: ${normalizedRole}, Params: Branch=${branchId}, Org=${organizationId}, Group=${groupId}`)

    const assignedBranchIds = await loadAnalyticsAssignedBranchIds(normalizedRole, userId)
    const scopeError = addSummaryScopeConditions(conditions, {
        role: normalizedRole,
        assignedBranchIds,
        organizationIds: scopedOrganizationIds,
        branchIds: parsedBranchIds,
        branchId,
        groupIds: parsedGroupIds,
        groupId,
        currentBranchId: currentUserBranchId,
    })
    if (scopeError) return NextResponse.json({ error: scopeError }, { status: 403 })

    const groupOrderError = addSummaryGroupOrderCondition(
        conditions,
        url.searchParams.get("groupOrderRef"),
        scopedOrganizationIds,
    )
    if (groupOrderError) return NextResponse.json({ error: groupOrderError }, { status: 400 })

    // Date Filtering - Inclusive
    addSummaryDateConditions(conditions, { months: parsedMonths, years: parsedYears, startDate, endDate })

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const fetchOrderPage = () => db.select({
        id: orders.id,
        tid: orders.tid,
        status: orders.status,
        totalCents: orders.totalCents,
        subtotalCents: orders.subtotalCents,
        taxCents: orders.taxCents,
        refundAmountCents: orders.refundAmountCents,
        branchId: orders.branchId,
        branchName: branches.name,
        groupName: groups.name,
        groupOrderReference: sql<string | null>`(
            SELECT ${groupOrders.reference}
            FROM ${groupOrders}
            WHERE ${groupOrders.id} = ${orders.groupOrderId}
        )`,
        organizationName: organizations.name,
        createdAt: orders.createdAt,
        fulfilledAt: orders.fulfilledAt,
        refundedAt: orders.refundedAt,
        userName: users.fullName,
        employeeId: users.employeeId,
        quantityOrdered: sql<number>`(
            SELECT COALESCE(SUM(${orderItems.quantity}), 0)
            FROM ${orderItems}
            WHERE ${orderItems.orderId} = ${orders.id}
        )`.mapWith(Number),
        quantityRefunded: sql<number>`(
            SELECT COALESCE(SUM(${refundItems.quantity}), 0)
            FROM ${refundItems}
            INNER JOIN ${refunds} ON ${refundItems.refundId} = ${refunds.id}
            WHERE ${refunds.orderId} = ${orders.id}
            AND UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')
        )`.mapWith(Number)
    })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .leftJoin(organizations, eq(orders.organizationId, organizations.id))
        .leftJoin(groups, eq(branches.groupId, groups.id))
        .leftJoin(users, eq(orders.createdByUserId, users.id))
        .where(whereClause)
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(limit)
        .offset(offset)

    if (url.searchParams.get("ordersOnly") === "true") {
        const [totalResult, recentOrders] = await Promise.all([
            db.select({ total: count(orders.id) })
                .from(orders)
                .leftJoin(branches, eq(orders.branchId, branches.id))
                .where(whereClause),
            fetchOrderPage(),
        ])
        const paginationTotal = Number(totalResult[0]?.total || 0)

        return respond({
            orders: recentOrders,
            pagination: {
                page,
                limit,
                total: paginationTotal,
                totalPages: Math.ceil(paginationTotal / limit),
                hasMore: page * limit < paginationTotal,
            },
        })
    }

    if (url.searchParams.get("allTime") === "true") return respond({ years: await loadSummaryYears(whereClause) })

    const comparisonSummary = await loadSummaryComparison(conditions, {
        enabled: compare && Boolean(startDate || compareStartDateParam || parsedCompMonths.length > 0 || parsedCompYears.length > 0),
        months: parsedCompMonths,
        years: parsedCompYears,
        explicitStart: compareStartDateParam,
        explicitEnd: compareEndDateParam,
        primaryStart: startDate,
        primaryEnd: endDate,
        primaryMonths: parsedMonths,
        primaryYears: parsedYears,
    })
    console.log(`[Summary API] Final where clause established. Filtering logic active.`)

    const isFilteredByStatus = statusParam && statusParam.toLowerCase() !== "all"

    // Aggregation Query
    const summaryResult = await db.select({
        totalSales: isFilteredByStatus
            ? sql<number>`COALESCE(SUM(${orders.totalCents}), 0)`.mapWith(Number)
            : metricExpressions.revenue,
        totalTax: sum(orders.taxCents),
        totalSubtotal: sum(orders.subtotalCents),
        orderCount: isFilteredByStatus
            ? count(orders.id)
            : metricExpressions.orderVolume,
        totalOrderCount: count(orders.id),
        totalRefunds: sum(orders.refundAmountCents),
    })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(whereClause)

    // Items Summary (Separate to avoid count multiplication by joins)
    const itemsResult = await db.select({
        totalItemsSold: sum(orderItems.quantity)
    })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(whereClause)

    const summary = {
        ...summaryResult[0],
        totalItemsSold: itemsResult[0]?.totalItemsSold || 0
    }

    // Status Distribution (ALL orders in period, ignoring pagination)
    const statusDistribution = await db.select({
        name: sql<string>`UPPER(${orders.status})`,
        value: count(orders.id)
    })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(whereClause)
        .groupBy(sql`UPPER(${orders.status})`)

    // Trend Aggregation (ALL orders in period by Month-Year)
    const trendOnly = url.searchParams.get("trendOnly") === "true"
    let trendAggregates: any[] = []
    if (trendOnly) {
        trendAggregates = await db.select({
            month: sql<number>`EXTRACT(MONTH FROM ${orders.createdAt})`,
            year: sql<number>`EXTRACT(YEAR FROM ${orders.createdAt})`,
            revenue: metricExpressions.revenue,
            orders: metricExpressions.orderVolume,
        })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .where(whereClause)
            .groupBy(sql`EXTRACT(MONTH FROM ${orders.createdAt})`, sql`EXTRACT(YEAR FROM ${orders.createdAt})`)
            .orderBy(sql`EXTRACT(YEAR FROM ${orders.createdAt})`, sql`EXTRACT(MONTH FROM ${orders.createdAt})`)
    }

    if (url.searchParams.get("summaryOnly") === "true") {
        return respond({
            summary: {
                ...summary,
                comparison: comparisonSummary,
                statusDistribution
            }
        })
    }

    if (trendOnly) {
        return respond({
            summary: {
                ...summary,
                comparison: comparisonSummary
            },
            statusDistribution,
            trend: trendAggregates
        })
    }

    // Recent Orders for Table with Branch Name and Pagination
    const recentOrders = await fetchOrderPage()

    // Branch Ranking (Top Performers) aggregated by sales volume
    const topPerformers = await db.select({
        branchId: orders.branchId,
        branchName: branches.name,
        sales: metricExpressions.revenue,
        orderCount: metricExpressions.orderVolume,
        fulfilledCount: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' THEN 1 END)`.mapWith(Number),
        rejectedCount: sql<number>`count(CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END)`.mapWith(Number),
        refundedCount: sql<number>`count(CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END)`.mapWith(Number),
    })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(whereClause)
        .groupBy(orders.branchId, branches.name)
        .orderBy(desc(metricExpressions.revenue))
        .limit(10)

    const paginationTotal = Number(summary.totalOrderCount || 0)

    return respond({
        summary: {
            ...summary,
            comparison: comparisonSummary
        },
        orders: recentOrders,
        topPerformers,
        pagination: {
            page,
            limit,
            total: paginationTotal,
            totalPages: Math.ceil(paginationTotal / limit),
            hasMore: page * limit < paginationTotal
        }
    })
}
