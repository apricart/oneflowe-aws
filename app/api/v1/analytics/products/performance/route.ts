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

const PERFORMANCE_STATUSES = new Set(['FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'])

function parseNumberList(value: string | null, isValid = (number: number) => number > 0) {
    return value
        ? value.split(',').map(Number).filter((number) => !Number.isNaN(number) && isValid(number))
        : []
}

function getRequestedOrganizationIds(searchParams: URLSearchParams) {
    const organizationIds = parseNumberList(searchParams.get("organizationIds"))
    if (organizationIds.length > 0) return organizationIds
    return parseNumberList(searchParams.get("organizationId"))
}

async function resolveProductBranches({
    role,
    userBranchId,
    userOrganizationId,
    organizationIds,
    requestedBranchIds,
    groupIds,
}: {
    role: string
    userBranchId: unknown
    userOrganizationId: number | null
    organizationIds: number[]
    requestedBranchIds: number[]
    groupIds: number[]
}) {
    let allowedBranchQuery = db.select({ id: branches.id }).from(branches)
    if (organizationIds.length > 0) {
        allowedBranchQuery = allowedBranchQuery.where(inArray(branches.organizationId, organizationIds)) as any
    }
    const allowedBranches = await allowedBranchQuery
    let branchIds = resolveAnalyticsBranchIds({
        role,
        userBranchId,
        requestedBranchIds,
        allowedBranchIds: allowedBranches.map((branch) => branch.id),
    })
    if (groupIds.length === 0) return branchIds

    let organizationCondition = organizationIds.length > 0
        ? inArray(branches.organizationId, organizationIds)
        : undefined
    if (organizationIds.length === 0 && userOrganizationId) {
        organizationCondition = eq(branches.organizationId, userOrganizationId)
    }
    const groupBranches = await db.select({ id: branches.id })
        .from(branches)
        .where(and(inArray(branches.groupId, groupIds), organizationCondition))
    const groupBranchIds = new Set(groupBranches.map((branch) => branch.id))
    branchIds = branchIds.filter((branchId) => groupBranchIds.has(branchId))
    return branchIds
}

function applyDateFilters(conditions: any[], months: number[], years: number[], start?: Date, end?: Date) {
    if (months.length > 0) {
        conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    }
    if (years.length > 0) {
        conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    }
    if (months.length > 0 || years.length > 0) return
    if (start) conditions.push(gte(orders.createdAt, start))
    if (end) conditions.push(lte(orders.createdAt, end))
}

function getSearchCondition(searchTerm: string) {
    if (!searchTerm) return undefined
    return or(
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
}

async function loadRefundQuantities(orderItemIds: number[]) {
    if (orderItemIds.length === 0) return {} as Record<number, number>
    const rows = await db
        .select({ orderItemId: refundItems.orderItemId, qty: refundItems.quantity })
        .from(refundItems)
        .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
        .where(and(
            inArray(refundItems.orderItemId, orderItemIds),
            inArray(sql`UPPER(${refunds.status})`, ['APPROVED', 'COMPLETED']),
        ))
    return rows.reduce((acc, row) => {
        if (row.orderItemId) acc[row.orderItemId] = (acc[row.orderItemId] || 0) + row.qty
        return acc
    }, {} as Record<number, number>)
}

function buildProductScopeConditions(productIds: number[], branchIds: number[], organizationIds: number[], userOrganizationId: number | null) {
    const conditions: any[] = []
    if (productIds.length > 0) conditions.push(inArray(globalProducts.id, productIds))
    if (branchIds.length > 0) {
        conditions.push(exists(
            db.select()
                .from(branchInventory)
                .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
                .where(and(
                    eq(organizationInventory.globalProductId, globalProducts.id),
                    inArray(branchInventory.branchId, branchIds),
                )),
        ))
    } else if (organizationIds.length > 0) {
        conditions.push(exists(
            db.select().from(organizationInventory).where(and(
                eq(organizationInventory.globalProductId, globalProducts.id),
                inArray(organizationInventory.organizationId, organizationIds),
            )),
        ))
    } else if (userOrganizationId) {
        conditions.push(exists(
            db.select().from(organizationInventory).where(and(
                eq(organizationInventory.globalProductId, globalProducts.id),
                eq(organizationInventory.organizationId, userOrganizationId),
            )),
        ))
    }
    return conditions
}

function getInventoryOrganizationCondition(organizationIds: number[], userOrganizationId: number | null) {
    if (organizationIds.length > 0) return inArray(organizationInventory.organizationId, organizationIds)
    return userOrganizationId ? eq(organizationInventory.organizationId, userOrganizationId) : undefined
}

function getProductStatus(product: any) {
    if (product.deletedAt) return 'deleted'
    return product.orgIsActive === false ? 'inactive' : product.status
}

function initializeProductMap(allProducts: any[], results: any[], isSuperAdmin: boolean) {
    const productMap: Record<number, any> = {}
    allProducts.forEach((product) => {
        productMap[product.id] = {
            productId: product.id,
            productCode: product.productCode || 'Unknown',
            productName: product.name,
            unit: product.unit,
            category: product.categoryName || 'Uncategorized',
            subCategory: product.subCategoryName || '-',
            status: getProductStatus(product),
            totalOrders: new Set(),
            qtyOrdered: 0,
            qtyFulfilled: 0,
            qtyRefunded: 0,
            revenueGeneratedCents: 0,
            basePriceCents: isSuperAdmin ? (product.basePriceCents || 0) : 0,
            unitPriceCents: product.basePriceCents || 0,
            refundLossCents: 0,
        }
    })
    results.forEach((row) => {
        if (productMap[row.globalProductId]) return
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
            refundLossCents: 0,
        }
    })
    return productMap
}

function aggregateProductRows(productMap: Record<number, any>, rows: any[], refundQuantities: Record<number, number>) {
    rows.forEach((row) => {
        const product = productMap[row.globalProductId]
        if (!product) return
        product.totalOrders.add(row.orderId)
        product.qtyOrdered += row.qtyOrdered
        if (!PERFORMANCE_STATUSES.has((row.status || "").toUpperCase())) return
        const refundedCount = refundQuantities[row.orderItemId] || 0
        const fulfilledCount = Math.max(0, row.qtyOrdered - refundedCount)
        product.qtyRefunded += refundedCount
        product.qtyFulfilled += fulfilledCount
        product.revenueGeneratedCents += fulfilledCount * row.priceCents
        product.refundLossCents += refundedCount * row.priceCents
    })
}

function getPreviousRange(startParam: string, endParam: string, compareStart: string | null, compareEnd: string | null) {
    if (compareStart && compareEnd) {
        return {
            start: parseStartDateParam(compareStart) || new Date(compareStart),
            end: parseEndDateParam(compareEnd) || new Date(compareEnd),
        }
    }
    const start = parseStartDateParam(startParam) || new Date(startParam)
    const end = parseEndDateParam(endParam) || new Date(endParam)
    const duration = end.getTime() - start.getTime()
    return { start: new Date(start.getTime() - duration - 1), end: new Date(start.getTime() - 1) }
}

async function loadComparisonRows(
    branchIds: number[],
    productIds: number[],
    months: number[],
    years: number[],
    range: { start: Date; end: Date },
) {
    const dateConditions: any[] = []
    applyDateFilters(dateConditions, months, years, range.start, range.end)
    return db
        .select({
            globalProductId: orderItems.globalProductId,
            status: orders.status,
            createdAt: orders.createdAt,
            qtyOrdered: orderItems.quantity,
            priceCents: orderItems.priceCents,
            orderItemId: orderItems.id,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(and(
            inArray(orders.branchId, branchIds),
            sql`UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`,
            productIds.length > 0 ? inArray(orderItems.globalProductId, productIds) : undefined,
            and(...dateConditions),
        ))
}

function summarizeComparison(rows: any[], refundQuantities: Record<number, number>) {
    const totals = { totalRevenue: 0, totalVolume: 0, totalRefunds: 0, uniqueSKUs: 0 }
    const productMap: Record<number, { qtyFulfilled: number; revenueGeneratedCents: number }> = {}
    const uniqueProducts = new Set<number>()
    rows.forEach((row) => {
        if (!row.globalProductId || !PERFORMANCE_STATUSES.has((row.status || "").toUpperCase())) return
        const refunded = refundQuantities[row.orderItemId] || 0
        const fulfilled = Math.max(0, row.qtyOrdered - refunded)
        totals.totalRefunds += refunded
        totals.totalVolume += fulfilled
        totals.totalRevenue += fulfilled * row.priceCents
        uniqueProducts.add(row.globalProductId)
        productMap[row.globalProductId] ||= { qtyFulfilled: 0, revenueGeneratedCents: 0 }
        productMap[row.globalProductId].qtyFulfilled += fulfilled
        productMap[row.globalProductId].revenueGeneratedCents += fulfilled * row.priceCents
    })
    totals.uniqueSKUs = uniqueProducts.size
    return { totals, productMap }
}

function attachProductComparisons(products: any[], comparisonMap: Record<number, any>) {
    products.forEach((product) => {
        const comparison = comparisonMap[product.productId]
        product.compareQty = comparison?.qtyFulfilled || 0
        product.compareRevenue = comparison?.revenueGeneratedCents || 0
    })
}

async function getProductComparison(
    aggregated: any[],
    branchIds: number[],
    productIds: number[],
    months: number[],
    years: number[],
    range: { start: Date; end: Date },
) {
    const rows = await loadComparisonRows(branchIds, productIds, months, years, range)
    const refundQuantities = await loadRefundQuantities(rows.map((row) => row.orderItemId))
    const { totals, productMap } = summarizeComparison(rows, refundQuantities)
    attachProductComparisons(aggregated, productMap)
    return totals
}

function buildProductTrend(rows: any[], refundQuantities: Record<number, number>) {
    const trend: Record<string, {
        date: string
        revenue: number
        compareRevenue: number
        qtyOrdered: number
        qtyFulfilled: number
        qtyRefunded: number
    }> = {}
    rows.forEach((row) => {
        const date = new Date(row.createdAt)
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
        trend[key] ||= { date: key, revenue: 0, compareRevenue: 0, qtyOrdered: 0, qtyFulfilled: 0, qtyRefunded: 0 }
        trend[key].qtyOrdered += row.qtyOrdered
        if (!PERFORMANCE_STATUSES.has((row.status || "").toUpperCase())) return
        const refunded = refundQuantities[row.orderItemId] || 0
        const fulfilled = Math.max(0, row.qtyOrdered - refunded)
        trend[key].qtyRefunded += refunded
        trend[key].qtyFulfilled += fulfilled
        trend[key].revenue += fulfilled * row.priceCents
    })
    return Object.values(trend).sort((a, b) => a.date.localeCompare(b.date))
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

        const isMonth = (number: number) => number >= 1 && number <= 12
        const isYear = (number: number) => number > 2000
        const parsedMonths = parseNumberList(url.searchParams.get("months"), isMonth)
        const parsedYears = parseNumberList(url.searchParams.get("years"), isYear)
        const parsedCompMonths = parseNumberList(url.searchParams.get("compareMonths"), isMonth)
        const parsedCompYears = parseNumberList(url.searchParams.get("compareYears"), isYear)
        const parsedGroupIds = parseNumberList(url.searchParams.get("groupIds"))
        const parsedProductIds = parseNumberList(url.searchParams.get("productIds"))
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
        const requestedOrgIds = getRequestedOrganizationIds(url.searchParams)
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
        const branchIds = await resolveProductBranches({
            role: userRole,
            userBranchId,
            userOrganizationId: userOrgId,
            organizationIds: parsedOrgIds,
            requestedBranchIds: parseNumberList(branchIdsParam),
            groupIds: parsedGroupIds,
        })

        if (branchIds.length === 0) {
            const status = isBranchScopedAnalyticsRole(userRole) ? 403 : 400
            return NextResponse.json({ error: "No permitted branches resolved" }, { status })
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const baseConditions: any[] = [
            inArray(orders.branchId, branchIds),
            sql`UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`
        ]

        if (parsedProductIds.length > 0) {
            baseConditions.push(inArray(globalProducts.id, parsedProductIds))
        }
        const searchCondition = getSearchCondition(searchTerm)
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

        const refundQuantities = await loadRefundQuantities(results.map((row) => row.orderItemId))

        // 1. Fetch relevant global products based on filtering and scoping
        const productConditions = buildProductScopeConditions(parsedProductIds, branchIds, parsedOrgIds, userOrgId)

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
                getInventoryOrganizationCondition(parsedOrgIds, userOrgId)
            ))
            .where(and(...productConditions))
            
        // 2. Initialize the product map with ALL products
        const isSuperAdmin = userRole === "SUPER_ADMIN"
        
        const productMap = initializeProductMap(allProducts, results, isSuperAdmin)
        aggregateProductRows(productMap, results, refundQuantities)

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

        const comparisonSummary = compare && startDateParam && endDateParam
            ? await getProductComparison(
                aggregated,
                branchIds,
                parsedProductIds,
                parsedCompMonths,
                parsedCompYears,
                getPreviousRange(startDateParam, endDateParam, compareStartDateParam, compareEndDateParam),
            )
            : null
        const trend = buildProductTrend(results, refundQuantities)

        // If comparison results exist, we need to map them to the same "months" relatively 
        // to show them on the same X-axis if comparing same months across years.
        // For simplicity, we just return the trend of the current period.
        // If the user wants specific comparison bars, we'd need to align Jan 2025 with Jan 2026.

        return respond({
            data: ranking.data,
            trend,
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
