import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, branches, branchInventory, groupAuditLogs } from "@/db/schema"
import { eq, and, isNull } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"

/**
 * POST /api/v1/groups/[id]/branches/clean
 * Bulk soft-delete all branchInventory records for a specific branch within a group.
 * This "cleans" a branch so it can be safely removed from the group.
 */
export async function POST(
    req: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const params = await props.params
        const { id } = params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const userOrgId = (session.user as any).organizationId

        if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        const groupId = Number.parseInt(id)
        if (Number.isNaN(groupId)) {
            return NextResponse.json({ error: "Invalid Group ID" }, { status: 400 })
        }

        const body = await req.json()
        const { branchId } = body

        if (!branchId || typeof branchId !== "number") {
            return NextResponse.json({ error: "branchId (number) is required" }, { status: 400 })
        }

        // Verify group exists
        const [group] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!group) {
            return NextResponse.json({ error: "Group not found" }, { status: 404 })
        }

        // Security check
        if (role === "HEAD_OFFICE" && group.organizationId !== userOrgId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        // Verify branch belongs to this group
        const [branch] = await db
            .select()
            .from(branches)
            .where(and(eq(branches.id, branchId), eq(branches.groupId, groupId)))
            .limit(1)

        if (!branch) {
            return NextResponse.json({
                error: "Branch not found in this group"
            }, { status: 404 })
        }

        // Soft-delete all active branchInventory records for this branch
        const now = new Date()
        const result = await db
            .update(branchInventory)
            .set({
                deletedAt: now,
                isActive: false,
                updatedAt: now,
            })
            .where(
                and(
                    eq(branchInventory.branchId, branchId),
                    eq(branchInventory.organizationId, group.organizationId),
                    isNull(branchInventory.deletedAt)
                )
            )

        const cleanedCount = result.rowCount || 0

        // Audit log
        await db.insert(groupAuditLogs).values({
            organizationId: group.organizationId,
            groupId,
            action: "CLEAN_BRANCH_PRODUCTS",
            performedByUserId: (session.user as any).id,
            performedByRole: role,
            metadata: {
                branchId,
                branchName: branch.name,
                cleanedCount,
            },
        })

        // Invalidate groups and product counts cache
        await invalidateByPrefix('group')

        return NextResponse.json({
            message: `Cleaned ${cleanedCount} product(s) from branch "${branch.name}"`,
            cleanedCount,
        })
    } catch (e: any) {
        console.error("Error cleaning branch products:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
