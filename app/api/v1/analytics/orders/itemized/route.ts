import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, branches, users, globalProducts, categories, refundItems, groups, organizations } from "@/db/schema"
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
        const branchIdsParam = url.searchParams.get("branchIds")
        const compare = url.searchParams.get("compare") === "true"
        const compareStartDateParam = url.searchParams.get("compareStartDate")
        const compareEndDateParam = url.searchParams.get("compareEndDate")
        const status = url.searchParams.get("status")
        const productIdsParam = url.searchParams.get("productIds")
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const groupIdsParam = url.searchParams.get("groupIds")
        const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit"))) || 5000, 1), 5000)

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")
        const compareMonthsRaw = url.searchParams.get("compareMonths")
        const compareYearsRaw = url.searchParams.get("compareYears")

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n > 2000) : []
        const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n >= 1 && n <= 12) : []
        const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n > 2000) : []

        // RBAC Context Parsing
        let branchIds: number[] = []
        if (branchIdsParam && branchIdsParam.trim() !== "") {
            branchIds = branchIdsParam.split(",").map(id => Number(id)).filter(id => !isNaN(id) && id > 0)
        } else if (userRole === "BRANCH_ADMIN" || userRole === "BRANCH_MANAGER" || userRole === "ORDER_PORTAL") {
            if (userBranchId) branchIds = [userBranchId]
        } else {
            const b = await db.select({ id: branches.id }).from(branches).where(userOrgId ? eq(branches.organizationId, userOrgId) : undefined)
            branchIds = b.map(br => br.id)
        }

        if (branchIds.length === 0) {
            return NextResponse.json({ error: "No branches resolved" }, { status: 400 })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions: any[] = [
            inArray(orders.branchId, branchIds),
            inArray(orders.status, ['FULFILLED', 'APPROVED', 'REFUNDED', 'PENDING', 'REJECTED', 'CANCELLED'])
        ]

        if (parsedMonths.length > 0) {
            baseConditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql`, `)})`)
        }
        if (parsedYears.length > 0) {
            baseConditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql`, `)})`)
        }

        if (parsedMonths.length === 0 && parsedYears.length === 0) {
            if (startDate) baseConditions.push(gte(orders.createdAt, startDate))
            if (endDate) baseConditions.push(lte(orders.createdAt, endDate))
        }

        if (productIdsParam && productIdsParam.trim() !== "") {
            const productIds = productIdsParam.split(",").map(Number).filter(id => !isNaN(id) && id > 0)
            if (productIds.length > 0) baseConditions.push(inArray(orderItems.globalProductId, productIds))
        }
        if (groupIdsParam && groupIdsParam.trim() !== "") {
            const groupIds = groupIdsParam.split(",").map(Number).filter(id => !isNaN(id) && id > 0)
            if (groupIds.length > 0) baseConditions.push(inArray(branches.groupId, groupIds))
        }
        if (organizationIdsParam && organizationIdsParam.trim() !== "") {
            const organizationIds = organizationIdsParam.split(",").map(Number).filter(id => !isNaN(id) && id > 0)
            if (organizationIds.length > 0) baseConditions.push(inArray(orders.organizationId, organizationIds))
        }

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

        // Get refund data for calculating exact valid quantities
        const validOrderItemIds = results.map(r => r.orderItemId)
        let refundQuantities: Record<number, { qty: number; amount: number }> = {}

        if (validOrderItemIds.length > 0) {
            const refundsObj = await db
                .select({
                    orderItemId: refundItems.orderItemId,
                    qty: refundItems.quantity,
                    amount: refundItems.amountCents,
                })
                .from(refundItems)
                .where(inArray(refundItems.orderItemId, validOrderItemIds))

            refundQuantities = refundsObj.reduce((acc, curr) => {
                if (curr.orderItemId) {
                    acc[curr.orderItemId] = {
                        qty: (acc[curr.orderItemId]?.qty || 0) + curr.qty,
                        amount: (acc[curr.orderItemId]?.amount || 0) + (curr.amount || 0)
                    }
                }
                return acc
            }, {} as Record<number, { qty: number, amount: number }>)
        }

        const flattened = results.map(row => {
            const refundData = refundQuantities[row.orderItemId] || { qty: 0, amount: 0 }
            const totalItemValue = row.qtyOrdered * row.priceCents

            // Cap refunds at item total to prevent "Refund > Subtotal" errors
            const valueRefundedCents = Math.min(totalItemValue, refundData.amount || (refundData.qty * row.priceCents))
            const effectiveRefundedQty = Math.min(row.qtyOrdered, refundData.qty)

            let qtyDelivered = row.qtyOrdered
            let valueFulfilledCents = 0
            let valueRejectedCents = 0
            let valuePendingCents = 0

            if (row.status === 'FULFILLED' || row.status === 'REFUNDED' || row.status === 'APPROVED') {
                qtyDelivered = Math.max(0, row.qtyOrdered - effectiveRefundedQty)
                valueFulfilledCents = Math.max(0, totalItemValue - valueRefundedCents)
            } else if (row.status === 'REJECTED' || row.status === 'CANCELLED') {
                valueRejectedCents = totalItemValue
                qtyDelivered = 0
            } else if (row.status === 'PENDING') {
                valuePendingCents = totalItemValue
                qtyDelivered = 0
            }

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
                qtyDelivered: qtyDelivered,
                priceCents: row.priceCents,
                subtotalCents: totalItemValue,
                refundAmountCents: valueRefundedCents,
                netTotalCents: (row.status === 'REJECTED' || row.status === 'CANCELLED') ? 0 : valueFulfilledCents,
                valueFulfilledCents,
                valueDeliveredCents: valueFulfilledCents,
                valueRefundedCents,
                valueRejectedCents,
                valuePendingCents
            }
        })

        // COMPARISON logic for overall KPIs
        let comparisonSummary = null
        if (compare && startDateParam && endDateParam) {
            let prevStart: Date
            let prevEnd: Date

            if (compareStartDateParam && compareEndDateParam) {
                prevStart = parseStartDateParam(compareStartDateParam) || new Date(compareStartDateParam)
                prevEnd = parseEndDateParam(compareEndDateParam) || new Date(compareEndDateParam)
            } else {
                const start = parseStartDateParam(startDateParam) || new Date(startDateParam)
                const end = parseEndDateParam(endDateParam) || new Date(endDateParam)
                const duration = end.getTime() - start.getTime()
                prevStart = new Date(start.getTime() - duration - 1)
                prevEnd = new Date(start.getTime() - 1)
            }

            const compResults = await db
                .select({
                    id: orders.id,
                    status: orders.status,
                    totalCents: orders.totalCents,
                    refundAmountCents: orders.refundAmountCents
                })
                .from(orders)
                .where(
                    and(
                        inArray(orders.branchId, branchIds),
                        (() => {
                            const compCond: any[] = []
                            if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                                if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql`, `)})`)
                                if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql`, `)})`)
                            } else {
                                if (prevStart) compCond.push(gte(orders.createdAt, prevStart))
                                if (prevEnd) compCond.push(lte(orders.createdAt, prevEnd))
                            }
                            return and(...compCond)
                        })()
                    )
                )

            const compFulfilled = compResults.filter(r => ['FULFILLED', 'REFUNDED', 'APPROVED'].includes(r.status || ""))
            const compRejected = compResults.filter(r => ['REJECTED', 'CANCELLED'].includes(r.status || ""))

            comparisonSummary = {
                totalOrders: compResults.length,
                totalRevenue: compFulfilled.reduce((sum, r) => sum + ((r.totalCents || 0) - (r.refundAmountCents || 0)), 0),
                totalRejected: compRejected.reduce((sum, r) => sum + (r.totalCents || 0), 0),
                totalRefunded: compResults.reduce((sum, r) => sum + (r.refundAmountCents || 0), 0)
            }
        }

        return respond({
            data: flattened,
            comparison: comparisonSummary
        })
    } catch (error: any) {
        console.error("Orders Itemized Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch itemized orders" }, { status: 500 })
    }
}
