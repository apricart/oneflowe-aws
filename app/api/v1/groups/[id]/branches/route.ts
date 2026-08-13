import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups,branches,groupAuditLogs,branchInventory } from "@/db/schema"
import { eq,inArray,and,sql,isNull,count } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { groupBranchesUpdateSchema,validationMessage } from "@/lib/server/mutation-validation"

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
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        const groupId = Number.parseInt(id)
        if (Number.isNaN(groupId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
        const assignedBranches = await db.select().from(branches).where(eq(branches.groupId, groupId))
        return NextResponse.json({ branches: assignedBranches })
    } catch (error) {
        console.error("Failed to list group branches:", error)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await props.params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        const role = (session.user as any).role
        const userOrganizationId = (session.user as any).organizationId
        if (!["SUPER_ADMIN", "HEAD_OFFICE"].includes(role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        const groupId = Number.parseInt(id)
        if (Number.isNaN(groupId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
        const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
        if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 })
        if (role === "HEAD_OFFICE" && group.organizationId !== userOrganizationId) {
            return NextResponse.json({ error: "Forbidden: You can only manage branches for groups within your own organization" }, { status: 403 })
        }
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
            userId: (session.user as any).id,
            role,
        })
        await invalidateByPrefix('group')
        await invalidateByPrefix('branches')
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
