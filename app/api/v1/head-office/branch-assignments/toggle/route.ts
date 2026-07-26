import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchInventory, branches, groups, auditLogs } from "@/db/schema"
import { eq, and, inArray, isNull } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { branchAssignmentToggleSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * PUT /api/v1/head-office/branch-assignments/toggle
 * Toggle branchInventory.isActive for a specific product in specific group(s)
 *
 * Body:
 *   organizationInventoryId: number
 *   organizationId: number
 *   isActive: boolean
 *   groupIds: number[] | "all"
 */
export async function PUT(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        const rawBody = await req.json().catch(() => null)
        const parsedBody = branchAssignmentToggleSchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        }
        const { organizationInventoryId, organizationId, isActive, groupIds } = parsedBody.data

        const sessionOrganizationId = Number((session.user as any).organizationId)
        if (userRole === "HEAD_OFFICE" && organizationId !== sessionOrganizationId) {
            return NextResponse.json({ error: "Tenant reassignment is not permitted" }, { status: 403 })
        }
        const orgId = userRole === "HEAD_OFFICE" ? sessionOrganizationId : organizationId

        // Determine which branch IDs to update
        let targetBranchIds: number[] = []

        if (groupIds === "all") {
            // Get ALL branches from ALL groups in the organization
            const orgGroups = await db.select({ id: groups.id })
                .from(groups)
                .where(
                    eq(groups.organizationId, orgId)
                )

            if (orgGroups.length > 0) {
                const groupIdList = orgGroups.map(g => g.id)
                const branchList = await db.select({ id: branches.id, name: branches.name })
                    .from(branches)
                    .where(and(
                        eq(branches.organizationId, orgId),
                        inArray(branches.groupId, groupIdList),
                    ))

                targetBranchIds = branchList.map(b => b.id)
            }
        } else {
            // Get branches for the specific group IDs
            const selectedGroupIds = (groupIds as number[]).map(Number)
            const branchList = await db.select({ id: branches.id, name: branches.name })
                .from(branches)
                .where(and(
                    eq(branches.organizationId, orgId),
                    inArray(branches.groupId, selectedGroupIds),
                ))

            targetBranchIds = branchList.map(b => b.id)
        }

        if (targetBranchIds.length === 0) {
            return NextResponse.json({
                error: "No branches found in the selected group(s)",
            }, { status: 400 })
        }

        // Update branchInventory records for this product + these branches
        const result = await db.update(branchInventory)
            .set({
                isActive,
                isVisible: isActive, // if deactivating, also hide; if activating, show
                updatedAt: new Date(),
            })
            .where(
                and(
                    eq(branchInventory.organizationInventoryId, organizationInventoryId),
                    eq(branchInventory.organizationId, orgId),
                    inArray(branchInventory.branchId, targetBranchIds),
                    isNull(branchInventory.deletedAt)
                )
            )
            .returning()

        // Audit log
        await db.insert(auditLogs).values({
            userId: (session.user as any).id,
            action: "TOGGLE_GROUP_STATUS",
            entity: "BranchInventory",
            entityId: organizationInventoryId.toString(),
            metadata: {
                organizationInventoryId,
                organizationId: orgId,
                isActive,
                groupIds,
                affectedBranches: targetBranchIds,
                updatedCount: result.length,
            },
        })

        // Invalidate cache so portals update instantly
        await invalidateByPrefix('branch-inv')

        return NextResponse.json({
            message: `Product ${isActive ? "activated" : "deactivated"} in ${result.length} branch(es)`,
            updatedCount: result.length,
        })
    } catch (error: any) {
        console.error("Error toggling group assignment:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

/**
 * GET /api/v1/head-office/branch-assignments/toggle?organizationInventoryId=X&organizationId=Y
 * Returns which groups contain this product and the per-group active status
 */
export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const userRole = (session.user as any).role
        if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        const { searchParams } = new URL(req.url)
        const organizationInventoryId = searchParams.get("organizationInventoryId")
        const organizationId = searchParams.get("organizationId")

        if (!organizationInventoryId || !organizationId) {
            return NextResponse.json({ error: "Missing organizationInventoryId or organizationId" }, { status: 400 })
        }

        // Get all branchInventory records for this product
        const assignments = await db.select({
            branchId: branchInventory.branchId,
            isActive: branchInventory.isActive,
            branchName: branches.name,
            groupId: branches.groupId,
            groupName: groups.name,
        })
            .from(branchInventory)
            .leftJoin(branches, eq(branchInventory.branchId, branches.id))
            .leftJoin(groups, eq(branches.groupId, groups.id))
            .where(
                and(
                    eq(branchInventory.organizationInventoryId, parseInt(organizationInventoryId)),
                    eq(branchInventory.organizationId, parseInt(organizationId)),
                    isNull(branchInventory.deletedAt)
                )
            )

        // Group by groupId
        const groupMap = new Map<number, {
            groupId: number
            groupName: string
            branches: { branchId: number; branchName: string; isActive: boolean }[]
            allActive: boolean
            allInactive: boolean
        }>()

        for (const a of assignments) {
            if (!a.groupId || !a.groupName) continue
            if (!groupMap.has(a.groupId)) {
                groupMap.set(a.groupId, {
                    groupId: a.groupId,
                    groupName: a.groupName,
                    branches: [],
                    allActive: true,
                    allInactive: true,
                })
            }
            const group = groupMap.get(a.groupId)!
            group.branches.push({
                branchId: a.branchId,
                branchName: a.branchName || "Unknown",
                isActive: a.isActive,
            })
            if (a.isActive) group.allInactive = false
            if (!a.isActive) group.allActive = false
        }

        return NextResponse.json({
            groups: Array.from(groupMap.values()),
        })
    } catch (error: any) {
        console.error("Error fetching toggle info:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
