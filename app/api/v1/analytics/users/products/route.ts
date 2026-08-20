import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { resolveMultiBranchAnalyticsIds } from "@/lib/server/analytics-scope"
import { loadAnalyticsAssignedBranchIds } from "@/lib/server/analytics-branch-scope"
import { orders, orderItems, globalProducts, categories, users, branches, refundItems } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value
        ? value.split(',').map(Number).filter((number) => !Number.isNaN(number) && isValid(number))
        : []
}

async function resolveProductBranchIds({
    requestedBranchIds,
    groupIds,
    userRole,
    userBranchId,
    organizationIds,
    userOrganizationId,
    assignedBranchIds,
}: {
    requestedBranchIds: number[]
    groupIds: number[]
    userRole: string
    userBranchId: number
    organizationIds: number[]
    userOrganizationId: number
    assignedBranchIds: number[] | null
}) {
    // A multi-branch role is confined to the branches assigned to it, whatever
    // the request asked for, so this runs ahead of every other rule. An empty
    // assignment set yields no branches and the caller refuses the request.
    const multiBranchIds = resolveMultiBranchAnalyticsIds({
        role: userRole,
        assignedBranchIds,
        requestedBranchIds,
    })
    if (multiBranchIds !== null) {
        if (groupIds.length === 0 || multiBranchIds.length === 0) return multiBranchIds
        const rows = await db
            .select({ id: branches.id })
            .from(branches)
            .where(and(inArray(branches.groupId, groupIds), inArray(branches.id, multiBranchIds)))
        return rows.map((branch) => branch.id)
    }
    if (requestedBranchIds.length > 0) return requestedBranchIds
    if (groupIds.length > 0) {
        const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, groupIds))
        return rows.map((branch) => branch.id)
    }
    if (["BRANCH_ADMIN", "BRANCH_MANAGER", "ORDER_PORTAL"].includes(userRole)) return [userBranchId]
    if (organizationIds.length > 0) {
        const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
        return rows.map((branch) => branch.id)
    }
    if (userOrganizationId) {
        const rows = await db.select({ id: branches.id }).from(branches).where(eq(branches.organizationId, userOrganizationId))
        return rows.map((branch) => branch.id)
    }
    const rows = await db.select({ id: branches.id }).from(branches)
    return rows.map((branch) => branch.id)
}

function buildUserProductConditions({
    branchIds,
    userIds,
    months,
    years,
    startDate,
    endDate,
}: {
    branchIds: number[]
    userIds: string[]
    months: number[]
    years: number[]
    startDate: Date | null | undefined
    endDate: Date | null | undefined
}) {
    const conditions: any[] = [
        inArray(orders.branchId, branchIds),
        sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`,
    ]
    if (userIds.length > 0) conditions.push(inArray(orders.createdByUserId, userIds))
    if (months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    if (months.length > 0 || years.length > 0) return conditions
    if (startDate) conditions.push(gte(orders.createdAt, startDate))
    if (endDate) conditions.push(lte(orders.createdAt, endDate))
    return conditions
}

function addProductToUserMap(userMap: Map<string, any>, row: any) {
    if (!userMap.has(row.userId)) {
        userMap.set(row.userId, {
            userId: row.userId,
            userName: row.userName,
            totalProductsSold: 0,
            totalProductRevenueCents: 0,
            fulfilledProductsSold: 0,
            fulfilledProductRevenueCents: 0,
            refundedProductsSold: 0,
            refundedProductRevenueCents: 0,
            products: [],
        })
    }
    const user = userMap.get(row.userId)
    user.totalProductsSold += row.totalQuantity
    user.totalProductRevenueCents += row.revenueCents
    user.fulfilledProductsSold += row.fulfilledQuantity || 0
    user.fulfilledProductRevenueCents += row.fulfilledRevenueCents || 0
    user.refundedProductsSold += row.refundedQuantity || 0
    user.refundedProductRevenueCents += row.refundedRevenueCents || 0
    user.products.push({
        productId: row.productId,
        productName: row.productName,
        categoryName: row.categoryName || 'Uncategorized',
        quantity: row.totalQuantity,
        revenueCents: row.revenueCents,
        fulfilledQuantity: row.fulfilledQuantity || 0,
        fulfilledRevenueCents: row.fulfilledRevenueCents || 0,
        refundedQuantity: row.refundedQuantity || 0,
        refundedRevenueCents: row.refundedRevenueCents || 0,
    })
}

function groupUserProducts(results: any[]) {
    const userMap = new Map<string, any>()
    results.forEach((row) => addProductToUserMap(userMap, row))
    const data = Array.from(userMap.values())
    data.forEach((user) => user.products.sort((a: any, b: any) => b.revenueCents - a.revenueCents))
    data.sort((a, b) => b.totalProductRevenueCents - a.totalProductRevenueCents)
    return data
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
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const branchIdsParam = url.searchParams.get("branchIds")

        const userIdsRaw = url.searchParams.get("userIds")
        const parsedMonths = parseNumberList(url.searchParams.get("months"), (number) => number >= 1 && number <= 12)
        const parsedYears = parseNumberList(url.searchParams.get("years"), (number) => number > 2000)
        const userIds = userIdsRaw ? userIdsRaw.split(',').filter(id => id.length > 5) : []
        const groupIds = parseNumberList(url.searchParams.get("groupIds"), () => true)

        // RBAC & Filter Context Parsing
        const organizationIds = organizationIdsParam ? parseNumberList(organizationIdsParam) : [userOrgId].filter(Boolean)
        const branchIds = await resolveProductBranchIds({
            assignedBranchIds: await loadAnalyticsAssignedBranchIds(userRole, (session.user as any).id),
            requestedBranchIds: parseNumberList(branchIdsParam),
            groupIds,
            userRole,
            userBranchId,
            organizationIds,
            userOrganizationId: userOrgId,
        })

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches resolved" }, { status: 400 })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions = buildUserProductConditions({
            branchIds,
            userIds,
            months: parsedMonths,
            years: parsedYears,
            startDate,
            endDate,
        })

        // Pre-aggregate refunds to prevent SQL Fan-out join issues
        const preAggRefunds = db.select({
                orderItemId: refundItems.orderItemId,
                refundTotalQty: sql<number>`SUM(${refundItems.quantity})`.as('refundTotalQty'),
                refundTotalAmt: sql<number>`SUM(${refundItems.amountCents})`.as('refundTotalAmt'),
            })
            .from(refundItems)
            .groupBy(refundItems.orderItemId)
            .as('preAggRefunds')

        const q = db
            .select({
                userId: users.id,
                userName: users.fullName,
                productId: globalProducts.id,
                productName: globalProducts.name,
                categoryName: categories.name,
                totalQuantity: sql<number>`SUM(${orderItems.quantity})`.mapWith(Number),
                revenueCents: sql<number>`SUM(ROUND(${orderItems.quantity} * ${orderItems.priceCents}))`.mapWith(Number),
                fulfilledQuantity: sql<number>`SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN ${orderItems.quantity} ELSE 0 END)`.mapWith(Number),
                fulfilledRevenueCents: sql<number>`SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN ROUND(${orderItems.quantity} * ${orderItems.priceCents}) ELSE 0 END)`.mapWith(Number),
                refundedQuantity: sql<number>`SUM(COALESCE(${preAggRefunds.refundTotalQty}, 0))`.mapWith(Number),
                refundedRevenueCents: sql<number>`SUM(COALESCE(${preAggRefunds.refundTotalAmt}, 0))`.mapWith(Number),
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .leftJoin(preAggRefunds, eq(orderItems.id, preAggRefunds.orderItemId))
            .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
            .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
            .innerJoin(users, eq(orders.createdByUserId, users.id))
            .where(and(...baseConditions))
            .groupBy(users.id, users.fullName, globalProducts.id, globalProducts.name, categories.name)
            .orderBy(desc(sql<number>`SUM(ROUND(${orderItems.quantity} * ${orderItems.priceCents}))`))

        const results = await q

        const data = groupUserProducts(results)

        return respond({ data })
    } catch (error: any) {
        console.error("User Products Analytics Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch user product analytics" }, { status: 500 })
    }
}
