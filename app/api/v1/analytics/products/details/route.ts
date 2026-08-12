import { NextResponse,type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { orders,orderItems,branches,users,organizations,groups } from "@/db/schema"
import { and,desc,eq,gte,lte } from "drizzle-orm"
import { redactAnalyticsPrices,shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"

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

        const conditions = []

        // 1. Role-Based Access Control
        if (role === "SUPER_ADMIN") {
            if (organizationIdParam && organizationIdParam !== "all") {
                conditions.push(eq(orders.organizationId, Number(organizationIdParam)))
            }
            if (branchIdParam && branchIdParam !== "all") {
                conditions.push(eq(orders.branchId, Number(branchIdParam)))
            }
        } else if (role === "HEAD_OFFICE") {
            const orgId = currentUser?.organizationId
            if (!orgId) return NextResponse.json({ error: "Organization not found" }, { status: 403 })

            conditions.push(eq(orders.organizationId, orgId))

            if (branchIdParam && branchIdParam !== "all") {
                conditions.push(eq(orders.branchId, Number(branchIdParam)))
            }
        } else if (role === "BRANCH_ADMIN" || role === "BRANCH_MANAGER" || role === "ORDER_PORTAL") {
            const bId = currentUser?.branchId
            if (!bId) return NextResponse.json({ error: "Branch not assigned" }, { status: 403 })
            conditions.push(eq(orders.branchId, bId))
        } else {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }
        const pricesHidden = await shouldHidePricesForRole(role, currentUser?.organizationId)

        // 2. Date Filtering
        if (startDate) {
            const start = parseStartDateParam(startDate)
            if (start) conditions.push(gte(orders.createdAt, start))
        }
        if (endDate) {
            const end = parseEndDateParam(endDate)
            if (end) conditions.push(lte(orders.createdAt, end))
        }

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
