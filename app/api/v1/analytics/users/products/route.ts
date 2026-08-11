import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, globalProducts, categories, users, branches, refundItems } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, sql } from "drizzle-orm"
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

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")
        const userIdsRaw = url.searchParams.get("userIds")
        const groupIdsRaw = url.searchParams.get("groupIds")

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
        const userIds = userIdsRaw ? userIdsRaw.split(',').filter(id => id.length > 5) : []
        const groupIds = groupIdsRaw ? groupIdsRaw.split(',').map(Number).filter(n => !Number.isNaN(n)) : []

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
            const b = await db.select({ id: branches.id }).from(branches)
            branchIds = b.map(br => br.id)
        }

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches resolved" }, { status: 400 })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions: any[] = [
            inArray(orders.branchId, branchIds),
            // Only count products that actually generated revenue / were successfully ordered
            sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`
        ]
        
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

        // Transform into a user-centric structure
        const userMap = new Map<string, any>()
        
        results.forEach(row => {
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
                    products: []
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
                refundedRevenueCents: row.refundedRevenueCents || 0
            })
        })

        const data = Array.from(userMap.values()).map(user => {
            // Sort each user's products by revenue descending
            user.products.sort((a: any, b: any) => b.revenueCents - a.revenueCents)
            return user
        })
        
        // Sort final user list by total revenue
        data.sort((a, b) => b.totalProductRevenueCents - a.totalProductRevenueCents)

        return respond({ data })
    } catch (error: any) {
        console.error("User Products Analytics Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch user product analytics" }, { status: 500 })
    }
}
