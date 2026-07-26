import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { groups, groupAuditLogs, branches, branchInventory, organizationInventory, globalProducts } from "@/db/schema"
import { eq, and, sql, count, isNull, or, ne, inArray } from "drizzle-orm"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { groupUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function GET(
    req: NextRequest,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const params = await props.params
        const { id } = params
        const session = await getServerSession(authOptions)
        if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

        const role = (session.user as any).role
        const orgId = (session.user as any).organizationId
        const groupId = parseInt(id)

        if (isNaN(groupId)) {
            return NextResponse.json({ error: "Invalid Group ID" }, { status: 400 })
        }

        const [group] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!group) {
            return NextResponse.json({ error: "Group not found" }, { status: 404 })
        }

        // Security check: Non-SUPER_ADMIN can only see groups in their org
        if (role !== "SUPER_ADMIN" && group.organizationId !== orgId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 })
        }

        return NextResponse.json({ group })
    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function PUT(
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

        const groupId = parseInt(id)
        if (isNaN(groupId)) {
            return NextResponse.json({ error: "Invalid Group ID" }, { status: 400 })
        }

        const rawBody = await req.json().catch(() => null)
        const parsedBody = groupUpdateSchema.safeParse(rawBody)
        if (!parsedBody.success) {
            return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
        }
        const { name, description } = parsedBody.data

        const [existing] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!existing) {
            return NextResponse.json({ error: "Group not found" }, { status: 404 })
        }

        // Security check: Head Office can only update groups in their org
        if (role === "HEAD_OFFICE" && existing.organizationId !== userOrgId) {
            return NextResponse.json({ error: "Forbidden: You can only edit groups within your own organization" }, { status: 403 })
        }

        // Collision check: Ensure new name isn't already used in this organization (case-insensitive)
        if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
            const [collision] = await db
                .select()
                .from(groups)
                .where(
                    and(
                        eq(groups.organizationId, existing.organizationId),
                        sql`lower(${groups.name}) = lower(${name})`,
                        sql`${groups.id} != ${groupId}`,
                        sql`${groups.status} != 'deleted'`
                    )
                )
                .limit(1)

            if (collision) {
                return NextResponse.json({ error: `The name "${name}" is already used by another group in your organization.` }, { status: 409 })
            }
        }

        const [updated] = await db
            .update(groups)
            .set({
                name: name ?? existing.name,
                description: description ?? existing.description,
                updatedAt: new Date(),
            })
            .where(eq(groups.id, groupId))
            .returning()

        // Log action
        await db.insert(groupAuditLogs).values({
            organizationId: existing.organizationId,
            groupId: groupId,
            action: "UPDATE_GROUP",
            performedByUserId: (session.user as any).id,
            performedByRole: role,
            metadata: {
                old: { name: existing.name, description: existing.description, status: existing.status },
                new: { name: updated.name, description: updated.description, status: updated.status },
            },
        })

        // Invalidate all group-related caches (list and counts)
        await invalidateByPrefix('group')

        return NextResponse.json({ group: updated })
    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

export async function DELETE(
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

        const groupId = parseInt(id)
        if (isNaN(groupId)) {
            return NextResponse.json({ error: "Invalid Group ID" }, { status: 400 })
        }

        const [existing] = await db
            .select()
            .from(groups)
            .where(eq(groups.id, groupId))
            .limit(1)

        if (!existing) {
            return NextResponse.json({ error: "Group not found" }, { status: 404 })
        }

        // Security check: Head Office can only delete groups in their org
        if (role === "HEAD_OFFICE" && existing.organizationId !== userOrgId) {
            return NextResponse.json({ error: "Forbidden: You can only delete groups within your own organization" }, { status: 403 })
        }

        // Check for assigned branches
        const [branchCount] = await db.select({ val: count() }).from(branches).where(eq(branches.groupId, groupId))
        if (branchCount.val > 0) {
            // Auto-clean: soft-delete branch inventory records for globally deleted products
            const branchIdsInGroup = await db.select({ id: branches.id })
                .from(branches)
                .where(eq(branches.groupId, groupId))

            if (branchIdsInGroup.length > 0) {
                const branchIdList = branchIdsInGroup.map(b => b.id)
                const staleRecords = await db.select({ biId: branchInventory.id })
                    .from(branchInventory)
                    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
                    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
                    .where(
                        and(
                            inArray(branchInventory.branchId, branchIdList),
                            isNull(branchInventory.deletedAt),
                            sql`${globalProducts.deletedAt} IS NOT NULL`
                        )
                    )

                if (staleRecords.length > 0) {
                    await db.update(branchInventory)
                        .set({ deletedAt: new Date(), updatedAt: new Date() })
                        .where(inArray(branchInventory.id, staleRecords.map(r => r.biId)))
                }
            }

            // Count remaining assigned products (matches what Group Products page shows)
            const [productCount] = await db
                .select({ val: count() })
                .from(branchInventory)
                .innerJoin(branches, eq(branchInventory.branchId, branches.id))
                .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
                .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
                .where(
                    and(
                        eq(branches.groupId, groupId),
                        isNull(branchInventory.deletedAt),
                        isNull(globalProducts.deletedAt)
                    )
                )

            if (productCount.val > 0) {
                return NextResponse.json({
                    error: `Cannot delete: This group has ${branchCount.val} branch(es) with ${productCount.val} product(s) assigned. Please remove all products from branches in this group first.`
                }, { status: 400 })
            }

            return NextResponse.json({
                error: `Cannot delete: This group has ${branchCount.val} branch(es) assigned. Please remove all branches from the group first.`
            }, { status: 400 })
        }

        // Soft delete: set status to 'deleted'
        await db.transaction(async (tx) => {
            // 1. Mark group as deleted
            await tx.update(groups).set({
                status: 'deleted',
                updatedAt: new Date()
            }).where(eq(groups.id, groupId))

            // 2. Log the deletion
            await tx.insert(groupAuditLogs).values({
                organizationId: existing.organizationId,
                groupId: groupId,
                action: "DELETE_GROUP",
                performedByUserId: (session.user as any).id,
                performedByRole: role,
                metadata: {
                    name: existing.name,
                },
            })
        })

        // Invalidate all group-related caches (list and counts)
        await invalidateByPrefix('group')

        return NextResponse.json({ message: "Group deleted successfully" })
    } catch (e: any) {
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}
