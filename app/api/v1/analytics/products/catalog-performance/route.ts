import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders, orderItems, branches, globalProducts, categories, organizationInventory, branchInventory } from "@/db/schema"
import { and, eq, gte, lte, inArray, desc, isNull, sql, exists, or, isNotNull } from "drizzle-orm"
import { getCached, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { redactAnalyticsPrices, shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

function positiveIds(raw: string | null, minimum = 0): number[] {
    return raw?.split(',').map(Number).filter((value) => !Number.isNaN(value) && value > minimum) ?? []
}

function catalogProductConditions(productIds: number[], branchIds: number[], organizationIds: number[]): any[] {
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
            db.select()
                .from(organizationInventory)
                .where(and(
                    eq(organizationInventory.globalProductId, globalProducts.id),
                    inArray(organizationInventory.organizationId, organizationIds),
                    or(isNull(organizationInventory.deletedAt), isNotNull(globalProducts.deletedAt)),
                )),
        ))
    }
    return conditions
}

function targetOrganizationId(isBranchScopedRole: boolean, organizationIds: number[], userOrgId: number | null) {
    if (isBranchScopedRole) return userOrgId
    return organizationIds.length === 1 ? organizationIds[0] : userOrgId
}

async function salesBranches(branchIds: number[], userOrgId: number | null): Promise<number[]> {
    if (branchIds.length > 0 || !userOrgId) return branchIds
    const orgBranches = await db.select({ id: branches.id }).from(branches).where(eq(branches.organizationId, userOrgId))
    return orgBranches.map((branch) => branch.id)
}

function addCatalogDateConditions(conditions: any[], options: {
    months: number[]
    years: number[]
    startDate: Date | null
    endDate: Date | null
}): void {
    const { months, years, startDate, endDate } = options
    if (months.length > 0) conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(months, sql.raw(", "))})`)
    if (years.length > 0) conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(years, sql.raw(", "))})`)
    if (months.length > 0 || years.length > 0) return
    if (startDate) conditions.push(gte(orders.createdAt, startDate))
    if (endDate) conditions.push(lte(orders.createdAt, endDate))
}

function catalogProductStatus(product: any): string {
    if (product.deletedAt) return "deleted"
    return product.organizationIsActive === false ? "inactive" : product.status
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId
        const pricesHidden = await shouldHidePricesForRole(userRole, userOrgId)
        const isBranchScopedRole = userRole === "BRANCH_ADMIN" || userRole === "BRANCH_MANAGER" || userRole === "ORDER_PORTAL"

        const url = new URL(req.url)
        const startDateParam = url.searchParams.get("startDate")
        const endDateParam = url.searchParams.get("endDate")
        const branchIdsParam = url.searchParams.get("branchIds")
        const groupIdsRaw = url.searchParams.get("groupIds")
        const organizationIdsRaw = url.searchParams.get("organizationIds")
        const productIdsRaw = url.searchParams.get("productIds")

        const monthsRaw = url.searchParams.get("months")
        const yearsRaw = url.searchParams.get("years")

        const parsedMonths = positiveIds(monthsRaw).filter((month) => month <= 12)
        const parsedYears = positiveIds(yearsRaw, 2000)
        const parsedGroupIds = positiveIds(groupIdsRaw)
        const parsedOrganizationIds = positiveIds(organizationIdsRaw)
        const parsedProductIds = positiveIds(productIdsRaw)

        // RBAC Context Parsing
        let branchIds: number[] = []
        if (isBranchScopedRole) {
            if (!userBranchId) return NextResponse.json({ error: "Branch not assigned" }, { status: 403 })
            branchIds = [userBranchId]
        } else if (branchIdsParam) {
            branchIds = branchIdsParam.split(",").map(Number).filter(id => !Number.isNaN(id) && id > 0)
        }

        // If specific groups selected, resolve branches for them
        if (parsedGroupIds.length > 0) {
            const groupBranches = await db.select({ id: branches.id })
                .from(branches)
                .where(inArray(branches.groupId, parsedGroupIds));
            const groupBranchIds = groupBranches.map(b => b.id);
            
            if (branchIds.length > 0) {
                branchIds = branchIds.filter(id => groupBranchIds.includes(id));
            } else {
                branchIds = groupBranchIds;
            }
        }

        const startDate = parseStartDateParam(startDateParam)
        const endDate = parseEndDateParam(endDateParam)

        const cacheKey = scopedCacheKey('analytics:catalog-performance', {
            orgId: userOrgId,
            role: userRole
        }, {
            branchIds: branchIds.join(','),
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString(),
            months: parsedMonths.join(','),
            years: parsedYears.join(','),
            productIds: parsedProductIds.join(','),
            groupIds: parsedGroupIds.join(','),
            organizationIds: parsedOrganizationIds.join(',')
        })

        const result = await getCached(cacheKey, async () => {
            // 1. Fetch products with optional Organization Price and Branch Assignment filtering
            const productConditions = catalogProductConditions(parsedProductIds, branchIds, parsedOrganizationIds)
            const targetOrgId = targetOrganizationId(isBranchScopedRole, parsedOrganizationIds, userOrgId)

            const productsQuery = db.select({
                id: globalProducts.id,
                productCode: globalProducts.productCode,
                name: globalProducts.name,
                unit: globalProducts.unit,
                status: globalProducts.status,
                basePrice: globalProducts.basePrice,
                stockQuantity: globalProducts.stockQuantity,
                categoryId: globalProducts.categoryId,
                customPrice: organizationInventory.customPrice,
                customName: organizationInventory.customName,
                deletedAt: globalProducts.deletedAt,
                organizationIsActive: organizationInventory.isActive,
            })
            .from(globalProducts)
            .leftJoin(organizationInventory, and(
                eq(organizationInventory.globalProductId, globalProducts.id),
                targetOrgId ? eq(organizationInventory.organizationId, targetOrgId) : sql`FALSE`
            ))
            .where(and(...productConditions))
            .orderBy(desc(globalProducts.id))

            const allProducts = await productsQuery

            const categoriesMap = new Map()
            const cats = await db.select({ id: categories.id, name: categories.name, parentId: categories.parentId }).from(categories)
            cats.forEach(c => categoriesMap.set(c.id, c))

            // 2. Fetch Aggregated Sales Data
            // We need to resolve branchIds if we haven't already for the sales data filter
            const salesBranchIds = await salesBranches(branchIds, userOrgId)

            const baseConditions: any[] = [
                salesBranchIds.length > 0 ? inArray(orders.branchId, salesBranchIds) : sql`TRUE`,
                sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`,
                parsedProductIds.length > 0 ? inArray(orderItems.globalProductId, parsedProductIds) : sql`TRUE`
            ]

            addCatalogDateConditions(baseConditions, { months: parsedMonths, years: parsedYears, startDate, endDate })

            const salesData = await db
                .select({
                    globalProductId: orderItems.globalProductId,
                    totalQtyOrdered: sql<number>`COALESCE(SUM(${orderItems.quantity}), 0)::numeric`,
                    totalQtyFulfilled: sql<number>`COALESCE(SUM(COALESCE(${orderItems.quantity}, 0)), 0)::numeric`, 
                    totalRevenueCents: sql<number>`SUM(ROUND(COALESCE(${orderItems.quantity}, 0) * COALESCE(${orderItems.priceCents}, 0)))::bigint`
                })
                .from(orderItems)
                .innerJoin(orders, eq(orders.id, orderItems.orderId))
                .where(and(...baseConditions))
                .groupBy(orderItems.globalProductId)

            const salesMap = new Map()
            salesData.forEach(s => salesMap.set(s.globalProductId, s))

            // 3. Merge Data
            const data = allProducts.map(p => {
                const s = salesMap.get(p.id) || { totalQtyOrdered: 0, totalQtyFulfilled: 0, totalRevenueCents: 0 }
                const catInfo = categoriesMap.get(p.categoryId)
                const parentCatInfo = catInfo?.parentId ? categoriesMap.get(catInfo.parentId) : null
                const isSuperAdmin = userRole === "SUPER_ADMIN"

                return {
                    globalProductId: p.id,
                    productCode: p.productCode,
                    productName: p.customName || p.name,
                    unit: p.unit,
                    status: catalogProductStatus(p),
                    basePriceCents: isSuperAdmin ? (p.basePrice || 0) : 0,
                    unitPriceCents: p.customPrice || p.basePrice,
                    stockQuantity: p.stockQuantity,
                    categoryName: catInfo?.name || "Uncategorized",
                    subCategoryName: parentCatInfo ? catInfo?.name : "",
                    
                    qtyOrdered: s.totalQtyOrdered,
                    qtyFulfilled: s.totalQtyFulfilled,
                    revenueGeneratedCents: Number(s.totalRevenueCents || 0),
                }
            })

            return { data }
        }, CACHE_TTL.ANALYTICS)

        return NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...result, pricesHidden: true }) : result
        )

    } catch (error: any) {
        console.error("Error fetching catalog performance:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
