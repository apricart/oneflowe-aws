import { NextRequest } from "next/server"
import { and,eq,gte,lte,sql,or,inArray,desc } from "drizzle-orm"
import { requireApiRole,ok,error } from "@/lib/api"
import { db } from "@/lib/db"
import { orders,branches,organizations,orderItems,refunds,refundItems } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { getCached,generateCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { metricExpressions } from "@/lib/metric-utils"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const
type Role = typeof allowedRoles[number]

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && isValid(number)) : []
}

async function resolveSalesScope(role: Role | undefined, scope: any, searchParams: URLSearchParams) {
    if (role === "BRANCH_ADMIN") {
        return { organizationId: scope?.organizationId ?? null, branchId: scope?.branchId ?? null }
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
    try {
        const [allowedBranch] = await db.select({ id: branches.id }).from(branches).where(and(
            eq(branches.id, branchId),
            eq(branches.organizationId, organizationId),
        )).limit(1)
        return allowedBranch
            ? { organizationId, branchId }
            : { error: "Access denied: Branch not found in your organization" }
    } catch (caughtError) {
        console.error("[Security] Error verifying branch access for Head Office:", caughtError)
        return { error: "Access verification failed" }
    }
}

function resolveSalesGranularity(
    forced: string | null,
    months: number[],
    years: number[],
    differenceInDays: number,
): "hourly" | "daily" | "monthly" | "yearly" {
    if (["hourly", "daily", "monthly", "yearly"].includes(forced || "")) {
        return forced as "hourly" | "daily" | "monthly" | "yearly"
    }
    if (months.length > 0) return months.length > 1 || years.length > 1 ? "monthly" : "daily"
    if (years.length > 0) return years.length > 1 ? "yearly" : "monthly"
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
        fulfilledCount: metricExpressions.fulfilledCount,
        partialCount: metricExpressions.partialCount,
        fulfilledNetSales: metricExpressions.revenue,
        refundedCount: metricExpressions.refundedCount,
        rejectedCount: metricExpressions.rejectedCount,
        approvedCount: metricExpressions.approvedCount,
        pendingCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
        deliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
        notDeliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
    }).from(orders).leftJoin(branches, eq(orders.branchId, branches.id)).where(whereClause)
    return counts
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
    const branchIds = parseNumberList(branchIdsParam)
    const organizationIds = parseNumberList(organizationIdsParam)

    if (groupIdParam && groupIdParam !== "null" && groupIdParam !== "0") {
        groupId = Number(groupIdParam)
    }

    const groupIds = groupIdsParam ? parseNumberList(groupIdsParam) : groupId ? [groupId] : []

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
        const dashboardCreatedAt = sql`(${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`

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

        if (organizationIds.length > 0) {
            branchQuery = branchQuery.where(inArray(branches.organizationId, organizationIds)) as any
        } else if (organizationId) {
            branchQuery = branchQuery.where(eq(branches.organizationId, organizationId)) as any
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
        } | null> => {

        if (includeStatusCounts && (!statusParam || statusParam.toUpperCase() === "ALL")) {
            const [counts] = await db.select({
                pendingCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
                approvedCount: metricExpressions.approvedCount,
                fulfilledCount: metricExpressions.fulfilledCount,
                partialCount: metricExpressions.partialCount,
                refundedCount: metricExpressions.refundedCount,
                rejectedCount: metricExpressions.rejectedCount,
                deliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
                notDeliveredCount: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'APPROVED' AND UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED' THEN 1 END), 0)`.mapWith(Number),
            })
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
                }
            }
        }
        return null
        })()

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
        }
    }

    const data = await getCached(cacheKey, fetchData, CACHE_TTL.ANALYTICS)
    return ok(pricesHidden ? redactAnalyticsPrices({ ...data, pricesHidden }) : { ...data, pricesHidden })
}
