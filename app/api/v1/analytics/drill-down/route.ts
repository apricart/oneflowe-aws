import { NextRequest } from "next/server"
import { eq, and, gte, lte, desc, sql, inArray, gt, or } from "drizzle-orm"
import { requireApiRole, ok, error } from "@/lib/api"
import { db } from "@/lib/db"
import { orders, users, orderItems, branches, organizations, refundItems, refunds } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { resolveDrillDownSortColumn } from "@/lib/server/drill-down-sort"

const allowedRoles = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && isValid(number)) : []
}

async function verifyHeadOfficeBranch(organizationId: number | null, requestedBranchId: number) {
    if (!organizationId || !requestedBranchId) return { branchId: null }
    try {
        const [branch] = await db.select({ id: branches.id }).from(branches).where(and(
            eq(branches.id, requestedBranchId),
            eq(branches.organizationId, organizationId),
        )).limit(1)
        if (branch) return { branchId: requestedBranchId }
        console.warn(`[Security] Head Office user tried to access branch ${requestedBranchId} outside their org ${organizationId}`)
        return { error: "Access denied: Branch not found in your organization" }
    } catch (caughtError) {
        console.error("[Security] Error verifying branch access for Head Office:", caughtError)
        return { error: "Access verification failed" }
    }
}

async function resolveDrillDownScope(role: string, scope: any, context: any) {
    if (role === "BRANCH_ADMIN") {
        return { organizationId: scope?.organizationId ?? null, branchId: scope?.branchId ?? null }
    }
    if (role === "SUPER_ADMIN") {
        return {
            organizationId: context.organizationId ? Number(context.organizationId) : null,
            branchId: context.branchId ? Number(context.branchId) : null,
        }
    }
    if (role !== "HEAD_OFFICE") {
        console.warn(`[Security] Unknown role ${role} attempting to access drill-down API`)
        return { error: "Access denied: Invalid user role" }
    }
    const organizationId = scope?.organizationId ?? null
    if (!context.branchId) return { organizationId, branchId: null }
    const result = await verifyHeadOfficeBranch(organizationId, Number(context.branchId))
    return { organizationId, ...result }
}

async function resolveDrillDownBranchIds(role: string, organizationId: number | null, value: string | null) {
    const requested = parseNumberList(value)
    if (requested.length === 0 || role === "BRANCH_ADMIN") return { branchIds: [] }
    if (role === "SUPER_ADMIN") return { branchIds: requested }
    if (role !== "HEAD_OFFICE" || !organizationId) return { branchIds: [] }
    try {
        const valid = await db.select({ id: branches.id }).from(branches).where(and(
            inArray(branches.id, requested),
            eq(branches.organizationId, organizationId),
        ))
        const branchIds = valid.map((branch) => branch.id)
        const invalid = requested.filter((id) => !branchIds.includes(id))
        if (invalid.length > 0) console.warn(`[Security] Head Office user tried to access invalid branches: ${invalid.join(",")}, in org ${organizationId}`)
        return { branchIds }
    } catch (caughtError) {
        console.error("[Security] Error verifying branchIds for Head Office:", caughtError)
        return { error: "Access verification failed", branchIds: [] }
    }
}

function addDrillDownScopeConditions(conditions: any[], context: any) {
    if (context.organizationId) conditions.push(eq(orders.organizationId, context.organizationId))
    if (context.branchIds.length > 0) conditions.push(inArray(orders.branchId, context.branchIds))
    else if (context.branchId) conditions.push(eq(orders.branchId, context.branchId))
}

function addDrillDownDateConditions(conditions: any[], context: any) {
    if (context.months.length > 0) conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(context.months, sql.raw(", "))})`)
    if (context.years.length > 0) conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(context.years, sql.raw(", "))})`)
    if (context.months.length > 0 || context.years.length > 0) return
    const start = context.startDate ? parseStartDateParam(context.startDate) : null
    const end = context.endDate ? parseEndDateParam(context.endDate) : null
    if (start) conditions.push(gte(orders.createdAt, start))
    if (end) conditions.push(lte(orders.createdAt, end))
}

function addRefundTypeCondition(conditions: any[], refundType: string | undefined) {
    if (refundType === "full") {
        conditions.push(eq(sql`UPPER(${orders.status})`, "REFUNDED"))
    } else if (refundType === "partial") {
        conditions.push(and(
            gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0),
            sql`UPPER(${orders.status}) <> 'REFUNDED'`,
        ))
    } else {
        conditions.push(or(eq(sql`UPPER(${orders.status})`, "REFUNDED"), gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)))
    }
}

function addDrillDownTypeCondition(conditions: any[], type: string, refundType?: string) {
    const exactStatusTypes = ["PENDING", "APPROVED"]
    if (type === "REVENUE") conditions.push(sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
    else if (type === "FULFILLED") conditions.push(and(eq(sql`UPPER(${orders.status})`, "FULFILLED"), eq(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)))
    else if (type === "REJECTED") conditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
    else if (type === "ORDERS") conditions.push(sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED', 'FULFILLED', 'REFUNDED', 'REJECTED', 'CANCELLED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
    else if (type === "REFUNDED") addRefundTypeCondition(conditions, refundType)
    else if (type === "PARTIAL") conditions.push(or(
        and(eq(sql`UPPER(${orders.status})`, "FULFILLED"), gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)),
        inArray(sql`UPPER(${orders.status})`, ["PARTIAL", "PARTIALLY_FULFILLED"]),
    ))
    else if (exactStatusTypes.includes(type)) conditions.push(eq(sql`UPPER(${orders.status})`, type))
    else if (type === "DELIVERED") conditions.push(eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED"))
    else if (type === "NOT_DELIVERED") conditions.push(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`)
}

async function loadDrillDownItemMaps(orderIds: number[]) {
    if (orderIds.length === 0) return { detailedItems: {}, itemCounts: {} }
    const [items, counts] = await Promise.all([
        db.select({
            id: orderItems.id,
            orderId: orderItems.orderId,
            productName: orderItems.productName,
            productCode: orderItems.productCode,
            quantity: orderItems.quantity,
            priceCents: orderItems.priceCents,
            refundQuantity: sql<number>`CASE WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN COALESCE(${refundItems.quantity}, 0) ELSE 0 END`.mapWith(Number),
            refundAmountCents: sql<number>`CASE WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN COALESCE(${refundItems.amountCents}, 0) ELSE 0 END`.mapWith(Number),
        }).from(orderItems).leftJoin(refundItems, eq(orderItems.id, refundItems.orderItemId))
            .leftJoin(refunds, eq(refundItems.refundId, refunds.id)).where(inArray(orderItems.orderId, orderIds.slice(0, 100))),
        db.select({
            orderId: orderItems.orderId,
            totalQty: sql<number>`COALESCE(sum(COALESCE(${orderItems.quantity}, 0)), 0)::numeric`.mapWith(Number),
        }).from(orderItems).where(inArray(orderItems.orderId, orderIds)).groupBy(orderItems.orderId),
    ])
    const detailedItems: Record<number, any[]> = {}
    items.forEach((item) => {
        if (!item.orderId) return
        detailedItems[item.orderId] ??= []
        const existing = detailedItems[item.orderId].find((candidate) => candidate.id === item.id)
        if (existing) {
            existing.quantity = Math.max(Number(existing.quantity) || 0, Number(item.quantity) || 0)
            existing.refundQuantity += item.refundQuantity
            existing.refundAmount += item.refundAmountCents / 100
        } else {
            detailedItems[item.orderId].push({
                id: item.id,
                name: item.productName,
                productCode: item.productCode,
                quantity: item.quantity,
                price: item.priceCents / 100,
                refundQuantity: item.refundQuantity,
                refundAmount: item.refundAmountCents / 100,
            })
        }
    })
    return {
        detailedItems,
        itemCounts: Object.fromEntries(counts.filter((row) => row.orderId).map((row) => [row.orderId, row.totalQty || 0])),
    }
}

function updateDrillDownBranchStats(stats: any, order: any, status: string, total: number, refund: number) {
    if (!order.branchId) return
    stats[order.branchId] ??= { name: order.branchName || "Unknown", total: 0, refunds: 0, count: 0 }
    const branch = stats[order.branchId]
    branch.count++
    if (!["FULFILLED", "REFUNDED"].includes(status)) return
    branch.total += total
    if (status === "REFUNDED") branch.refunds += refund
}

function calculateDrillDownSummary(rawData: any[], itemCounts: Record<number, number>) {
    const totals = {
        gross: 0, refunds: 0, rejected: 0, discount: 0, processingSeconds: 0, processingCount: 0,
        items: 0, fulfilled: 0, refundedOrders: 0, refundRelated: 0, refundedValue: 0,
    }
    const branchStats: Record<number, any> = {}
    const hourly: Record<number, number> = {}
    rawData.forEach((order) => {
        const total = (order.totalCents || 0) / 100
        const refund = (order.refundAmountCents || 0) / 100
        const status = (order.status || "").toUpperCase()
        totals.items += itemCounts[order.id] || 0
        if (["FULFILLED", "APPROVED", "PARTIAL", "PARTIALLY_FULFILLED"].includes(status)) {
            totals.gross += total
            totals.refunds += refund
            if (["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"].includes(status)) totals.fulfilled++
        }
        if (status === "REFUNDED") totals.refundedOrders++
        if (refund > 0) { totals.refundRelated++; totals.refundedValue += refund }
        if (["REJECTED", "CANCELLED"].includes(status)) totals.rejected += total
        totals.discount += order.receiptData?.discount || 0
        if (order.createdAt) {
            const hour = new Date(order.createdAt).getHours()
            hourly[hour] = (hourly[hour] || 0) + total
        }
        if (order.createdAt && order.fulfilledAt) {
            const elapsed = new Date(order.fulfilledAt).getTime() - new Date(order.createdAt).getTime()
            if (elapsed >= 0) { totals.processingSeconds += Math.round(elapsed / 1000); totals.processingCount++ }
        }
        updateDrillDownBranchStats(branchStats, order, status, total, refund)
    })
    const peak = Object.entries(hourly).sort((left, right) => right[1] - left[1])[0]?.[0]
    const branchList = Object.entries(branchStats).map(([id, values]: [string, any]) => ({ id, ...values }))
    return {
        grossRevenue: totals.gross,
        netRevenue: totals.gross - totals.refunds,
        refundRate: totals.gross > 0 ? totals.refunds / totals.gross * 100 : 0,
        leakage: totals.rejected + totals.discount,
        discountImpact: totals.discount,
        avgProcessingTime: totals.processingCount > 0 ? Math.round(totals.processingSeconds / totals.processingCount / 60) : 0,
        totalItems: totals.items,
        fulfilledOrderCount: totals.fulfilled,
        refundedOrdersCount: totals.refundedOrders,
        refundRelatedOrdersCount: totals.refundRelated,
        refundedValue: totals.refundedValue,
        peakPeriod: peak ? `${peak}:00 - ${Number(peak) + 1}:00` : "N/A",
        topBranch: branchList.toSorted((left, right) => right.total - left.total)[0]?.name || "N/A",
        problematicBranch: branchList.toSorted((left, right) => right.refunds / (right.total || 1) - left.refunds / (left.total || 1))[0]?.name || "N/A",
    }
}

function formatDrillDownRows(rawData: any[], itemCounts: any, detailedItems: any) {
    return rawData.slice(0, 100).map((order) => {
        const gross = (order.totalCents || 0) / 100
        const refund = (order.refundAmountCents || 0) / 100
        const fulfilled = order.fulfilledAt ? new Date(order.fulfilledAt) : null
        const preparationTime = fulfilled
            ? `${Math.round((fulfilled.getTime() - new Date(order.createdAt).getTime()) / 60000)} mins`
            : "N/A"
        return {
            id: order.id,
            tid: order.tid,
            status: order.status,
            fulfillmentStatus: order.fulfillmentStatus,
            date: order.createdAt,
            approvedAt: order.approvedAt,
            branchName: order.branchName,
            organizationName: order.organizationName || order.receiptData?.organizationName,
            netValue: gross - refund,
            grossValue: gross,
            refundAmount: refund,
            skuCount: itemCounts[order.id] || 0,
            customerLevel: order.id % 5 === 0 ? "VIP" : "Regular",
            preparationTime,
            buyerName: order.receiptData?.buyerName || order.creatorName || "Walk-in Customer",
            buyerPhone: order.receiptData?.buyerPhone || order.creatorPhone || "N/A",
            creatorName: order.creatorName,
            creatorEmployeeId: order.creatorEmployeeId,
            items: detailedItems[order.id] || [],
        }
    })
}

function resolveDrillDownComparisonRange(context: any) {
    if (context.explicitStart && context.explicitEnd) {
        return {
            start: parseStartDateParam(context.explicitStart) || new Date(context.explicitStart),
            end: parseEndDateParam(context.explicitEnd) || new Date(context.explicitEnd),
        }
    }
    const start = parseStartDateParam(context.startDate) || new Date(context.startDate)
    const end = parseEndDateParam(context.endDate) || new Date(context.endDate)
    const duration = end.getTime() - start.getTime()
    return { start: new Date(start.getTime() - duration - 1), end: new Date(start.getTime() - 1) }
}

function calculateDrillDownComparison(data: any[], itemCount: number) {
    const totals = data.reduce((aggregate, order) => {
        const gross = (order.totalCents || 0) / 100
        const refund = (order.refundAmountCents || 0) / 100
        const status = (order.status || "").toUpperCase()
        if (["FULFILLED", "APPROVED", "PARTIAL", "PARTIALLY_FULFILLED"].includes(status)) {
            aggregate.gross += gross
            aggregate.refund += refund
        } else if (status === "REFUNDED") aggregate.refund += refund
        else if (["REJECTED", "CANCELLED"].includes(status)) aggregate.rejected += gross
        aggregate.discount += order.receiptData?.discount || 0
        return aggregate
    }, { gross: 0, refund: 0, rejected: 0, discount: 0 })
    return {
        grossRevenue: totals.gross,
        netRevenue: totals.gross - totals.refund,
        totalItems: itemCount,
        totalOrders: data.length,
        leakage: totals.rejected + totals.discount,
    }
}

async function loadDrillDownComparison(context: any) {
    if (!context.enabled) return null
    const conditions: any[] = []
    addDrillDownScopeConditions(conditions, context)
    addDrillDownDateConditions(conditions, {
        months: context.months,
        years: context.years,
        startDate: context.range.start.toISOString(),
        endDate: context.range.end.toISOString(),
    })
    addDrillDownTypeCondition(conditions, context.type)
    const data = await db.select({
        id: orders.id,
        status: orders.status,
        totalCents: orders.totalCents,
        refundAmountCents: orders.refundAmountCents,
        createdAt: orders.createdAt,
        fulfilledAt: orders.fulfilledAt,
        receiptData: orders.receiptData,
    }).from(orders).where(and(...conditions))
    const orderIds = data.map((order) => order.id)
    const [countRow] = orderIds.length > 0
        ? await db.select({ value: sql<number>`count(${orderItems.id})` }).from(orderItems).where(inArray(orderItems.orderId, orderIds))
        : [{ value: 0 }]
    return calculateDrillDownComparison(data, Number(countRow?.value || 0))
}

// BI Analytics Drill-down API - Robust & Parity Sync
export async function GET(req: NextRequest) {
    const err = await requireApiRole(allowedRoles as any)
    if (err) return err

    const scope = await getRequestScope()
    const role = (scope?.role || "").toUpperCase().replace(/\s+/g, '_')
    const pricesHidden = await shouldHidePricesForRole(role, scope?.organizationId)

    const { searchParams } = new URL(req.url)
    const type = searchParams.get("type")?.toUpperCase() // REVENUE, REJECTED, FULFILLED, ORDERS
    const orgIdParam = searchParams.get("organizationId")
    const branchIdParam = searchParams.get("branchId")
    const branchIdsParam = searchParams.get("branchIds")
    const startDateParam = searchParams.get("startDate")
    const endDateParam = searchParams.get("endDate")
    const compareStartDateParam = searchParams.get("compareStartDate")
    const compareEndDateParam = searchParams.get("compareEndDate")

    const monthsRaw = searchParams.get("months")
    const yearsRaw = searchParams.get("years")
    const compareMonthsRaw = searchParams.get("compareMonths")
    const compareYearsRaw = searchParams.get("compareYears")

    const parsedMonths = parseNumberList(monthsRaw, (number) => number >= 1 && number <= 12)
    const parsedYears = parseNumberList(yearsRaw, (number) => number > 2000)
    const parsedCompMonths = parseNumberList(compareMonthsRaw, (number) => number >= 1 && number <= 12)
    const parsedCompYears = parseNumberList(compareYearsRaw, (number) => number > 2000)
    const refundType = searchParams.get("refundType")?.toLowerCase() // all, full, partial
    const sortColumn = resolveDrillDownSortColumn(searchParams.get("sortBy"))
    if (!type || !["REVENUE", "REJECTED", "FULFILLED", "ORDERS", "REFUNDED", "PENDING", "APPROVED", "PARTIAL", "DELIVERED", "NOT_DELIVERED"].includes(type)) {
        return error("Invalid or missing drill-down type")
    }

    const normalizedOrgParam = orgIdParam && !["null", "0", "undefined"].includes(orgIdParam) ? orgIdParam : null
    const normalizedBranchParam = branchIdParam && !["null", "0"].includes(branchIdParam) ? branchIdParam : null
    const resolvedScope = await resolveDrillDownScope(role, scope, {
        organizationId: normalizedOrgParam,
        branchId: normalizedBranchParam,
    })
    if (resolvedScope.error) return error(resolvedScope.error)
    const organizationId = resolvedScope.organizationId ?? null
    const branchId = resolvedScope.branchId ?? null
    const resolvedBranches = await resolveDrillDownBranchIds(role, organizationId, branchIdsParam)
    if (resolvedBranches.error) return error(resolvedBranches.error)
    const branchIds = resolvedBranches.branchIds

    const conditions: any[] = []

    addDrillDownScopeConditions(conditions, { organizationId, branchIds, branchId })
    addDrillDownDateConditions(conditions, { months: parsedMonths, years: parsedYears, startDate: startDateParam, endDate: endDateParam })
    addDrillDownTypeCondition(conditions, type, refundType)

    try {
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        // BI aggregates and raw data
        const rawData = await db.select({
            id: orders.id,
            tid: orders.tid,
            status: orders.status,
            fulfillmentStatus: orders.fulfillmentStatus,
            totalCents: orders.totalCents,
            subtotalCents: orders.subtotalCents,
            taxCents: orders.taxCents,
            refundAmountCents: orders.refundAmountCents,
            createdAt: orders.createdAt,
            approvedAt: orders.approvedAt,
            fulfilledAt: orders.fulfilledAt,
            branchId: orders.branchId,
            branchName: branches.name,
            organizationName: organizations.name,
            receiptData: orders.receiptData,
            creatorName: users.fullName,
            creatorPhone: users.phone,
            creatorEmployeeId: users.employeeId
        })
            .from(orders)
            .leftJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(organizations, eq(orders.organizationId, organizations.id))
            .leftJoin(users, eq(orders.createdByUserId, users.id))
            .where(whereClause)
            .orderBy(desc(sortColumn))
            .limit(1000) // Increase limit for aggregation accuracy

        const orderIds = rawData.map((order) => order.id)
        const { detailedItems, itemCounts } = await loadDrillDownItemMaps(orderIds)
        const summary = calculateDrillDownSummary(rawData, itemCounts)
        const formattedData = formatDrillDownRows(rawData, itemCounts, detailedItems)
        const comparisonEnabled = searchParams.get("compare") === "true" && Boolean(startDateParam && endDateParam)
        const comparisonRange = comparisonEnabled ? resolveDrillDownComparisonRange({
            explicitStart: compareStartDateParam,
            explicitEnd: compareEndDateParam,
            startDate: startDateParam,
            endDate: endDateParam,
        }) : null
        const comparisonSummary = await loadDrillDownComparison({
            enabled: comparisonEnabled,
            organizationId,
            branchIds,
            branchId,
            months: parsedCompMonths,
            years: parsedCompYears,
            range: comparisonRange,
            type,
        })
        const payload = { items: formattedData, summary, comparison: comparisonSummary, total: rawData.length, pricesHidden }
        return ok(pricesHidden ? redactAnalyticsPrices(payload) : payload)
    } catch (e) {
        console.error("[DrillDown] Error:", e)
        return error("Internal BI processing error")
    }
}
