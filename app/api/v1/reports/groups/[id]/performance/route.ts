import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branches, orders, groups } from "@/db/schema"
import { eq, and, gte, lte, sql, inArray } from "drizzle-orm"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const userOrgId = (session.user as any).organizationId
        const groupId = Number.parseInt(id)

        if (Number.isNaN(groupId)) {
            return NextResponse.json({ error: "Invalid Group ID" }, { status: 400 })
        }

        // 1. Verify Group Access
        const [group] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!group) {
            return NextResponse.json({ error: "Group not found" }, { status: 404 })
        }

        // Security: Head Office can only see their own groups
        if (role === "HEAD_OFFICE" && group.organizationId !== userOrgId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        // Security: Branch Admin can't see full group reports typically, but if they could, restrict potential misuse.
        // For now, we assume this is an Admin/Head Office feature as per request.
        if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
            // Optional: Allow Branch Admin IF specific permission grant exists, but enforcing strict roles for now.
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        // 2. Parse Query Params
        const { searchParams } = new URL(req.url)
        const startDateParam = searchParams.get("startDate")
        const endDateParam = searchParams.get("endDate")
        const startDate = startDateParam
            ? parseStartDateParam(startDateParam) || new Date(startDateParam)
            : new Date(new Date().getFullYear(), new Date().getMonth(), 1) // Default: Start of current month

        const endDate = endDateParam
            ? parseEndDateParam(endDateParam) || new Date(endDateParam)
            : new Date() // Default: Now

        // Ensure endDate extends to end of the day if just a date string provided (simple robustness)
        // If it's pure ISO from frontend component, typically it's specific. 
        // We'll trust the Date constructor but potentially adjust if needed.

        const statusFilter = searchParams.get("status") || "FULFILLED" // Default to completed sales

        // 3. Fetch Branches in Group
        const branchList = await db
            .select({
                id: branches.id,
                name: branches.name,
                code: branches.code,
                status: branches.status
            })
            .from(branches)
            .where(eq(branches.groupId, groupId))

        if (branchList.length === 0) {
            return NextResponse.json({
                meta: {
                    groupName: group.name,
                    period: { start: startDate, end: endDate },
                    totalGroupSpend: 0,
                    totalGroupOrders: 0
                },
                items: []
            })
        }

        const branchIds = branchList.map(b => b.id)

        // 4. Aggregate Orders
        // We perform aggregation on orders and join to branches later or just filter by branchIds
        // Using a single query is most efficient
        const metrics = await db
            .select({
                branchId: orders.branchId,
                totalOrders: sql<number>`count(${orders.id})::int`,
                totalSpend: sql<number>`sum(${orders.totalCents})::int`,
                lastOrderDate: sql<string>`max(${orders.createdAt})`
            })
            .from(orders)
            .where(
                and(
                    inArray(orders.branchId, branchIds),
                    gte(orders.createdAt, startDate),
                    lte(orders.createdAt, endDate),
                    // If 'ALL' status passed, ignore status filter? Or explicit list?
                    // User probably wants to see confirmed sales.
                    statusFilter !== "ALL" ? eq(orders.status, statusFilter) : undefined
                )
            )
            .groupBy(orders.branchId)

        // 5. Merge Data (Zero-Fill)
        // Ensure even zero-sale branches are returned
        const metricsMap = new Map(metrics.map(m => [m.branchId, m]))

        let groupTotalSpend = 0
        let groupTotalOrders = 0

        const items = branchList.map(branch => {
            const m = metricsMap.get(branch.id)
            const spent = m?.totalSpend || 0
            const count = m?.totalOrders || 0

            groupTotalSpend += spent
            groupTotalOrders += count

            return {
                branchId: branch.id,
                branchName: branch.name,
                branchCode: branch.code,
                branchStatus: branch.status,
                totalOrders: count,
                totalSpendCents: spent,
                averageOrderValueCents: count > 0 ? Math.round(spent / count) : 0,
                lastActivity: m?.lastOrderDate || null
            }
        })

        // Sort by Spend (High to Low) by default
        items.sort((a, b) => b.totalSpendCents - a.totalSpendCents)

        return NextResponse.json({
            meta: {
                groupName: group.name,
                period: { start: startDate, end: endDate },
                totalGroupSpend: groupTotalSpend,
                totalGroupOrders: groupTotalOrders
            },
            items
        })

    } catch (e: any) {
        console.error("Reporting API Error:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
