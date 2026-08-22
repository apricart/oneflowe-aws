import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, branches, users, globalProducts, categories, refundItems, refunds, groups, organizations } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql, ilike, or } from "drizzle-orm"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { escapeLikePattern } from "@/lib/utils"
import {
    isBranchScopedAnalyticsRole,
    resolveAnalyticsBranchIds,
    resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"

type RefundQuantity = { qty: number; amount: number }

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value
        ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && isValid(number))
        : []
}

function getRequestedOrganizationIds(organizationIds: string | null, organizationId: string | null) {
    if (organizationIds) return organizationIds.split(",").map(Number)
    return organizationId ? [Number(organizationId)] : []
}

async function getScopedBranchIds({
    userRole,
    userBranchId,
    requestedBranchIds,
    scopedOrganizationIds,
    groupIds,
    assignedBranchIds,
}: {
    userRole: string
    userBranchId: unknown
    requestedBranchIds: number[]
    scopedOrganizationIds: number[]
    groupIds: number[]
    assignedBranchIds: number[] | null
}) {
    let allowedBranchQuery = db.select({ id: branches.id }).from(branches)
    if (scopedOrganizationIds.length > 0) {
        allowedBranchQuery = allowedBranchQuery
            .where(inArray(branches.organizationId, scopedOrganizationIds)) as any
    }

    const allowedBranches = await allowedBranchQuery
    let branchIds = resolveAnalyticsBranchIds({
        role: userRole,
        userBranchId,
        requestedBranchIds,
        allowedBranchIds: allowedBranches.map((branch) => branch.id),
        assignedBranchIds,
    })

    if (groupIds.length === 0) return branchIds

    const groupBranches = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(
            inArray(branches.groupId, groupIds),
            scopedOrganizationIds.length > 0
                ? inArray(branches.organizationId, scopedOrganizationIds)
                : undefined,
        ))
    const groupBranchIds = new Set(groupBranches.map((branch) => branch.id))
    branchIds = branchIds.filter((branchId) => groupBranchIds.has(branchId))
    return branchIds
}

function addPeriodConditions(
    conditions: any[],
    months: number[],
    years: number[],
    startDate: Date | null | undefined,
    endDate: Date | null | undefined,
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

function buildItemizedConditions({
    branchIds,
    months,
    years,
    startDate,
    endDate,
    productIds,
    scopedOrganizationIds,
    searchTerm,
}: {
    branchIds: number[]
    months: number[]
    years: number[]
    startDate: Date | null | undefined
    endDate: Date | null | undefined
    productIds: number[]
    scopedOrganizationIds: number[]
    searchTerm: string
}) {
    const conditions: any[] = [
        inArray(orders.branchId, branchIds),
        inArray(orders.status, ['FULFILLED', 'APPROVED', 'REFUNDED', 'PENDING', 'REJECTED', 'CANCELLED']),
    ]
    addPeriodConditions(conditions, months, years, startDate, endDate)
    if (productIds.length > 0) conditions.push(inArray(orderItems.globalProductId, productIds))
    if (scopedOrganizationIds.length > 0) conditions.push(inArray(orders.organizationId, scopedOrganizationIds))
    if (!searchTerm) return conditions

    conditions.push(or(
        ilike(orderItems.productName, `%${searchTerm}%`),
        ilike(orderItems.productCode, `%${searchTerm}%`),
        ilike(globalProducts.name, `%${searchTerm}%`),
        ilike(globalProducts.productCode, `%${searchTerm}%`),
        ilike(users.fullName, `%${searchTerm}%`),
        ilike(users.email, `%${searchTerm}%`),
        ilike(users.employeeId, `%${searchTerm}%`),
        ilike(orders.tid, `%${searchTerm}%`),
        ilike(branches.name, `%${searchTerm}%`),
        ilike(organizations.name, `%${searchTerm}%`),
        ilike(groups.name, `%${searchTerm}%`),
    ))
    return conditions
}

async function getRefundQuantities(orderItemIds: number[]) {
    if (orderItemIds.length === 0) return {} as Record<number, RefundQuantity>

    const refundRows = await db
        .select({
            orderItemId: refundItems.orderItemId,
            qty: refundItems.quantity,
            amount: refundItems.amountCents,
        })
        .from(refundItems)
        .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
        .where(and(
            inArray(refundItems.orderItemId, orderItemIds),
            inArray(sql`UPPER(${refunds.status})`, ['APPROVED', 'COMPLETED']),
        ))

    return refundRows.reduce((acc, current) => {
        if (!current.orderItemId) return acc
        acc[current.orderItemId] = {
            qty: (acc[current.orderItemId]?.qty || 0) + current.qty,
            amount: (acc[current.orderItemId]?.amount || 0) + (current.amount || 0),
        }
        return acc
    }, {} as Record<number, RefundQuantity>)
}

function getFulfilmentValues(row: any, refundData: RefundQuantity, totalItemValue: number) {
    const valueRefundedCents = Math.min(totalItemValue, refundData.amount || (refundData.qty * row.priceCents))
    const effectiveRefundedQty = Math.min(row.qtyOrdered, refundData.qty)
    const values = {
        qtyDelivered: row.qtyOrdered,
        valueFulfilledCents: 0,
        valueRejectedCents: 0,
        valuePendingCents: 0,
        valueRefundedCents,
    }

    if (['FULFILLED', 'REFUNDED', 'APPROVED'].includes(row.status)) {
        values.qtyDelivered = Math.max(0, row.qtyOrdered - effectiveRefundedQty)
        values.valueFulfilledCents = Math.max(0, totalItemValue - valueRefundedCents)
    } else if (['REJECTED', 'CANCELLED'].includes(row.status)) {
        values.valueRejectedCents = totalItemValue
        values.qtyDelivered = 0
    } else if (row.status === 'PENDING') {
        values.valuePendingCents = totalItemValue
        values.qtyDelivered = 0
    }
    return values
}

function flattenItemizedRow(row: any, refundQuantities: Record<number, RefundQuantity>) {
    const refundData = refundQuantities[row.orderItemId] || { qty: 0, amount: 0 }
    const totalItemValue = row.qtyOrdered * row.priceCents
    const values = getFulfilmentValues(row, refundData, totalItemValue)
    return {
        id: row.orderItemId,
        tid: row.tid,
        orderId: row.orderId,
        status: row.status,
        orderCreatedAt: row.orderCreatedAt,
        userId: row.userId,
        employeeId: row.employeeId || row.userId.split('-')[0],
        userName: row.userName || row.userEmail?.split('@')[0],
        userEmail: row.userEmail,
        organizationName: row.organizationName || 'N/A',
        group: row.groupName,
        branchName: row.branchName,
        itemCode: row.itemCode || 'Unknown',
        itemCategory: row.categoryName || 'Uncategorized',
        itemDetails: row.itemName,
        unit: row.itemUnit,
        unitRateCents: row.priceCents,
        qtyOrdered: row.qtyOrdered,
        priceCents: row.priceCents,
        subtotalCents: totalItemValue,
        refundAmountCents: values.valueRefundedCents,
        netTotalCents: ['REJECTED', 'CANCELLED'].includes(row.status) ? 0 : values.valueFulfilledCents,
        ...values,
        valueDeliveredCents: values.valueFulfilledCents,
    }
}

function getPreviousRange(startDate: string, endDate: string, compareStart: string | null, compareEnd: string | null) {
    if (compareStart && compareEnd) {
        return {
            start: parseStartDateParam(compareStart) || new Date(compareStart),
            end: parseEndDateParam(compareEnd) || new Date(compareEnd),
        }
    }
    const start = parseStartDateParam(startDate) || new Date(startDate)
    const end = parseEndDateParam(endDate) || new Date(endDate)
    const duration = end.getTime() - start.getTime()
    return {
        start: new Date(start.getTime() - duration - 1),
        end: new Date(start.getTime() - 1),
    }
}

async function getComparisonSummary({
    branchIds,
    months,
    years,
    range,
}: {
    branchIds: number[]
    months: number[]
    years: number[]
    range: { start: Date; end: Date }
}) {
    const dateConditions: any[] = []
    addPeriodConditions(dateConditions, months, years, range.start, range.end)
    const comparisonRows = await db
        .select({
            id: orders.id,
            status: orders.status,
            totalCents: orders.totalCents,
            refundAmountCents: orders.refundAmountCents,
        })
        .from(orders)
        .where(and(inArray(orders.branchId, branchIds), and(...dateConditions)))
    const fulfilled = comparisonRows.filter((row) => ['FULFILLED', 'REFUNDED', 'APPROVED'].includes(row.status || ""))
    const rejected = comparisonRows.filter((row) => ['REJECTED', 'CANCELLED'].includes(row.status || ""))
    return {
        totalOrders: comparisonRows.length,
        totalRevenue: fulfilled.reduce((sum, row) => sum + ((row.totalCents || 0) - (row.refundAmountCents || 0)), 0),
        totalRejected: rejected.reduce((sum, row) => sum + (row.totalCents || 0), 0),
        totalRefunded: comparisonRows.reduce((sum, row) => sum + (row.refundAmountCents || 0), 0),
    }
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
        const branchIdsParam = url.searchParams.get("branchIds")
        const compare = url.searchParams.get("compare") === "true"
        const compareStartDateParam = url.searchParams.get("compareStartDate")
        const compareEndDateParam = url.searchParams.get("compareEndDate")
        const productIdsParam = url.searchParams.get("productIds")
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const organizationIdParam = url.searchParams.get("organizationId")
        const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit"))) || 5000, 1), 5000)
        const searchTermRaw = (url.searchParams.get("searchTerm") || "").trim()
        if (searchTermRaw.length > 100) {
            return NextResponse.json({ error: "Search query must be at most 100 characters" }, { status: 400 })
        }
        const searchTerm = searchTermRaw ? escapeLikePattern(searchTermRaw) : ""

        const isMonth = (number: number) => number >= 1 && number <= 12
        const isYear = (number: number) => number > 2000
        const parsedMonths = parseNumberList(url.searchParams.get("months"), isMonth)
        const parsedYears = parseNumberList(url.searchParams.get("years"), isYear)
        const parsedCompMonths = parseNumberList(url.searchParams.get("compareMonths"), isMonth)
        const parsedCompYears = parseNumberList(url.searchParams.get("compareYears"), isYear)
        const requestedOrganizationIds = getRequestedOrganizationIds(organizationIdsParam, organizationIdParam)
        const scopedOrganizationIds = resolveAnalyticsOrganizationIds({
            role: userRole,
            userOrganizationId: userOrgId,
            requestedOrganizationIds,
        })

        if (userRole !== "SUPER_ADMIN" && scopedOrganizationIds.length === 0) {
            return NextResponse.json({ error: "Organization not assigned" }, { status: 403 })
        }

        const branchIds = await getScopedBranchIds({
            userRole,
            userBranchId,
            requestedBranchIds: parseNumberList(branchIdsParam),
            scopedOrganizationIds,
            groupIds: parseNumberList(url.searchParams.get("groupIds")),
            assignedBranchIds: await loadAnalyticsAssignedBranchIds(userRole, (session.user as any).id),
        })

        if (branchIds.length === 0) {
            const responseStatus = isBranchScopedAnalyticsRole(userRole) ? 403 : 400
            return NextResponse.json({ error: "No permitted branches resolved" }, { status: responseStatus })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions = buildItemizedConditions({
            branchIds,
            months: parsedMonths,
            years: parsedYears,
            startDate,
            endDate,
            productIds: parseNumberList(productIdsParam),
            scopedOrganizationIds,
            searchTerm,
        })

        // Find all order items matching filters
        const q = db
            .select({
                orderId: orders.id,
                tid: orders.tid,
                status: orders.status,
                orderCreatedAt: orders.createdAt,
                userId: users.id,
                userName: users.fullName,
                userEmail: users.email,
                employeeId: users.employeeId,
                branchName: branches.name,
                organizationName: organizations.name,
                groupName: groups.name,
                itemCode: orderItems.productCode,
                itemName: orderItems.productName,
                itemUnit: orderItems.unit,
                categoryName: categories.name,
                qtyOrdered: orderItems.quantity,
                priceCents: orderItems.priceCents,
                orderItemId: orderItems.id
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .innerJoin(users, eq(orders.createdByUserId, users.id))
            .innerJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(organizations, eq(orders.organizationId, organizations.id))
            .leftJoin(groups, eq(branches.groupId, groups.id))
            .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
            .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
            .where(and(...baseConditions))
            .orderBy(desc(orders.createdAt))
            .limit(limit)

        const results = await q

        const refundQuantities = await getRefundQuantities(results.map((row) => row.orderItemId))
        const flattened = results.map((row) => flattenItemizedRow(row, refundQuantities))

        const comparisonSummary = compare && startDateParam && endDateParam
            ? await getComparisonSummary({
                branchIds,
                months: parsedCompMonths,
                years: parsedCompYears,
                range: getPreviousRange(startDateParam, endDateParam, compareStartDateParam, compareEndDateParam),
            })
            : null

        return respond({
            data: flattened,
            comparison: comparisonSummary
        })
    } catch (error: any) {
        console.error("Orders Itemized Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch itemized orders" }, { status: 500 })
    }
}
