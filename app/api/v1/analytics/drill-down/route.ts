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

    const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n >= 1 && n <= 12) : []
    const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n > 2000) : []
    const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n >= 1 && n <= 12) : []
    const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter((n: any) => !isNaN(n) && n > 2000) : []
    const refundType = searchParams.get("refundType")?.toLowerCase() // all, full, partial
    const sortColumn = resolveDrillDownSortColumn(searchParams.get("sortBy"))
    if (!type || !["REVENUE", "REJECTED", "FULFILLED", "ORDERS", "REFUNDED", "PENDING", "APPROVED", "PARTIAL", "DELIVERED", "NOT_DELIVERED"].includes(type)) {
        return error("Invalid or missing drill-down type")
    }

    let organizationId: number | null = null
    let branchId: number | null = null
    let branchIds: number[] = []

    // SECURITY: Enforce strict data isolation based on user role
    if (role === "BRANCH_ADMIN") {
        // Branch Admin can only see their own branch
        organizationId = scope?.organizationId ?? null
        branchId = scope?.branchId ?? null
        // IGNORE URL PARAMETERS for security
    } else if (role === "HEAD_OFFICE") {
        // Head Office can see all branches in their organization, but not other organizations
        organizationId = scope?.organizationId ?? null
        // Only allow branch filtering within their organization
        if (branchIdParam && branchIdParam !== "null" && branchIdParam !== "0") {
            const requestedBranchId = Number(branchIdParam)
            // Verify this branch belongs to their organization
            if (organizationId && requestedBranchId) {
                try {
                    const [branchCheck] = await db
                        .select({ id: branches.id })
                        .from(branches)
                        .where(and(eq(branches.id, requestedBranchId), eq(branches.organizationId, organizationId)))
                        .limit(1)
                    
                    if (branchCheck) {
                        branchId = requestedBranchId
                    } else {
                        console.warn(`[Security] Head Office user tried to access branch ${requestedBranchId} outside their org ${organizationId}`)
                        return error("Access denied: Branch not found in your organization")
                    }
                } catch (err) {
                    console.error("[Security] Error verifying branch access for Head Office:", err)
                    return error("Access verification failed")
                }
            }
        }
        // IGNORE organizationId parameter for security
    } else if (role === "SUPER_ADMIN") {
        // Super Admin can see everything (intended)
        if (orgIdParam && orgIdParam !== "null" && orgIdParam !== "0" && orgIdParam !== "undefined") {
            organizationId = Number(orgIdParam)
        }
        if (branchIdParam && branchIdParam !== "null" && branchIdParam !== "0") {
            branchId = Number(branchIdParam)
        }
    } else {
        // Unknown role - deny access
        console.warn(`[Security] Unknown role ${role} attempting to access drill-down API`)
        return error("Access denied: Invalid user role")
    }

    // SECURITY: Only allow branchIds for SUPER_ADMIN or validated HEAD_OFFICE requests
    if (branchIdsParam) {
        if (role === "SUPER_ADMIN") {
            branchIds = branchIdsParam.split(",").map((n: any) => Number(n)).filter((n: any) => !isNaN(n) && n > 0)
        } else if (role === "HEAD_OFFICE") {
            // Verify all requested branches belong to the user's organization
            const requestedBranchIds = branchIdsParam.split(",").map((n: any) => Number(n)).filter((n: any) => !isNaN(n) && n > 0)
            if (organizationId && requestedBranchIds.length > 0) {
                try {
                    const validBranches = await db
                        .select({ id: branches.id })
                        .from(branches)
                        .where(and(
                            inArray(branches.id, requestedBranchIds),
                            eq(branches.organizationId, organizationId)
                        ))
                    
                    branchIds = validBranches.map(b => b.id)
                    
                    // Check if any requested branches were invalid
                    const invalidBranches = requestedBranchIds.filter((id: number) => !branchIds.includes(id))
                    if (invalidBranches.length > 0) {
                        console.warn(`[Security] Head Office user tried to access invalid branches: ${invalidBranches.join(',')}, in org ${organizationId}`)
                    }
                } catch (err) {
                    console.error("[Security] Error verifying branchIds for Head Office:", err)
                    return error("Access verification failed")
                }
            }
        }
        // BRANCH_ADMIN and others: IGNORE branchIds parameter for security
    }

    const conditions: any[] = []

    if (organizationId) conditions.push(eq(orders.organizationId, organizationId))
    if (branchIds.length > 0) {
        conditions.push(inArray(orders.branchId, branchIds))
    } else if (branchId) {
        conditions.push(eq(orders.branchId, branchId))
    }

    if (parsedMonths.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedMonths, sql`, `)})`)
    }
    if (parsedYears.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedYears, sql`, `)})`)
    }

    if (parsedMonths.length === 0 && parsedYears.length === 0) {
        if (startDateParam) {
            const start = parseStartDateParam(startDateParam)
            if (start) conditions.push(gte(orders.createdAt, start))
        }
        if (endDateParam) {
            const end = parseEndDateParam(endDateParam)
            if (end) conditions.push(lte(orders.createdAt, end))
        }
    }

    // Apply type-specific filters
    if (type === "REVENUE") {
        // Revenue Drill-down: must match REVENUE_ELIGIBLE_FILTER
        conditions.push(sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
    } else if (type === "FULFILLED") {
        conditions.push(
            and(
                eq(sql`UPPER(${orders.status})`, "FULFILLED"),
                eq(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)
            )
        )
    } else if (type === "REJECTED") {
        conditions.push(or(eq(sql`UPPER(${orders.status})`, "REJECTED"), eq(sql`UPPER(${orders.status})`, "CANCELLED")))
    } else if (type === "ORDERS") {
        conditions.push(sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED', 'FULFILLED', 'REFUNDED', 'REJECTED', 'CANCELLED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
    } else if (type === "REFUNDED") {
        if (refundType === "full") {
            conditions.push(eq(sql`UPPER(${orders.status})`, "REFUNDED"))
        } else if (refundType === "partial") {
            conditions.push(and(
                gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0),
                sql`UPPER(${orders.status}) <> 'REFUNDED'`
            ))
        } else {
            conditions.push(or(
                eq(sql`UPPER(${orders.status})`, "REFUNDED"),
                gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)
            ))
        }
    } else if (type === "PARTIAL") {
        conditions.push(
            or(
                and(eq(sql`UPPER(${orders.status})`, "FULFILLED"), gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)),
                inArray(sql`UPPER(${orders.status})`, ["PARTIAL", "PARTIALLY_FULFILLED"])
            )
        )
    } else if (type === "PENDING") {
        conditions.push(eq(sql`UPPER(${orders.status})`, "PENDING"))
    } else if (type === "APPROVED") {
        conditions.push(eq(sql`UPPER(${orders.status})`, "APPROVED"))
    } else if (type === "DELIVERED") {
        conditions.push(
            eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED")
        )
    } else if (type === "NOT_DELIVERED") {
        conditions.push(
            sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`
        )
    }

    try {
        const whereClause = conditions.length > 0 ? and(...conditions) : undefined

        // BI aggregates and raw data
        const rawData = await db.select({
            id: orders.id,
            tid: orders.tid,
            status: orders.status,
            totalCents: orders.totalCents,
            subtotalCents: orders.subtotalCents,
            taxCents: orders.taxCents,
            refundAmountCents: orders.refundAmountCents,
            createdAt: orders.createdAt,
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

        // Fetch order items & refunds in bulk for the top 100 display items
        const orderIds = rawData.map(o => o.id)
        const displayOrderIds = orderIds.slice(0, 100)
        let detailedItemsMap: Record<number, any[]> = {}
        if (displayOrderIds.length > 0) {
            const allItems = await db.select({
                id: orderItems.id,
                orderId: orderItems.orderId,
                productName: orderItems.productName,
                productCode: orderItems.productCode,
                quantity: orderItems.quantity,
                priceCents: orderItems.priceCents,
                refundQuantity: sql<number>`
                    CASE
                        WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN COALESCE(${refundItems.quantity}, 0)
                        ELSE 0
                    END
                `.mapWith(Number),
                refundAmountCents: sql<number>`
                    CASE
                        WHEN UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED') THEN COALESCE(${refundItems.amountCents}, 0)
                        ELSE 0
                    END
                `.mapWith(Number)
            })
                .from(orderItems)
                .leftJoin(refundItems, eq(orderItems.id, refundItems.orderItemId))
                .leftJoin(refunds, eq(refundItems.refundId, refunds.id))
                .where(inArray(orderItems.orderId, displayOrderIds))

            detailedItemsMap = allItems.reduce((acc, curr) => {
                if (curr.orderId) {
                    if (!acc[curr.orderId]) acc[curr.orderId] = []
                    
                    const existing = acc[curr.orderId].find(i => i.id === curr.id)
                    if (existing) {
                        existing.quantity = Math.max(Number(existing.quantity) || 0, Number(curr.quantity) || 0)
                        existing.refundQuantity += curr.refundQuantity
                        existing.refundAmount += curr.refundAmountCents / 100
                    } else {
                        acc[curr.orderId].push({
                            id: curr.id,
                            name: curr.productName,
                            productCode: curr.productCode,
                            quantity: curr.quantity,
                            price: curr.priceCents / 100,
                            refundQuantity: curr.refundQuantity,
                            refundAmount: curr.refundAmountCents / 100
                        })
                    }
                }
                return acc
            }, {} as Record<number, any[]>)
        }

        // Fetch counts for ALL returned orders for correct aggregation
        let itemCounts: Record<number, number> = {}
        if (orderIds.length > 0) {
            const counts = await db.select({
                orderId: orderItems.orderId,
                totalQty: sql<number>`COALESCE(sum(COALESCE(${orderItems.quantity}, 0)), 0)::numeric`.mapWith(Number)
            })
                .from(orderItems)
                .where(inArray(orderItems.orderId, orderIds))
                .groupBy(orderItems.orderId)

            itemCounts = counts.reduce((acc, curr) => {
                if (curr.orderId) acc[curr.orderId] = curr.totalQty || 0
                return acc
            }, {} as Record<number, number>)
        }

        // BI Calculation
        let grossTotal = 0
        let refundTotal = 0
        let rejectedTotal = 0
        let discountTotal = 0
        let totalProcessingSeconds = 0
        let processingCount = 0
        const branchStats: Record<number, { name: string, total: number, refunds: number, count: number }> = {}
        const hourlyDistribution: Record<number, number> = {}

        let totalItems = 0
        let fulfilledOrderCount = 0
        let refundedOrdersCount = 0
        let refundRelatedOrdersCount = 0
        let refundedValue = 0
        rawData.forEach(order => {
            totalItems += (itemCounts[order.id] || 0)
            const total = (order.totalCents || 0) / 100
            const refund = (order.refundAmountCents || 0) / 100
            const status = (order.status || "").toUpperCase()
            const disc = (order.receiptData?.discount || 0)

            // ALIGNED WITH metric-utils.ts: net revenue only comes from THESE statuses
            if (['FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(status)) {
                grossTotal += total
                refundTotal += refund
                
                // Fulfilled Orders in dashboard: FULFILLED + PARTIAL
                if (['FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(status)) {
                    fulfilledOrderCount++
                }
            }

            // Refunded Orders in dashboard: strictly completely REFUNDED status
            if (status === 'REFUNDED') {
                refundedOrdersCount++
            }
            if (refund > 0) {
                refundRelatedOrdersCount++
                refundedValue += refund
            }

            if (status === "REJECTED" || status === "CANCELLED") {
                rejectedTotal += total
            }

            discountTotal += disc

            // Peak Period
            if (order.createdAt) {
                const hour = new Date(order.createdAt).getHours()
                hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + total
            }

            // Efficiency
            if (order.createdAt && order.fulfilledAt) {
                const start = new Date(order.createdAt).getTime()
                const end = new Date(order.fulfilledAt).getTime()
                if (end >= start) {
                    const diffSeconds = Math.round((end - start) / 1000)
                    totalProcessingSeconds += diffSeconds
                    processingCount++
                }
            }

            // Branch Ranking
            if (order.branchId) {
                if (!branchStats[order.branchId]) {
                    branchStats[order.branchId] = { name: order.branchName || "Unknown", total: 0, refunds: 0, count: 0 }
                }
                const b = branchStats[order.branchId]
                b.count++
                if (status === "FULFILLED" || status === "REFUNDED") {
                    b.total += total
                    if (status === "REFUNDED") b.refunds += refund
                }
            }
        })

        // Formatting Summary
        const sortedHours = Object.entries(hourlyDistribution).sort((a, b) => b[1] - a[1])
        const peakHourRange = sortedHours.length > 0 ? `${sortedHours[0][0]}:00 - ${Number(sortedHours[0][0]) + 1}:00` : "N/A"

        const sortedBranches = Object.entries(branchStats).map(([id, s]) => ({ id, ...s }))
        const topBranch = sortedBranches.sort((a, b) => b.total - a.total)[0]?.name || "N/A"
        const problematicBranch = sortedBranches.sort((a, b) => (b.refunds / (b.total || 1)) - (a.refunds / (a.total || 1)))[0]?.name || "N/A"

        const summary = {
            grossRevenue: grossTotal,
            netRevenue: grossTotal - refundTotal,
            refundRate: grossTotal > 0 ? (refundTotal / grossTotal) * 100 : 0,
            leakage: rejectedTotal + discountTotal,
            discountImpact: discountTotal,
            avgProcessingTime: processingCount > 0 ? Math.round(totalProcessingSeconds / processingCount / 60) : 0,
            totalItems,
            fulfilledOrderCount,
            refundedOrdersCount,
            refundRelatedOrdersCount,
            refundedValue,
            peakPeriod: peakHourRange,
            topBranch,
            problematicBranch
        }

        // Format data and return actual requested UI fields
        const formattedData = rawData.slice(0, 100).map(order => {
            const gross = (order.totalCents || 0) / 100
            const refund = (order.refundAmountCents || 0) / 100
            const status = (order.status || "").toUpperCase()
            const netValue = (gross - refund)

            const created = new Date(order.createdAt!)
            const fulfilled = order.fulfilledAt ? new Date(order.fulfilledAt) : null

            let prepTimeStr = "N/A"
            if (created && fulfilled) {
                const diffMins = Math.round((fulfilled.getTime() - created.getTime()) / 60000)
                prepTimeStr = `${diffMins} mins`
            }

            return {
                id: order.id,
                tid: order.tid,
                status: order.status,
                date: order.createdAt,
                branchName: order.branchName,
                organizationName: order.organizationName || order.receiptData?.organizationName,
                netValue,
                grossValue: gross,
                refundAmount: refund,
                skuCount: itemCounts[order.id] || 0,
                customerLevel: (order.id % 5 === 0) ? "VIP" : "Regular",
                preparationTime: prepTimeStr,
                buyerName: order.receiptData?.buyerName || order.creatorName || "Walk-in Customer",
                buyerPhone: order.receiptData?.buyerPhone || order.creatorPhone || "N/A",
                creatorName: order.creatorName,
                creatorEmployeeId: order.creatorEmployeeId,
                items: detailedItemsMap[order.id] || []
            }
        })

        // COMPARISON LOGIC
        let comparisonSummary = null
        if (searchParams.get("compare") === "true" && startDateParam && endDateParam) {
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

            // Correctly filter out createdAt conditions by rebuilding them
            const compConditions: any[] = []
            if (organizationId) compConditions.push(eq(orders.organizationId, organizationId))
            if (branchIds.length > 0) {
                compConditions.push(inArray(orders.branchId, branchIds))
            } else if (branchId) {
                compConditions.push(eq(orders.branchId, branchId))
            }

            (() => {
                const compCond: any[] = []
                if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                    if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql`, `)})`)
                    if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql`, `)})`)
                } else if (prevStart && prevEnd) {
                    compCond.push(gte(orders.createdAt, prevStart))
                    compCond.push(lte(orders.createdAt, prevEnd))
                }
                if (compCond.length > 0) compConditions.push(and(...compCond))
            })()

            // Re-apply type-specific filters
            if (type === "REVENUE") {
                compConditions.push(sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
            } else if (type === "FULFILLED") {
                compConditions.push(eq(sql`UPPER(${orders.status})`, "FULFILLED"))
            } else if (type === "REJECTED") {
                compConditions.push(sql`UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED')`)
            } else if (type === "ORDERS") {
                compConditions.push(sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED', 'FULFILLED', 'REFUNDED', 'REJECTED', 'CANCELLED', 'PARTIAL', 'PARTIALLY_FULFILLED')`)
            } else if (type === "REFUNDED") {
                compConditions.push(or(
                    eq(sql`UPPER(${orders.status})`, "REFUNDED"),
                    gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)
                ))
            } else if (type === "PENDING") {
                compConditions.push(eq(sql`UPPER(${orders.status})`, "PENDING"))
            } else if (type === "APPROVED") {
                compConditions.push(eq(sql`UPPER(${orders.status})`, "APPROVED"))
            } else if (type === "DELIVERED") {
                compConditions.push(
                    eq(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`, "DELIVERED")
                )
            } else if (type === "NOT_DELIVERED") {
                compConditions.push(
                    sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) <> 'DELIVERED'`
                )
            }

            const compWhere = and(...compConditions)
            const compData = await db.select({
                id: orders.id,
                status: orders.status,
                totalCents: orders.totalCents,
                refundAmountCents: orders.refundAmountCents,
                createdAt: orders.createdAt,
                fulfilledAt: orders.fulfilledAt,
                receiptData: orders.receiptData,
            })
                .from(orders)
                .where(compWhere)

            const compOrderIds = compData.map(o => o.id)
            let compItemCount = 0
            if (compOrderIds.length > 0) {
                const countsArr = await db.select({
                    val: sql<number>`count(${orderItems.id})`
                })
                    .from(orderItems)
                    .where(inArray(orderItems.orderId, compOrderIds))
                compItemCount = Number(countsArr[0]?.val || 0)
            }

            let compGross = 0; let compRefund = 0; let compRejected = 0; let compDisc = 0
            compData.forEach(o => {
                const g = (o.totalCents || 0) / 100
                const r = (o.refundAmountCents || 0) / 100
                const s = (o.status || "").toUpperCase()
                if (['FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(s)) { 
                    compGross += g; compRefund += r 
                } else if (s === 'REFUNDED') {
                    compRefund += r
                } else if (s === "REJECTED" || s === "CANCELLED") {
                    compRejected += g
                }
                compDisc += (o.receiptData?.discount || 0)
            })

            comparisonSummary = {
                grossRevenue: compGross,
                netRevenue: compGross - compRefund,
                totalItems: compItemCount,
                totalOrders: compData.length,
                leakage: compRejected + compDisc
            }
        }

        const payload = { items: formattedData, summary, comparison: comparisonSummary, total: rawData.length, pricesHidden }
        return ok(pricesHidden ? redactAnalyticsPrices(payload) : payload)
    } catch (e) {
        console.error("[DrillDown] Error:", e)
        return error("Internal BI processing error")
    }
}
