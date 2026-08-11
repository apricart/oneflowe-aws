import { NextResponse,type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders,orderItems,branches,users,groups,categories,globalProducts,organizations,refundItems } from "@/db/schema"
import { and,desc,eq,gte,lte,sql } from "drizzle-orm"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { isValidRole } from "@/lib/rbac"
import { getCached,generateCacheKey } from "@/lib/cache-utils"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

function parseNumericId(value: string | null, paramName: string): number | null {
    if (!value || value === "all") return null
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed) || parsed <= 0) {
        console.warn(`[ProductSummary] Invalid ${paramName}: ${value}`)
        return null
    }
    return parsed
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json(
                { error: "Unauthorized", message: "Authentication required" },
                { status: 401 }
            )
        }

        const userId = (session.user as any).id
        const userRole = (session.user as any).role
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId

        if (!userId || typeof userId !== 'string') {
            console.error('[ProductSummary] Invalid user ID in session')
            return NextResponse.json(
                { error: "Invalid session", message: "User ID not found" },
                { status: 401 }
            )
        }

        const role = userRole ? String(userRole).toUpperCase() : ""
        if (!isValidRole(role as any)) {
            console.error('[ProductSummary] Invalid role:', userRole)
            return NextResponse.json(
                { error: "Invalid role", message: "User role is invalid" },
                { status: 403 }
            )
        }
        const pricesHidden = await shouldHidePricesForRole(role, userOrgId)

        const url = new URL(req.url)
        const startDate = parseStartDateParam(url.searchParams.get("startDate"))
        const endDate = parseEndDateParam(url.searchParams.get("endDate"))
        const branchId = parseNumericId(url.searchParams.get("branchId"), "branchId")
        const organizationId = parseNumericId(url.searchParams.get("organizationId"), "organizationId")
        const groupId = parseNumericId(url.searchParams.get("groupId"), "groupId")

        if (startDate && endDate && startDate > endDate) {
            return NextResponse.json(
                { error: "Invalid date range", message: "Start date must be before end date" },
                { status: 400 }
            )
        }

        const cacheKey = generateCacheKey('product-summary', {
            role,
            userId,
            startDate: startDate?.toISOString(),
            endDate: endDate?.toISOString(),
            branchId,
            organizationId,
            groupId
        })

        const fetchData = async () => {
            const conditions = []

            if (role === "SUPER_ADMIN") {
                if (organizationId) conditions.push(eq(orders.organizationId, organizationId))
                if (branchId) conditions.push(eq(orders.branchId, branchId))
                if (groupId) conditions.push(eq(branches.groupId, groupId))
            } else if (role === "HEAD_OFFICE") {
                if (!userOrgId) {
                    throw new Error("No organization assigned to user")
                }
                conditions.push(eq(orders.organizationId, userOrgId))
                if (branchId) conditions.push(eq(orders.branchId, branchId))
                if (groupId) conditions.push(eq(branches.groupId, groupId))
            } else if (role === "BRANCH_ADMIN" || role === "BRANCH_MANAGER" || role === "ORDER_PORTAL") {
                if (!userBranchId) {
                    throw new Error("No branch assigned to user")
                }
                conditions.push(eq(orders.branchId, userBranchId))
            } else {
                throw new Error("Insufficient permissions")
            }

            if (startDate) {
                conditions.push(gte(orders.createdAt, startDate))
            }
            if (endDate) {
                conditions.push(lte(orders.createdAt, endDate))
            }

            const data = await db
                .select({
                    orderDate: orders.createdAt,
                    tid: orders.tid,
                    userEmail: users.email,
                    employeeId: users.id,
                    groupName: groups.name,
                    organizationName: organizations.name,
                    productName: orderItems.productName,
                    productCode: orderItems.productCode,
                    categoryName: sql<string>`COALESCE((SELECT c2.name FROM categories c2 WHERE c2.id = ${categories.parentId}), ${categories.name})`,
                    subCategoryName: sql<string>`CASE WHEN ${categories.parentId} IS NOT NULL THEN ${categories.name} ELSE NULL END`,
                    branchName: branches.name,
                    quantity: orderItems.quantity,
                    priceCents: orderItems.priceCents,
                    refundedQuantity: sql<number>`COALESCE(${refundItems.quantity}, 0)`.mapWith(Number),
                    refundAmountCents: sql<number>`COALESCE(${refundItems.amountCents}, 0)`.mapWith(Number),
                    orderStatus: orders.status,
                    orderId: orders.id
                })
                .from(orderItems)
                .innerJoin(orders, eq(orderItems.orderId, orders.id))
                .innerJoin(branches, eq(orders.branchId, branches.id))
                .innerJoin(users, eq(orders.createdByUserId, users.id))
                .leftJoin(organizations, eq(orders.organizationId, organizations.id))
                .leftJoin(groups, eq(branches.groupId, groups.id))
                .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
                .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
                .leftJoin(refundItems, eq(orderItems.id, refundItems.orderItemId))
                .where(conditions.length > 0 ? and(...conditions) : undefined)
                .orderBy(desc(orders.createdAt))
                .limit(5000)

            return data
        }

        const data = await getCached(cacheKey, fetchData, 300)

        const payload = {
            items: data,
            metadata: {
                count: data.length,
                cached: true,
                filters: {
                    startDate: startDate?.toISOString(),
                    endDate: endDate?.toISOString(),
                    branchId,
                    organizationId,
                    groupId
                }
            }
        }

        return NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden: true }) : payload
        )

    } catch (error: any) {
        logError(error, 'PRODUCT_SUMMARY_API', {
            url: req.url,
            method: req.method
        })

        const errorResponse = handleError(error, 'Product Summary API')

        return NextResponse.json(
            {
                error: "Internal Server Error",
                message: errorResponse.message || "An unexpected error occurred"
            },
            { status: 500 }
        )
    }
}
