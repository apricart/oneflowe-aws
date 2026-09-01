import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups,branches,groupAuditLogs,branchInventory } from "@/db/schema"
import { eq,inArray,and,sql,isNull,count } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { groupBranchesUpdateSchema,validationMessage } from "@/lib/server/mutation-validation"

/**
 * Who may read or change a group's branch list.
 *
 * The same rule serves GET and PUT so the two cannot drift apart: only the two
 * roles that administer groups at all, and Head Office only inside its own
 * organization. Super Admin is the one role that crosses tenants, which is the
 * rule the rest of `/api/v1/groups` already applies.
 *
 * Returning the group is what lets the callers pin their own queries to the
 * tenant that owns it, rather than trusting the id from the URL.
 */
const GROUP_BRANCH_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"]

type AuthorizedGroup = {
    group: { id: number; organizationId: number }
    role: string
    userId: string
}

async function authorizeGroupBranchAccess(
    idParam: string,
): Promise<{ authorized: AuthorizedGroup; failure?: undefined } | { authorized?: undefined; failure: NextResponse }> {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
        return { failure: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
    }

    const role = (session.user as any).role
    if (!GROUP_BRANCH_ROLES.includes(role)) {
        return { failure: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    }

    const groupId = Number.parseInt(idParam)
    if (!Number.isInteger(groupId) || groupId <= 0) {
        return { failure: NextResponse.json({ error: "Invalid ID" }, { status: 400 }) }
    }

    const [group] = await db
        .select({ id: groups.id, organizationId: groups.organizationId })
        .from(groups)
        .where(eq(groups.id, groupId))
        .limit(1)
    if (!group) {
        return { failure: NextResponse.json({ error: "Group not found" }, { status: 404 }) }
    }

    if (role === "HEAD_OFFICE" && group.organizationId !== (session.user as any).organizationId) {
        return {
            failure: NextResponse.json(
                { error: "Forbidden: You can only manage branches for groups within your own organization" },
                { status: 403 },
            ),
        }
    }

    return { authorized: { group, role, userId: (session.user as any).id } }
}

async function getBlockedBranchRemovals(groupId: number, nextBranchIds: number[]) {
    const currentBranches = await db.select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(eq(branches.groupId, groupId))
    const removedIds = currentBranches.filter((branch) => !nextBranchIds.includes(branch.id)).map((branch) => branch.id)
    if (removedIds.length === 0) return { currentBranches, blocked: [] }
    const rows = await db
        .select({
            branchId: branchInventory.branchId,
            branchName: branches.name,
            productCount: count(branchInventory.id),
        })
        .from(branchInventory)
        .innerJoin(branches, eq(branchInventory.branchId, branches.id))
        .where(and(
            inArray(branchInventory.branchId, removedIds),
            isNull(branchInventory.deletedAt),
            eq(branchInventory.isActive, true),
        ))
        .groupBy(branchInventory.branchId, branches.name)
    return { currentBranches, blocked: rows.filter((branch) => branch.productCount > 0) }
}

async function validateGroupBranches(tx: any, branchIds: number[], groupId: number, organizationId: number) {
    if (branchIds.length === 0) return
    const conflicts = await tx.select().from(branches).where(and(
        inArray(branches.id, branchIds),
        sql`${branches.groupId} IS NOT NULL`,
        sql`${branches.groupId} != ${groupId}`,
    ))
    if (conflicts.length > 0) {
        throw new Error(`These branches are already assigned to another group: ${conflicts.map((branch: any) => branch.name).join(", ")}. Please release them first.`)
    }
    const invalid = await tx.select().from(branches).where(and(
        inArray(branches.id, branchIds),
        sql`${branches.organizationId} != ${organizationId}`,
    ))
    if (invalid.length > 0) throw new Error("Unauthorized: Some branches do not belong to this organization.")
}

async function assignBranches(tx: any, branchIds: number[], groupId: number, organizationId: number) {
    await tx.update(branches).set({ groupId: null }).where(eq(branches.groupId, groupId))
    if (branchIds.length === 0) return 0
    const result = await tx.update(branches)
        .set({ groupId })
        .where(and(inArray(branches.id, branchIds), eq(branches.organizationId, organizationId)))
    return result.rowCount || 0
}

async function copyProductsToBranch(tx: any, newBranchId: number, products: Map<number, any>, userId: string) {
    const existing = await tx.select({
        id: branchInventory.id,
        organizationInventoryId: branchInventory.organizationInventoryId,
        deletedAt: branchInventory.deletedAt,
    }).from(branchInventory).where(and(
        eq(branchInventory.branchId, newBranchId),
        inArray(branchInventory.organizationInventoryId, Array.from(products.keys())),
    ))
    const active = new Set(existing.filter((item: any) => item.deletedAt === null).map((item: any) => item.organizationInventoryId))
    const deleted = new Map(existing.filter((item: any) => item.deletedAt !== null).map((item: any) => [item.organizationInventoryId, item.id]))
    const restoreIds: number[] = []
    const insertRows: any[] = []
    products.forEach((product, organizationInventoryId) => {
        if (active.has(organizationInventoryId)) return
        const deletedId = deleted.get(organizationInventoryId)
        if (deletedId) restoreIds.push(Number(deletedId))
        else insertRows.push({
            branchId: newBranchId,
            organizationId: product.organizationId,
            organizationInventoryId,
            assignedByUserId: userId,
            isVisible: true,
            isActive: true,
        })
    })
    if (restoreIds.length > 0) {
        await tx.update(branchInventory).set({
            deletedAt: null,
            isActive: true,
            isVisible: true,
            assignedByUserId: userId,
            updatedAt: new Date(),
        }).where(inArray(branchInventory.id, restoreIds))
    }
    if (insertRows.length > 0) await tx.insert(branchInventory).values(insertRows)
}

async function copyGroupProducts(tx: any, currentBranchIds: number[], newBranchIds: number[], userId: string) {
    if (newBranchIds.length === 0 || currentBranchIds.length === 0) return
    const existingProducts = await tx.select({
        organizationInventoryId: branchInventory.organizationInventoryId,
        organizationId: branchInventory.organizationId,
    }).from(branchInventory).where(and(
        inArray(branchInventory.branchId, currentBranchIds),
        isNull(branchInventory.deletedAt),
        eq(branchInventory.isActive, true),
    ))
    const products = new Map<number, any>()
    existingProducts.forEach((product: any) => products.set(product.organizationInventoryId, product))
    if (products.size === 0) return
    for (const branchId of newBranchIds) await copyProductsToBranch(tx, branchId, products, userId)
}

async function updateGroupBranchesTransaction({ group, groupId, branchIds, currentBranchIds, newlyAddedBranchIds, userId, role }: any) {
    await db.transaction(async (tx) => {
        await validateGroupBranches(tx, branchIds, groupId, group.organizationId)
        const assignedCount = await assignBranches(tx, branchIds, groupId, group.organizationId)
        await copyGroupProducts(tx, currentBranchIds, newlyAddedBranchIds, userId)
        await tx.update(groups).set({
            status: assignedCount > 0 ? "connected" : "not connected",
            updatedAt: new Date(),
        }).where(eq(groups.id, groupId))
        await tx.insert(groupAuditLogs).values({
            organizationId: group.organizationId,
            groupId,
            action: "ASSIGN_BRANCHES",
            performedByUserId: userId,
            performedByRole: role,
            metadata: { branchIds, newlyAddedBranchIds, autoAssignedProducts: newlyAddedBranchIds.length > 0 },
        })
    })
}

export async function GET(_: Request, props: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await props.params
        const { authorized, failure } = await authorizeGroupBranchAccess(id)
        if (failure) return failure

        const assignedBranches = await db
            // Only the identity fields the group screens render. The row also
            // carries budget baselines, the branch admin, and external identity
            // columns, none of which a branch list needs to expose.
            .select({
                id: branches.id,
                name: branches.name,
                code: branches.code,
                city: branches.city,
                status: branches.status,
                organizationId: branches.organizationId,
                groupId: branches.groupId,
            })
            .from(branches)
            .where(and(
                eq(branches.groupId, authorized.group.id),
                // Pinned to the tenant that owns the group, so a branch row that
                // somehow referenced another tenant's group cannot surface here.
                eq(branches.organizationId, authorized.group.organizationId),
            ))
            .orderBy(branches.name)

        return NextResponse.json({ branches: assignedBranches })
    } catch (error) {
        console.error("Failed to list group branches:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await props.params
        const { authorized, failure } = await authorizeGroupBranchAccess(id)
        if (failure) return failure
        const { group, role } = authorized
        const groupId = group.id
        const parsedBody = groupBranchesUpdateSchema.safeParse(await req.json().catch(() => null))
        if (!parsedBody.success) return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        const { branchIds, newlyAddedBranchIds: clientNewIds } = parsedBody.data
        const protection = await getBlockedBranchRemovals(groupId, branchIds)
        if (protection.blocked.length > 0) {
            const details = protection.blocked.map((branch) => `${branch.branchName} (${branch.productCount} products)`)
            return NextResponse.json({
                error: `Cannot remove branches with assigned products. Clean products first from: ${details.join(", ")}`,
                blockedBranches: protection.blocked,
            }, { status: 400 })
        }
        const currentBranchIds = protection.currentBranches.map((branch) => branch.id)
        const newlyAddedBranchIds = Array.isArray(clientNewIds)
            ? clientNewIds
            : branchIds.filter((branchId) => !currentBranchIds.includes(branchId))
        await updateGroupBranchesTransaction({
            group,
            groupId,
            branchIds,
            currentBranchIds,
            newlyAddedBranchIds,
            userId: authorized.userId,
            role,
        })
        await invalidateByPrefix('group')
        await invalidateByPrefix('branches')
        // A branch that changed group also changed the prices it pays, and the
        // branch inventory listings are cached per branch.
        await invalidateByPrefix('branch-inv')
        const autoMessage = newlyAddedBranchIds.length > 0
            ? ` ${newlyAddedBranchIds.length} new branch(es) received group products automatically.`
            : ""
        return NextResponse.json({
            message: `Branch assignments updated.${autoMessage}`,
            newlyAddedBranchIds,
        })
    } catch (error) {
        console.error("Failed to update group branch assignments:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
