import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, branches, groupAuditLogs, branchInventory } from "@/db/schema"
import { eq, inArray, and, sql, isNull, count } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { groupBranchesUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function GET(
    req: Request,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const params = await props.params
        const { id } = params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const groupId = parseInt(id)
        if (isNaN(groupId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 })

        const assignedBranches = await db
            .select()
            .from(branches)
            .where(eq(branches.groupId, groupId))

        return NextResponse.json({ branches: assignedBranches })
    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function PUT(
    req: Request,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const params = await props.params
        const { id } = params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const userOrgId = (session.user as any).organizationId
        if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

        const groupId = parseInt(id)
        if (isNaN(groupId)) return NextResponse.json({ error: "Invalid ID" }, { status: 400 })

        const [group] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 })

        // Security check: Head Office can only manage branches for groups in their org
        if (role === "HEAD_OFFICE" && group.organizationId !== userOrgId) {
            return NextResponse.json({ error: "Forbidden: You can only manage branches for groups within your own organization" }, { status: 403 })
        }

        const rawBody = await req.json().catch(() => null)
        const parsedBody = groupBranchesUpdateSchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        }
        const { branchIds, newlyAddedBranchIds: clientNewIds } = parsedBody.data

        // ============================================================
        // PRODUCT PROTECTION: Check if branches being REMOVED have products
        // ============================================================
        // Find branches currently in this group that are NOT in the new list
        const currentBranches = await db
            .select({ id: branches.id, name: branches.name })
            .from(branches)
            .where(eq(branches.groupId, groupId))

        const branchIdsBeingRemoved = currentBranches
            .filter(b => !branchIds.includes(b.id))
            .map(b => b.id)

        if (branchIdsBeingRemoved.length > 0) {
            // Check for active products on branches being removed
            const branchesWithProducts = await db
                .select({
                    branchId: branchInventory.branchId,
                    branchName: branches.name,
                    productCount: count(branchInventory.id),
                })
                .from(branchInventory)
                .innerJoin(branches, eq(branchInventory.branchId, branches.id))
                .where(
                    and(
                        inArray(branchInventory.branchId, branchIdsBeingRemoved),
                        isNull(branchInventory.deletedAt),
                        eq(branchInventory.isActive, true)
                    )
                )
                .groupBy(branchInventory.branchId, branches.name)

            const blocked = branchesWithProducts.filter(b => b.productCount > 0)
            if (blocked.length > 0) {
                const details = blocked.map(b => `${b.branchName} (${b.productCount} products)`)
                return NextResponse.json({
                    error: `Cannot remove branches with assigned products. Clean products first from: ${details.join(", ")}`,
                    blockedBranches: blocked.map(b => ({
                        branchId: b.branchId,
                        branchName: b.branchName,
                        productCount: b.productCount,
                    })),
                }, { status: 400 })
            }
        }

        // Determine which branches are being ADDED (not currently in the group or explicitly marked by client)
        const currentBranchIds = currentBranches.map(b => b.id)
        const newlyAddedBranchIds = Array.isArray(clientNewIds)
            ? clientNewIds
            : branchIds.filter((id: number) => !currentBranchIds.includes(id))

        await db.transaction(async (tx) => {
            // 1. Branch exclusivity validation (Atomic check)
            if (branchIds.length > 0) {
                const conflictBranches = await tx
                    .select()
                    .from(branches)
                    .where(
                        and(
                            inArray(branches.id, branchIds),
                            sql`${branches.groupId} IS NOT NULL`,
                            sql`${branches.groupId} != ${groupId}`
                        )
                    )

                if (conflictBranches.length > 0) {
                    const names = conflictBranches.map(b => b.name).join(", ")
                    throw new Error(`These branches are already assigned to another group: ${names}. Please release them first.`)
                }

                // 2. Validate that branches actually belong to this organization
                const invalidBranches = await tx
                    .select()
                    .from(branches)
                    .where(
                        and(
                            inArray(branches.id, branchIds),
                            sql`${branches.organizationId} != ${group.organizationId}`
                        )
                    )

                if (invalidBranches.length > 0) {
                    throw new Error(`Unauthorized: Some branches do not belong to this organization.`)
                }
            }

            // 3. Remove all current branches from this group
            await tx
                .update(branches)
                .set({ groupId: null })
                .where(eq(branches.groupId, groupId))

            // 4. Assign new branches (if any)
            let assignedCount = 0
            if (branchIds.length > 0) {
                const result = await tx
                    .update(branches)
                    .set({ groupId: groupId })
                    .where(
                        and(
                            inArray(branches.id, branchIds),
                            eq(branches.organizationId, group.organizationId)
                        )
                    )
                assignedCount = result.rowCount || 0
            }

            // 5. AUTO-ASSIGN: Copy group products to newly added branches
            if (newlyAddedBranchIds.length > 0 && currentBranchIds.length > 0) {
                // Find all active products assigned to existing group branches
                const existingProducts = await tx
                    .select({
                        organizationInventoryId: branchInventory.organizationInventoryId,
                        organizationId: branchInventory.organizationId,
                    })
                    .from(branchInventory)
                    .where(
                        and(
                            inArray(branchInventory.branchId, currentBranchIds),
                            isNull(branchInventory.deletedAt),
                            eq(branchInventory.isActive, true)
                        )
                    )

                // Deduplicate by organizationInventoryId
                const uniqueProducts = new Map<number, { organizationInventoryId: number; organizationId: number }>()
                for (const p of existingProducts) {
                    if (!uniqueProducts.has(p.organizationInventoryId)) {
                        uniqueProducts.set(p.organizationInventoryId, p)
                    }
                }

                if (uniqueProducts.size > 0) {
                    for (const newBranchId of newlyAddedBranchIds) {
                        // Check for existing assignments (including soft-deleted) for this branch
                        const existingAssignments = await tx
                            .select({
                                id: branchInventory.id,
                                organizationInventoryId: branchInventory.organizationInventoryId,
                                deletedAt: branchInventory.deletedAt,
                            })
                            .from(branchInventory)
                            .where(
                                and(
                                    eq(branchInventory.branchId, newBranchId),
                                    inArray(branchInventory.organizationInventoryId,
                                        Array.from(uniqueProducts.keys())
                                    )
                                )
                            )

                        const activeKeys = new Set(
                            existingAssignments
                                .filter(a => a.deletedAt === null)
                                .map(a => a.organizationInventoryId)
                        )
                        const softDeletedMap = new Map(
                            existingAssignments
                                .filter(a => a.deletedAt !== null)
                                .map(a => [a.organizationInventoryId, a.id])
                        )

                        const toInsert = []
                        const toRestore: number[] = []

                        for (const [orgInvId, product] of uniqueProducts) {
                            if (activeKeys.has(orgInvId)) continue // Already active

                            const softDeletedId = softDeletedMap.get(orgInvId)
                            if (softDeletedId) {
                                toRestore.push(softDeletedId)
                            } else {
                                toInsert.push({
                                    branchId: newBranchId,
                                    organizationId: product.organizationId,
                                    organizationInventoryId: orgInvId,
                                    assignedByUserId: (session.user as any).id,
                                    isVisible: true,
                                    isActive: true,
                                })
                            }
                        }

                        // Restore soft-deleted records
                        if (toRestore.length > 0) {
                            await tx.update(branchInventory)
                                .set({
                                    deletedAt: null,
                                    isActive: true,
                                    isVisible: true,
                                    assignedByUserId: (session.user as any).id,
                                    updatedAt: new Date(),
                                })
                                .where(inArray(branchInventory.id, toRestore))
                        }

                        // Insert new records
                        if (toInsert.length > 0) {
                            await tx.insert(branchInventory).values(toInsert)
                        }
                    }
                }
            }

            // 6. Update group status based on assignment
            await tx
                .update(groups)
                .set({
                    status: assignedCount > 0 ? "connected" : "not connected",
                    updatedAt: new Date()
                })
                .where(eq(groups.id, groupId))

            // 7. Log assignment action
            await tx.insert(groupAuditLogs).values({
                organizationId: group.organizationId,
                groupId,
                action: "ASSIGN_BRANCHES",
                performedByUserId: (session.user as any).id,
                performedByRole: role,
                metadata: {
                    branchIds,
                    newlyAddedBranchIds,
                    autoAssignedProducts: newlyAddedBranchIds.length > 0,
                },
            })
        })

        // Invalidate both groups (branch count changed) and branches (groupId changed) caches
        await invalidateByPrefix('group')
        await invalidateByPrefix('branches')

        const autoMsg = newlyAddedBranchIds.length > 0
            ? ` ${newlyAddedBranchIds.length} new branch(es) received group products automatically.`
            : ""

        return NextResponse.json({
            message: `Branch assignments updated.${autoMsg}`,
            newlyAddedBranchIds,
        })
    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
