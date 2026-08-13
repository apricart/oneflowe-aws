import { NextResponse,type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders,orderItems,branches,users,organizations,groups } from "@/db/schema"
import { and,desc,eq,gte,lte } from "drizzle-orm"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

function getSuperAdminConditions(requestedOrganizationId: string | null, requestedBranchId: string | null) {
    const conditions: any[] = []
    if (requestedOrganizationId && requestedOrganizationId !== "all") {
        conditions.push(eq(orders.organizationId, Number(requestedOrganizationId)))
    }
    if (requestedBranchId && requestedBranchId !== "all") {
        conditions.push(eq(orders.branchId, Number(requestedBranchId)))
    }
    return { conditions }
}

function getHeadOfficeConditions(organizationId: number | null | undefined, requestedBranchId: string | null) {
    const conditions: any[] = []
    if (!organizationId) return { conditions, error: "Organization not found" }
    conditions.push(eq(orders.organizationId, organizationId))
    if (requestedBranchId && requestedBranchId !== "all") {
        conditions.push(eq(orders.branchId, Number(requestedBranchId)))
    }
    return { conditions }
}

function getBranchConditions(branchId: number | null | undefined) {
    if (!branchId) return { conditions: [], error: "Branch not assigned" }
    return { conditions: [eq(orders.branchId, branchId)] }
}

function getAccessConditions(role: string, context: {
    organizationId: number | null | undefined
    branchId: number | null | undefined
    requestedOrganizationId: string | null
    requestedBranchId: string | null
}): { conditions: any[]; error?: string } {
    if (role === "SUPER_ADMIN") {
        return getSuperAdminConditions(context.requestedOrganizationId, context.requestedBranchId)
    }
    if (role === "HEAD_OFFICE") {
        return getHeadOfficeConditions(context.organizationId, context.requestedBranchId)
    }
    if (["BRANCH_ADMIN", "BRANCH_MANAGER", "ORDER_PORTAL"].includes(role)) {
        return getBranchConditions(context.branchId)
    }
    return { conditions: [], error: "Forbidden" }
}

function addDateConditions(conditions: any[], startDate: string | null, endDate: string | null) {
    const start = parseStartDateParam(startDate)
    const end = parseEndDateParam(endDate)
    if (start) conditions.push(gte(orders.createdAt, start))
    if (end) conditions.push(lte(orders.createdAt, end))
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userId = (session.user as any).id
        const userRole = (session.user as any).role
        const role = userRole ? userRole.toUpperCase() : ""

        const url = new URL(req.url)
        const startDate = url.searchParams.get("startDate")
        const endDate = url.searchParams.get("endDate")
        const branchIdParam = url.searchParams.get("branchId")
        const organizationIdParam = url.searchParams.get("organizationId")

        // Get user context for strict RBAC
        const [currentUser] = await db.select({
            organizationId: users.organizationId,
            branchId: users.branchId
        }).from(users).where(eq(users.id, userId)).limit(1)

        const access = getAccessConditions(role, {
            organizationId: currentUser?.organizationId,
            branchId: currentUser?.branchId,
            requestedOrganizationId: organizationIdParam,
            requestedBranchId: branchIdParam,
        })
        if (access.error) return NextResponse.json({ error: access.error }, { status: 403 })
        const conditions = access.conditions
        const pricesHidden = await shouldHidePricesForRole(role, currentUser?.organizationId)

        // 2. Date Filtering
        addDateConditions(conditions, startDate, endDate)

        // 3. Execution - Granular Details (Not Aggregated)
        const data = await db
            .select({
                id: orderItems.id,
                productName: orderItems.productName,
                productCode: orderItems.productCode,
                unit: orderItems.unit,
                quantity: orderItems.quantity,
                priceCents: orderItems.priceCents,
                tid: orders.tid,
                orderDate: orders.createdAt,
                organizationName: organizations.name,
                groupName: groups.name,
                branchName: branches.name,
                createdByName: users.fullName,
                createdByEmail: users.email
            })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .innerJoin(branches, eq(orders.branchId, branches.id))
            .innerJoin(users, eq(orders.createdByUserId, users.id))
            .leftJoin(organizations, eq(orders.organizationId, organizations.id))
            .leftJoin(groups, eq(branches.groupId, groups.id))
            .where(and(...conditions))
            .orderBy(desc(orders.createdAt), desc(orderItems.id))

        const payload = { items: data }
        return NextResponse.json(
            pricesHidden ? redactAnalyticsPrices({ ...payload, pricesHidden: true }) : payload
        )
    } catch (error: any) {
        console.error("Product Details API Error:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
