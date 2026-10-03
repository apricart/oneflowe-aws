import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { users, branches, roles } from "@/db/schema"
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm"
import { ORDER_CREATOR_ROLES } from "@/lib/group-order-visibility"
import { resolveUsersScopedToBranches } from "@/lib/server/multi-branch-scope"
import { hasRaisedOrderAsRequesterSql, raisedOrderAtBranchesSql } from "@/lib/server/order-creator-role-sql"

function parsePositiveIds(value: string | null): number[] {
    return value?.split(",").map(Number).filter((id) => !Number.isNaN(id) && id > 0) ?? []
}

async function resolveRequestedBranchIds({
    branchIdsParam,
    groupIdsParam,
    organizationIds,
    userRole,
    userBranchId,
}: {
    branchIdsParam: string | null
    groupIdsParam: string | null
    organizationIds: number[]
    userRole: string
    userBranchId: number
}): Promise<number[]> {
    const requestedBranchIds = parsePositiveIds(branchIdsParam)
    if (requestedBranchIds.length > 0) return requestedBranchIds

    const groupIds = parsePositiveIds(groupIdsParam)
    if (groupIds.length > 0) {
        const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, groupIds))
        return rows.map((branch) => branch.id)
    }

    const isBranchRole = userRole === "BRANCH_ADMIN" || userRole === "BRANCH_MANAGER"
    if (isBranchRole) return [userBranchId]
    if (organizationIds.length === 0) return []

    const rows = await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
    return rows.map((branch) => branch.id)
}

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const userRole = ((session.user as any).role || "").toUpperCase().replace(/\s+/g, '_')
        const userOrgId = (session.user as any).organizationId
        const userBranchId = (session.user as any).branchId

        const url = new URL(req.url)
        const organizationIdsParam = url.searchParams.get("organizationIds")
        const groupIdsParam = url.searchParams.get("groupIds")
        const branchIdsParam = url.searchParams.get("branchIds")

        const requestedOrganizationIds = parsePositiveIds(organizationIdsParam)
        const organizationIds = requestedOrganizationIds.length > 0
            ? requestedOrganizationIds
            : userOrgId ? [userOrgId] : []
        const branchIds = await resolveRequestedBranchIds({
            branchIdsParam,
            groupIdsParam,
            organizationIds,
            userRole,
            userBranchId,
        })

        const conditions: any[] = [isNull(users.deletedAt)]
        
        // Final guard: unless Super Admin, must be restricted to Org at minimum
        if (userRole !== "SUPER_ADMIN") {
            conditions.push(eq(users.organizationId, userOrgId))
        } else if (organizationIds.length > 0) {
            conditions.push(inArray(users.organizationId, organizationIds))
        }

        if (branchIds.length > 0) {
            // Three ways a person belongs to a branch for this filter, and all
            // three are needed:
            //
            //  1. `users.branch_id` — a single-branch role, pinned there now.
            //  2. an assignment — a group-based requester has no branch of its
            //     own and reaches branches through its groups, so a filter
            //     written only against that column drops it from the list even
            //     when it placed the orders being reported on.
            //  3. an order it actually raised there — the historical answer.
            //     Assignments are deleted when a user moves off a group role,
            //     and `users.branch_id` moves when a user is reassigned, so
            //     without this a person's own past orders stay in the branch's
            //     totals while the person disappears from the filter meant to
            //     select them. `orders.branch_id` and `orders.created_by_role`
            //     do not move, so this arm survives any role change.
            const scopedUserIds = await resolveUsersScopedToBranches(db, branchIds)
            const branchArms = [
                inArray(users.branchId, branchIds),
                raisedOrderAtBranchesSql(branchIds),
            ]
            if (scopedUserIds.length > 0) branchArms.push(inArray(users.id, scopedUserIds))
            conditions.push(or(...branchArms)!)
        }

        const items = await db
            .select({
                id: users.id,
                name: sql<string>`COALESCE(${users.fullName}, ${users.firstName} || ' ' || ${users.lastName}, ${users.email})`,
                employeeId: users.employeeId,
                branchId: users.branchId,
                organizationId: users.organizationId
            })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            // Both roles raise orders, so both belong in a filter over the
            // people whose orders this report can show.
            //
            // This is a union, not a swap. Current role alone drops a requester
            // who has since been promoted, taking their historical orders out of
            // reach of the filter that is supposed to find them; recorded role
            // alone drops a requester who has not placed an order yet, so they
            // could never be selected. The list needs both.
            .where(and(
                ...conditions,
                or(
                    inArray(roles.name, [...ORDER_CREATOR_ROLES]),
                    hasRaisedOrderAsRequesterSql,
                )!,
            ))
            .groupBy(users.id, users.fullName, users.firstName, users.lastName, users.email, users.employeeId, users.branchId, users.organizationId)
            .orderBy(users.fullName)
            .limit(1000)

        return NextResponse.json({ items })
    } catch (error: any) {
        console.error("User filter list fetch failed: ", error)
        return NextResponse.json({ error: "Failed to fetch user list" }, { status: 500 })
    }
}
