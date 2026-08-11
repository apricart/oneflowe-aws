import { branches,branchInventory,categories,globalProducts,groups,orderItems,orders,organizationInventory,organizations,refundItems,refunds,users } from "@/db/schema"
import { authOptions } from "@/lib/auth-options"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"
import { db } from "@/lib/db"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import {
parseProductPerformanceLimit,
parseProductPerformanceRankBy,
rankProductPerformanceRows,
} from "@/lib/product-performance-ranking"
import {
isBranchScopedAnalyticsRole,
resolveAnalyticsBranchIds,
resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { escapeLikePattern } from "@/lib/utils"
import { aliasedTable,and,eq,exists,gte,ilike,inArray,lte,or,sql } from "drizzle-orm"
import { getServerSession } from "next-auth"
import { NextResponse,type NextRequest } from "next/server"

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

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")
        const compareMonthsRaw = url.searchParams.get("compareMonths")
        const compareYearsRaw = url.searchParams.get("compareYears")

        const parsedMonths = monthsRaw ? monthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedYears = yearsRaw ? yearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []
        const parsedCompMonths = compareMonthsRaw ? compareMonthsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n >= 1 && n <= 12) : []
        const parsedCompYears = compareYearsRaw ? compareYearsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 2000) : []

        const groupIdsRaw = url.searchParams.get("groupIds")
        const parsedGroupIds = groupIdsRaw ? groupIdsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 0) : []

        const productIdsRaw = url.searchParams.get("productIds")
        const parsedProductIds = productIdsRaw ? productIdsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 0) : []
        const searchTermRaw = (url.searchParams.get("searchTerm") || "").trim()
        if (searchTermRaw.length > 100) {
            return NextResponse.json({ error: "Search query must be at most 100 characters" }, { status: 400 })
        }
        const searchTerm = searchTermRaw ? escapeLikePattern(searchTermRaw) : ""
        const requestedRankBy = parseProductPerformanceRankBy(url.searchParams.get("rankBy"))
        const rankingLimit = parseProductPerformanceLimit(url.searchParams.get("limit"))

        // Most product-report requests use the singular organizationId from the
        // global organization selector, while the report's multi-select uses
        // organizationIds. Support both forms. Non-super-admin users must always
        // remain scoped to the organization from their session.
        const organizationIdsRaw = url.searchParams.get("organizationIds")
        const organizationIdRaw = url.searchParams.get("organizationId")
        const requestedOrgIds = (() => {
          if (organizationIdsRaw) {
            return organizationIdsRaw.split(',').map(Number).filter(n => !Number.isNaN(n) && n > 0)
          }
          return (organizationIdRaw && Number(organizationIdRaw) > 0 ? [Number(organizationIdRaw)] : [])
        })()
        const parsedOrgIds = resolveAnalyticsOrganizationIds({
            role: userRole,
            userOrganizationId: userOrgId,
            requestedOrganizationIds: requestedOrgIds,
        })

        if (userRole !== "SUPER_ADMIN" && parsedOrgIds.length === 0) {
            return NextResponse.json({ error: "Organization not assigned" }, { status: 403 })
        }

        // Resolve the complete allowed branch set first, then intersect all
        // request-supplied IDs with it. Branch-scoped roles are always forced to
        // the branch stored in their authenticated session.
        let allowedBranchQuery = db.select({ id: branches.id }).from(branches)
        if (parsedOrgIds.length > 0) {
            allowedBranchQuery = allowedBranchQuery
                .where(inArray(branches.organizationId, parsedOrgIds)) as any
        }
        const allowedBranches = await allowedBranchQuery
        const requestedBranchIds = branchIdsParam
            ? branchIdsParam.split(",").map(Number)
            : []
        let branchIds = resolveAnalyticsBranchIds({
            role: userRole,
            userBranchId,
            requestedBranchIds,
            allowedBranchIds: allowedBranches.map((branch) => branch.id),
        })

        // Apply group filter if present
        if (parsedGroupIds.length > 0) {
            const groupBranches = await db.select({ id: branches.id })
                .from(branches)
                .where(and(
                    inArray(branches.groupId, parsedGroupIds),
                    (() => {
                      if (parsedOrgIds.length > 0) {
                        return inArray(branches.organizationId, parsedOrgIds)
                      }
                      return (userOrgId ? eq(branches.organizationId, userOrgId) : undefined)
                    })()
                ));
            const groupBranchIds = new Set(groupBranches.map(b => b.id));
            branchIds = branchIds.filter(id => groupBranchIds.has(id));
        }

        if (branchIds.length === 0) {
            const status = isBranchScopedAnalyticsRole(userRole) ? 403 : 400
            return NextResponse.json({ error: "No permitted branches resolved" }, { status })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const applyDateFilters = (
            conditions: any[],
            months: number[],
            years: number[],
            start?: Date,
            end?: Date
        ) => {
            if (months.length > 0) {
                conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
            }
            if (years.length > 0) {
                conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
            }

            if (months.length === 0 && years.length === 0) {
                if (start) conditions.push(gte(orders.createdAt, start))
                if (end) conditions.push(lte(orders.createdAt, end))
            }
        }

        const baseConditions: any[] = [
            inArray(orders.branchId, branchIds),
            sql`UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`
        ]

        if (parsedProductIds.length > 0) {
            baseConditions.push(inArray(globalProducts.id, parsedProductIds))
        }
        const searchCondition = searchTerm
            ? or(
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
            )
            : undefined
        if (searchCondition) {
            baseConditions.push(searchCondition)
        }

        applyDateFilters(baseConditions, parsedMonths, parsedYears, startDate, endDate)

        // Find all order items matching filters
        const q = db
            .select({
                orderId: orders.id,
                status: orders.status,
                createdAt: orders.createdAt,
                globalProductId: orderItems.globalProductId,
                itemCode: globalProducts.productCode,
                itemName: globalProducts.name,
                itemUnit: globalProducts.unit,
                categoryName: categories.name,
                productStatus: globalProducts.status,
                productDeletedAt: globalProducts.deletedAt,
                qtyOrdered: orderItems.quantity,
                priceCents: orderItems.priceCents,
                basePriceCents: globalProducts.basePrice,
                orderItemId: orderItems.id
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
            .innerJoin(users, eq(orders.createdByUserId, users.id))
            .innerJoin(branches, eq(orders.branchId, branches.id))
            .leftJoin(organizations, eq(orders.organizationId, organizations.id))
            .leftJoin(groups, eq(branches.groupId, groups.id))
            .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
            .where(and(...baseConditions))

        const results = await q as any[]

        // Get refund data for calculating exact refunded quantities
        const validOrderItemIds = results.map(r => r.orderItemId)
        let refundQuantities: Record<number, number> = {}

        if (validOrderItemIds.length > 0) {
            const refundsObj = await db
                .select({
                    orderItemId: refundItems.orderItemId,
                    qty: refundItems.quantity,
                })
                .from(refundItems)
                .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
                .where(and(
                    inArray(refundItems.orderItemId, validOrderItemIds),
                    inArray(sql`UPPER(${refunds.status})`, ['APPROVED', 'COMPLETED'])
                ))

            refundQuantities = refundsObj.reduce((acc, curr) => {
                if (curr.orderItemId) {
                    acc[curr.orderItemId] = (acc[curr.orderItemId] || 0) + curr.qty
                }
                return acc
            }, {} as Record<number, number>)
        }

        // 1. Fetch relevant global products based on filtering and scoping
        const productConditions: any[] = []
        if (parsedProductIds.length > 0) {
            productConditions.push(inArray(globalProducts.id, parsedProductIds))
        }

        // Apply scoping (only products assigned to active branches or organization inventory)
        if (branchIds.length > 0) {
            productConditions.push(
                exists(
                    db.select()
                    .from(branchInventory)
                    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
                    .where(and(
                        eq(organizationInventory.globalProductId, globalProducts.id),
                        inArray(branchInventory.branchId, branchIds)
                    ))
                )
            )
        } else if (parsedOrgIds.length > 0) {
            productConditions.push(
                exists(
                    db.select()
                    .from(organizationInventory)
                    .where(and(
                        eq(organizationInventory.globalProductId, globalProducts.id),
                        inArray(organizationInventory.organizationId, parsedOrgIds)
                    ))
                )
            )
        } else if (userOrgId) {
            productConditions.push(
                exists(
                    db.select()
                    .from(organizationInventory)
                    .where(and(
                        eq(organizationInventory.globalProductId, globalProducts.id),
                        eq(organizationInventory.organizationId, userOrgId)
                    ))
                )
            )
        }

        const parentCategories = aliasedTable(categories, 'parentCategories')
        
        const allProducts = await db
            .select({
                id: globalProducts.id,
                productCode: globalProducts.productCode,
                name: globalProducts.name,
                unit: globalProducts.unit,
                status: globalProducts.status,
                deletedAt: globalProducts.deletedAt,
                orgIsActive: organizationInventory.isActive,
                categoryName: sql<string>`COALESCE(${parentCategories.name}, ${categories.name})`,
                subCategoryName: sql<string>`CASE WHEN ${parentCategories.id} IS NOT NULL THEN ${categories.name} ELSE NULL END`,
                basePriceCents: globalProducts.basePrice
            })
            .from(globalProducts)
            .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
            .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
            .leftJoin(organizationInventory, and(
                eq(organizationInventory.globalProductId, globalProducts.id),
                (() => {
                  if (parsedOrgIds.length > 0) {
                    return inArray(organizationInventory.organizationId, parsedOrgIds)
                  }
                  return (userOrgId ? eq(organizationInventory.organizationId, userOrgId) : undefined)
                })()
            ))
            .where(and(...productConditions))
            
        // 2. Initialize the product map with ALL products
        const isSuperAdmin = userRole === "SUPER_ADMIN"
        
        const productMap: Record<number, any> = {}
        allProducts.forEach(p => {
            productMap[p.id] = {
                productId: p.id,
                productCode: p.productCode || 'Unknown',
                productName: p.name,
                unit: p.unit,
                category: p.categoryName || 'Uncategorized',
                subCategory: p.subCategoryName || '-',
                status: (() => {
                  if (p.deletedAt) {
                    return 'deleted'
                  }
                  return (p.orgIsActive === false ? 'inactive' : p.status)
                })(),
                totalOrders: new Set(),
                qtyOrdered: 0,
                qtyFulfilled: 0,
                qtyRefunded: 0,
                revenueGeneratedCents: 0,
                basePriceCents: isSuperAdmin ? (p.basePriceCents || 0) : 0,
                unitPriceCents: p.basePriceCents || 0, // Fallback for unit price if no custom price yet
                refundLossCents: 0
            }
        })

        // Historical order items must remain reportable even if the product was
        // later removed from the current organization/branch inventory.
        results.forEach(row => {
            if (!productMap[row.globalProductId]) {
                productMap[row.globalProductId] = {
                    productId: row.globalProductId,
                    productCode: row.itemCode || 'Unknown',
                    productName: row.itemName || 'Unknown product',
                    unit: row.itemUnit,
                    category: row.categoryName || 'Uncategorized',
                    subCategory: '-',
                    status: row.productDeletedAt ? 'deleted' : row.productStatus,
                    totalOrders: new Set(),
                    qtyOrdered: 0,
                    qtyFulfilled: 0,
                    qtyRefunded: 0,
                    revenueGeneratedCents: 0,
                    basePriceCents: isSuperAdmin ? (row.basePriceCents || 0) : 0,
                    unitPriceCents: row.priceCents || 0,
                    refundLossCents: 0
                }
            }
        })

        // 3. Aggregate order data onto the product map
        results.forEach(row => {
            if (productMap[row.globalProductId]) {
                const pInfo = productMap[row.globalProductId]
                pInfo.totalOrders.add(row.orderId)
                pInfo.qtyOrdered += row.qtyOrdered

                // Determine Fulfilled vs Refunded universally for recognized statuses
                const s = (row.status || "").toUpperCase()
                if (s === 'FULFILLED' || s === 'REFUNDED' || s === 'APPROVED' || s === 'PARTIAL' || s === 'PARTIALLY_FULFILLED') {
                    const refundedCount = refundQuantities[row.orderItemId] || 0
                    const fulfilledCount = Math.max(0, row.qtyOrdered - refundedCount)

                    pInfo.qtyRefunded += refundedCount
                    pInfo.qtyFulfilled += fulfilledCount

                    pInfo.revenueGeneratedCents += (fulfilledCount * row.priceCents)
                    pInfo.refundLossCents += (refundedCount * row.priceCents)
                }
            }
        })

        // Format mapping back to an array and apply the allowlisted ranking.
        // When prices are hidden, net-value ranking is forced to fulfilled
        // quantity so the response order cannot reveal restricted price data.
        const aggregated = Object.values(productMap).map(p => ({
            ...p,
            totalOrders: p.totalOrders.size // convert set -> size
        }))
        const ranking = rankProductPerformanceRows(aggregated, {
            requestedRankBy,
            pricesHidden,
            limit: rankingLimit,
            includeZeroActivity: rankingLimit === undefined,
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
                    globalProductId: orderItems.globalProductId,
                    status: orders.status,
                    createdAt: orders.createdAt,
                    qtyOrdered: orderItems.quantity,
                    priceCents: orderItems.priceCents,
                    orderItemId: orderItems.id
                })
                .from(orderItems)
                .innerJoin(orders, eq(orderItems.orderId, orders.id))
                .where(
                    and(
                        inArray(orders.branchId, branchIds),
                        sql`UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`,
                        parsedProductIds.length > 0 ? inArray(orderItems.globalProductId, parsedProductIds) : undefined,
                        (() => {
                            const compCond: any[] = []
                            if (parsedCompMonths.length > 0 || parsedCompYears.length > 0) {
                                if (parsedCompMonths.length > 0) compCond.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(parsedCompMonths, sql.raw(", "))})`)
                                if (parsedCompYears.length > 0) compCond.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(parsedCompYears, sql.raw(", "))})`)
                            } else {
                                if (prevStart) compCond.push(gte(orders.createdAt, prevStart))
                                if (prevEnd) compCond.push(lte(orders.createdAt, prevEnd))
                            }
                            return and(...compCond)
                        })()
                    )
                )

            const compOrderItemIds = compResults.map(r => r.orderItemId)
            let compRefundQuantities: Record<number, number> = {}
            if (compOrderItemIds.length > 0) {
                const compRefunds = await db
                    .select({ orderItemId: refundItems.orderItemId, qty: refundItems.quantity })
                    .from(refundItems)
                    .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
                    .where(and(
                        inArray(refundItems.orderItemId, compOrderItemIds),
                        inArray(sql`UPPER(${refunds.status})`, ['APPROVED', 'COMPLETED']),
                    ))

                compRefundQuantities = compRefunds.reduce((acc, curr) => {
                    if (curr.orderItemId) acc[curr.orderItemId] = (acc[curr.orderItemId] || 0) + curr.qty
                    return acc
                }, {} as Record<number, number>)
            }

            let compRev = 0, compVol = 0, compRef = 0
            compResults.forEach(r => {
                const s = (r.status || "").toUpperCase()
                if (s === 'FULFILLED' || s === 'REFUNDED' || s === 'APPROVED' || s === 'PARTIAL' || s === 'PARTIALLY_FULFILLED') {
                    const refQ = compRefundQuantities[r.orderItemId] || 0
                    compRef += refQ
                    const fulfilledCount = Math.max(0, r.qtyOrdered - refQ)
                    compVol += fulfilledCount
                    compRev += (fulfilledCount * r.priceCents)
                }
            })

            comparisonSummary = {
                totalRevenue: compRev,
                totalVolume: compVol,
                totalRefunds: compRef,
                uniqueSKUs: new Set(compResults.map(r => (r as any).globalProductId)).size
            }

            // Product-level comparison map
            const compProductMap: Record<number, any> = {}
            compResults.forEach(row => {
                const gpid = (row as any).globalProductId
                if (!gpid) return
                if (!compProductMap[gpid]) {
                    compProductMap[gpid] = { qtyFulfilled: 0, revenueGeneratedCents: 0 }
                }
                const pInfo = compProductMap[gpid]
                const s = (row.status || "").toUpperCase()
                if (s === 'FULFILLED' || s === 'APPROVED' || s === 'PARTIAL' || s === 'PARTIALLY_FULFILLED' || s === 'REFUNDED') {
                    const refQ = compRefundQuantities[row.orderItemId] || 0
                    const fulfilledCount = Math.max(0, row.qtyOrdered - refQ)
                    pInfo.qtyFulfilled += fulfilledCount
                    pInfo.revenueGeneratedCents += (fulfilledCount * row.priceCents)
                }
            })

            // Attach comparison data to aggregated results
            aggregated.forEach((p: any) => {
                const comp = compProductMap[p.productId]
                if (comp) {
                    p.compareQty = comp.qtyFulfilled
                    p.compareRevenue = comp.revenueGeneratedCents
                } else {
                    p.compareQty = 0
                    p.compareRevenue = 0
                }
            })
        }

        // TREND AGGREGATION for chart
        const trend: Record<string, { 
            date: string, 
            revenue: number, 
            compareRevenue: number,
            qtyOrdered: number,
            qtyFulfilled: number,
            qtyRefunded: number
        }> = {}
        
        results.forEach(row => {
            const d = new Date(row.createdAt)
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
            if (!trend[key]) {
                trend[key] = { 
                    date: key, 
                    revenue: 0, 
                    compareRevenue: 0,
                    qtyOrdered: 0,
                    qtyFulfilled: 0,
                    qtyRefunded: 0
                }
            }
            
            trend[key].qtyOrdered += row.qtyOrdered
            const s = (row.status || "").toUpperCase()
            if (s === 'FULFILLED' || s === 'APPROVED' || s === 'PARTIAL' || s === 'PARTIALLY_FULFILLED' || s === 'REFUNDED') {
                const refQ = refundQuantities[row.orderItemId] || 0
                const fulfilledCount = Math.max(0, row.qtyOrdered - refQ)
                
                trend[key].qtyRefunded += refQ
                trend[key].qtyFulfilled += fulfilledCount
                trend[key].revenue += (fulfilledCount * row.priceCents)
            }
        })

        // If comparison results exist, we need to map them to the same "months" relatively 
        // to show them on the same X-axis if comparing same months across years.
        // For simplicity, we just return the trend of the current period.
        // If the user wants specific comparison bars, we'd need to align Jan 2025 with Jan 2026.

        return respond({
            data: ranking.data,
            trend: Object.values(trend).sort((a,b) => a.date.localeCompare(b.date)),
            comparison: comparisonSummary,
            ranking: {
                requestedRankBy,
                rankBy: ranking.rankBy,
                limit: rankingLimit || null,
            },
        })
    } catch (error: any) {
        console.error("Products Performance Request failed: ", error)
        return NextResponse.json({ error: "Failed to fetch product performance" }, { status: 500 })
    }
}
