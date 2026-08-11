import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchInventory,organizationInventory,branches,globalProducts,auditLogs,groups,categories } from "@/db/schema"
import { eq,and,desc,sql,inArray,isNull } from "drizzle-orm"
import { logInventoryAction } from "@/lib/global-logger"
import { invalidateByPrefix } from "@/lib/cache-utils"

// GET /api/v1/head-office/branch-assignments - List branch assignments
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Head Office or Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)

    // Get organization ID from session context (should be set by middleware)
    // For Super Admin, get from query params if available
    let organizationId = (session.user as any).organizationId
    if (userRole === "SUPER_ADMIN") {
      const orgIdParam = searchParams.get("organizationId")
      if (orgIdParam) {
        organizationId = Number.parseInt(orgIdParam)
      }
    }
    if (!organizationId) {
      return NextResponse.json({ error: "Organization not found in session" }, { status: 400 })
    }

    const branchId = searchParams.get("branchId")
    const groupId = searchParams.get("groupId") // New parameter
    const productId = searchParams.get("productId")
    const view = searchParams.get("view")
    const page = Number.parseInt(searchParams.get("page") || "1")
    const limit = Number.parseInt(searchParams.get("limit") || "50")
    const offset = (page - 1) * limit
    const parsedOrganizationId = Number(organizationId)

    if (!Number.isInteger(parsedOrganizationId) || parsedOrganizationId <= 0) {
      return NextResponse.json({ error: "Invalid organization ID" }, { status: 400 })
    }

    // The assign-to-group screen only needs product IDs, not one full product
    // payload per branch. Keep this response small even when product images are
    // stored as data URIs.
    if (view === "assignment-state") {
      const parsedGroupId = Number(groupId)
      if (!Number.isInteger(parsedGroupId) || parsedGroupId <= 0) {
        return NextResponse.json(
          { error: "A valid groupId is required for assignment-state view" },
          { status: 400 },
        )
      }

      const [group] = await db.select({ id: groups.id })
        .from(groups)
        .where(
          and(
            eq(groups.id, parsedGroupId),
            eq(groups.organizationId, parsedOrganizationId),
          ),
        )
        .limit(1)

      if (!group) {
        return NextResponse.json({ error: "Group not found" }, { status: 404 })
      }

      const [groupBranchResult, assignmentCounts] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` })
          .from(branches)
          .where(
            and(
              eq(branches.organizationId, parsedOrganizationId),
              eq(branches.groupId, parsedGroupId),
            ),
          ),
        db.select({
          organizationInventoryId: branchInventory.organizationInventoryId,
          assignedBranchCount: sql<number>`count(distinct ${branchInventory.branchId})::int`,
        })
          .from(branchInventory)
          .innerJoin(
            branches,
            and(
              eq(branchInventory.branchId, branches.id),
              eq(branches.organizationId, parsedOrganizationId),
            ),
          )
          .innerJoin(
            organizationInventory,
            and(
              eq(branchInventory.organizationInventoryId, organizationInventory.id),
              eq(organizationInventory.organizationId, parsedOrganizationId),
              isNull(organizationInventory.deletedAt),
            ),
          )
          .innerJoin(
            globalProducts,
            and(
              eq(organizationInventory.globalProductId, globalProducts.id),
              isNull(globalProducts.deletedAt),
            ),
          )
          .where(
            and(
              eq(branchInventory.organizationId, parsedOrganizationId),
              eq(branches.groupId, parsedGroupId),
              isNull(branchInventory.deletedAt),
            ),
          )
          .groupBy(branchInventory.organizationInventoryId),
      ])

      const branchCount = Number(groupBranchResult[0]?.count ?? 0)
      const organizationInventoryIds: number[] = []
      const partialOrganizationInventoryIds: number[] = []

      for (const assignment of assignmentCounts) {
        const assignedBranchCount = Number(assignment.assignedBranchCount)
        if (branchCount > 0 && assignedBranchCount === branchCount) {
          organizationInventoryIds.push(assignment.organizationInventoryId)
        } else if (assignedBranchCount > 0) {
          partialOrganizationInventoryIds.push(assignment.organizationInventoryId)
        }
      }

      return NextResponse.json({
        organizationInventoryIds,
        partialOrganizationInventoryIds,
        branchCount,
      })
    }

    const conditions = [
      eq(branchInventory.organizationId, parsedOrganizationId),
      eq(branches.organizationId, parsedOrganizationId),
      eq(organizationInventory.organizationId, parsedOrganizationId),
      isNull(branchInventory.deletedAt),
      isNull(organizationInventory.deletedAt),
      isNull(globalProducts.deletedAt),
    ]

    if (branchId) {
      conditions.push(eq(branchInventory.branchId, Number.parseInt(branchId)))
    }

    if (groupId) {
      conditions.push(eq(branches.groupId, Number.parseInt(groupId)))
    }

    console.log('[API] GET branch-assignments params:', { organizationId, branchId, groupId })
    console.log('[API] Conditions count:', conditions.length)
    // productId refers to global product; filter via organizationInventory.globalProductId after join

    const [items, totalResult] = await Promise.all([
      db.select({
        id: branchInventory.id,
        branchId: branchInventory.branchId,
        organizationId: branchInventory.organizationId,
        organizationInventoryId: branchInventory.organizationInventoryId,
        // derive globalProductId from organizationInventory/globalProducts
        globalProductId: globalProducts.id,
        isVisible: branchInventory.isVisible,
        isActive: branchInventory.isActive,
        assignedAt: branchInventory.assignedAt,
        updatedAt: branchInventory.updatedAt,
        // Related data
        productName: globalProducts.name,
        productCode: globalProducts.productCode,
        categoryName: categories.name,
        // Inline data URIs can be hundreds of KB and are repeated for every
        // branch. Keep URL-backed images, but never amplify embedded images in
        // this list response.
        productImageUrl: sql<string | null>`
          case
            when ${globalProducts.imageUrl} like 'data:%' then null
            else ${globalProducts.imageUrl}
          end
        `,
        globalStatus: globalProducts.status,
        basePrice: globalProducts.basePrice,
        unit: globalProducts.unit,
        branchName: branches.name,
        customName: organizationInventory.customName,
        customPrice: organizationInventory.customPrice,
        orgIsActive: organizationInventory.isActive,
      })
        .from(branchInventory)
        .leftJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
        .leftJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
        .leftJoin(branches, eq(branchInventory.branchId, branches.id))
        .where(
          productId
            ? and(
              ...conditions,
              eq(organizationInventory.globalProductId, Number.parseInt(productId))
            )
            : and(...conditions)
        )
        .orderBy(desc(branchInventory.assignedAt))
        .limit(limit)
        .offset(offset),

      db.select({ count: sql<number>`count(*)` })
        .from(branchInventory)
        .leftJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
        .leftJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .leftJoin(branches, eq(branchInventory.branchId, branches.id))
        .where(
          productId
            ? and(
              ...conditions,
              eq(organizationInventory.globalProductId, Number.parseInt(productId))
            )
            : and(...conditions)
        ),
    ])

    const total = totalResult[0].count

    return NextResponse.json({ items, total, page, limit })
  } catch (error) {
    console.error("Error fetching branch assignments:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// POST /api/v1/head-office/branch-assignments - Assign organization inventory products to branches
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Head Office or Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    const {
      organizationInventoryIds: requestedOrganizationInventoryIds,
      branchIds: directBranchIds, // Optional: for backward compatibility
      groupId, // New: assign to all branches in a group
      organizationId: bodyOrgId,
      isVisible = true,
    } = body

    console.log('POST /api/v1/head-office/branch-assignments received:', {
      organizationInventoryCount: Array.isArray(requestedOrganizationInventoryIds)
        ? requestedOrganizationInventoryIds.length
        : 0,
      directBranchCount: Array.isArray(directBranchIds) ? directBranchIds.length : 0,
      groupId,
    })

    // Get organizationId from session or body (for Super Admin context selector)
    let organizationId = (session.user as any).organizationId
    if (userRole === "SUPER_ADMIN" && bodyOrgId) {
      organizationId = bodyOrgId
    }
    if (!organizationId) {
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 })
    }

    const parsedOrganizationId = Number(organizationId)
    if (!Number.isInteger(parsedOrganizationId) || parsedOrganizationId <= 0) {
      return NextResponse.json({ error: "Invalid organization ID" }, { status: 400 })
    }

    if (!Array.isArray(requestedOrganizationInventoryIds) || requestedOrganizationInventoryIds.length === 0) {
      return NextResponse.json({ error: "Organization inventory IDs are required" }, { status: 400 })
    }

    const parsedOrganizationInventoryIds = requestedOrganizationInventoryIds.map(Number)
    if (parsedOrganizationInventoryIds.some(id => !Number.isInteger(id) || id <= 0)) {
      return NextResponse.json({ error: "Invalid organization inventory IDs" }, { status: 400 })
    }
    const organizationInventoryIds = [...new Set(parsedOrganizationInventoryIds)]

    // Determine branch IDs: either from groupId (expanded) or direct branchIds
    let branchIds: number[] = []
    let groupName: string | null = null

    if (groupId) {
      const parsedGroupId = Number(groupId)
      if (!Number.isInteger(parsedGroupId) || parsedGroupId <= 0) {
        return NextResponse.json({ error: "Invalid group ID" }, { status: 400 })
      }

      // Fetch group and validate it belongs to the organization
      const [group] = await db.select()
        .from(groups)
        .where(eq(groups.id, parsedGroupId))
        .limit(1)

      if (!group) {
        return NextResponse.json({ error: "Group not found" }, { status: 400 })
      }

      if (group.organizationId !== parsedOrganizationId) {
        return NextResponse.json({ error: "Group does not belong to this organization" }, { status: 403 })
      }

      groupName = group.name

      // Fetch all branches in this group
      const groupBranches = await db.select({
        id: branches.id,
      })
        .from(branches)
        .where(
          and(
            eq(branches.organizationId, parsedOrganizationId),
            eq(branches.groupId, parsedGroupId)
          )
        )

      if (groupBranches.length === 0) {
        return NextResponse.json({ error: `No branches found in group "${groupName}"` }, { status: 400 })
      }

      branchIds = groupBranches.map(b => b.id)
      console.log(`Expanded groupId ${parsedGroupId} to ${branchIds.length} branches`)
    } else if (Array.isArray(directBranchIds) && directBranchIds.length > 0) {
      // Use direct branch IDs (backward compatibility)
      const parsedBranchIds = directBranchIds.map(Number)
      if (parsedBranchIds.some(id => !Number.isInteger(id) || id <= 0)) {
        return NextResponse.json({ error: "Invalid branch IDs" }, { status: 400 })
      }
      branchIds = [...new Set(parsedBranchIds)]
    } else {
      return NextResponse.json({ error: "Either groupId or branchIds is required" }, { status: 400 })
    }

    // Verify all organization inventory items belong to this organization
    const orgInventoryItems = await db.select({
      id: organizationInventory.id,
      globalProductId: organizationInventory.globalProductId,
      isActive: organizationInventory.isActive,
    })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.organizationId, parsedOrganizationId),
          inArray(organizationInventory.id, organizationInventoryIds),
          isNull(organizationInventory.deletedAt)
        )
      )

    console.log('Organization inventory validation:', {
      requestedCount: organizationInventoryIds.length,
      foundCount: orgInventoryItems.length,
      organizationId: parsedOrganizationId
    })

    if (orgInventoryItems.length !== organizationInventoryIds.length) {
      return NextResponse.json({ error: "Some inventory items not found or access denied" }, { status: 400 })
    }

    // Check for ALL existing assignments (including soft-deleted) to handle unique constraint
    const allExistingAssignments = await db.select({
      id: branchInventory.id,
      organizationInventoryId: branchInventory.organizationInventoryId,
      branchId: branchInventory.branchId,
      deletedAt: branchInventory.deletedAt,
    })
      .from(branchInventory)
      .where(
        and(
          inArray(branchInventory.organizationInventoryId, organizationInventoryIds),
          inArray(branchInventory.branchId, branchIds)
        )
      )

    // Separate active and soft-deleted assignments
    const activeKeys = new Set(
      allExistingAssignments
        .filter(a => a.deletedAt === null)
        .map(a => `${a.organizationInventoryId}-${a.branchId}`)
    )
    const softDeletedByKey = new Map(
      allExistingAssignments
        .filter(a => a.deletedAt !== null)
        .map(a => [`${a.organizationInventoryId}-${a.branchId}`, a])
    )
    const orgInventoryById = new Map(orgInventoryItems.map(item => [item.id, item]))

    // Create assignments for each inventory item and branch combination
    const toInsert: (typeof branchInventory.$inferInsert)[] = []
    const toRestore: { id: number; isActive: boolean }[] = []  // soft-deleted records to restore

    for (const orgInventoryId of organizationInventoryIds) {
      const orgItem = orgInventoryById.get(orgInventoryId)
      if (!orgItem) continue

      for (const branchId of branchIds) {
        const key = `${orgInventoryId}-${branchId}`

        // Skip if already active
        if (activeKeys.has(key)) continue

        // Check if soft-deleted record exists - restore it instead of inserting
        const softDeleted = softDeletedByKey.get(key)

        if (softDeleted) {
          toRestore.push({ id: softDeleted.id, isActive: orgItem.isActive })
        } else {
          toInsert.push({
            branchId: Number(branchId),
            organizationId: parsedOrganizationId,
            organizationInventoryId: Number(orgInventoryId),
            assignedByUserId: (session.user as any).id,
            isVisible: Boolean(isVisible),
            isActive: orgItem.isActive, // Inherit from org inventory
          })
        }
      }
    }

    console.log('Operations:', { toInsert: toInsert.length, toRestore: toRestore.length })

    if (toInsert.length === 0 && toRestore.length === 0) {
      return NextResponse.json({
        message: "All selected products are already assigned to the selected branches",
        assignments: []
      })
    }

    const writeChunkSize = 1000
    const newAssignments = await db.transaction(async (tx) => {
      const writtenAssignments: (typeof branchInventory.$inferSelect)[] = []
      const now = new Date()

      // At most two batched UPDATE statements per chunk are needed because
      // restored rows only differ by the inherited organization active state.
      for (const inheritedIsActive of [true, false]) {
        const ids = toRestore
          .filter(item => item.isActive === inheritedIsActive)
          .map(item => item.id)

        for (let offset = 0; offset < ids.length; offset += writeChunkSize) {
          const restored = await tx.update(branchInventory)
            .set({
              deletedAt: null,
              isActive: inheritedIsActive,
              isVisible: Boolean(isVisible),
              assignedByUserId: (session.user as any).id,
              updatedAt: now,
            })
            .where(inArray(branchInventory.id, ids.slice(offset, offset + writeChunkSize)))
            .returning()
          writtenAssignments.push(...restored)
        }
      }

      // Insert in bounded bulk statements instead of one database round trip
      // per product/branch pair. The conflict guard makes concurrent retries
      // idempotent if another request inserts the same assignment first.
      for (let offset = 0; offset < toInsert.length; offset += writeChunkSize) {
        const inserted = await tx.insert(branchInventory)
          .values(toInsert.slice(offset, offset + writeChunkSize))
          .onConflictDoNothing()
          .returning()
        writtenAssignments.push(...inserted)
      }

      // Keep the audit row in the same transaction so a logging failure cannot
      // leave the request partially applied. entityId is limited to 128 chars.
      if (writtenAssignments.length > 0) {
        const firstAssignmentId = writtenAssignments[0].id
        const lastAssignmentId = writtenAssignments.at(-1)!.id
        const entityId = writtenAssignments.length === 1
          ? String(firstAssignmentId)
          : `${firstAssignmentId}-${lastAssignmentId}`

        await tx.insert(auditLogs).values({
          userId: (session.user as any).id,
          organizationId: parsedOrganizationId,
          action: "CREATE",
          entity: "BranchAssignment",
          entityId,
          metadata: {
            assignedCount: writtenAssignments.length,
            organizationId: parsedOrganizationId,
            organizationInventoryIds,
            branchIds,
            groupId: groupId || null,
            groupName: groupName || null,
            skippedCount: (organizationInventoryIds.length * branchIds.length) - writtenAssignments.length
          },
        })
      }

      return writtenAssignments
    })

    console.log('Completed branch assignment writes:', {
      plannedInserts: toInsert.length,
      plannedRestores: toRestore.length,
      written: newAssignments.length,
    })

    // Log to inventory audit file
    logInventoryAction(
      'ASSIGN',
      'BRANCH_ASSIGNMENT',
      {
        id: (session.user as any).id,
        email: (session.user as any).email,
        role: (session.user as any).role
      },
      {
        organizationId: parsedOrganizationId,
        productIds: organizationInventoryIds,
        assignmentIds: newAssignments.map(a => a.id),
        count: newAssignments.length,
        metadata: {
          branchIds: branchIds,
          groupId: groupId || null,
          groupName: groupName || null,
          skipped: (organizationInventoryIds.length * branchIds.length) - newAssignments.length
        }
      }
    )

    // Invalidate branch inventory cache so portals see changes instantly
    await invalidateByPrefix('branch-inv')

    return NextResponse.json({
      message: groupName
        ? `${newAssignments.length} products assigned to group "${groupName}" (${branchIds.length} branches) successfully!`
        : `${newAssignments.length} products assigned to branches successfully!`,
      assignments: newAssignments,
      skipped: (organizationInventoryIds.length * branchIds.length) - newAssignments.length,
      groupName: groupName,
      branchCount: branchIds.length
    })
  } catch (error: any) {
    console.error("Error creating branch assignments:", error)

    // Check for duplicate key constraint
    if (error.message?.includes('duplicate key') || error.code === '23505') {
      return NextResponse.json({
        error: "Some products are already assigned to these branches"
      }, { status: 400 })
    }

    // Check for foreign key constraint violation
    if (error.code === '23503') {
      return NextResponse.json({
        error: "Invalid reference: One or more IDs do not exist in the database"
      }, { status: 400 })
    }

    // Don't expose internal error details
    return NextResponse.json({
      error: "Internal Server Error"
    }, { status: 500 })
  }
}

// DELETE /api/v1/head-office/branch-assignments - Remove product from branch
export async function DELETE(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Head Office or Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")
    const branchId = searchParams.get("branchId")
    const productId = searchParams.get("productId")
    const queryOrgId = searchParams.get("organizationId")

    // Get organization ID - from session for HEAD_OFFICE, from query param for SUPER_ADMIN
    let organizationId = (session.user as any).organizationId

    // SUPER_ADMIN can pass organizationId via query param, or we'll get it from the assignment
    if (userRole === "SUPER_ADMIN" && !organizationId) {
      organizationId = queryOrgId
    }

    // If deleting by specific ID, we can look up the organization from the assignment
    if (id && !organizationId) {
      const [assignment] = await db.select({ organizationId: branchInventory.organizationId })
        .from(branchInventory)
        .where(eq(branchInventory.id, Number.parseInt(id)))
        .limit(1)
      if (assignment) {
        organizationId = String(assignment.organizationId)
      }
    }

    if (!organizationId) {
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 })
    }

    // Parse organizationId to number for use in queries and logging
    const orgIdNum = Number.parseInt(String(organizationId))

    const whereConditions = [
      eq(branchInventory.organizationId, orgIdNum),
      isNull(branchInventory.deletedAt)
    ]

    if (id) {
      whereConditions.push(eq(branchInventory.id, Number.parseInt(id)))
    }
    if (branchId) {
      whereConditions.push(eq(branchInventory.branchId, Number.parseInt(branchId)))
    }
    if (productId) {
      // Resolve product filter via organizationInventory.globalProductId
      // We'll apply this in the query where clause with a join
    }

    if (whereConditions.length === 2) {
      return NextResponse.json({ error: "Assignment ID, Branch ID, or Product ID is required" }, { status: 400 })
    }

    // Find assignments to be deleted
    const assignmentsToDelete = await db.select({
      id: branchInventory.id,
      branchId: branchInventory.branchId,
      organizationInventoryId: branchInventory.organizationInventoryId,
    })
      .from(branchInventory)
      .leftJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
      .where(
        productId
          ? and(
            ...whereConditions,
            eq(organizationInventory.globalProductId, Number.parseInt(productId))
          )
          : and(...whereConditions)
      )

    if (!assignmentsToDelete || assignmentsToDelete.length === 0) {
      return NextResponse.json({ error: "No assignments found" }, { status: 404 })
    }

    // Soft delete the assignments
    const now = new Date()
    await db.update(branchInventory)
      .set({
        deletedAt: now,
        updatedAt: now
      })
      .where(
        productId
          ? and(
            ...whereConditions,
            inArray(
              branchInventory.id,
              assignmentsToDelete.map(a => a.id)
            )
          )
          : and(...whereConditions)
      )

    // Log the assignment deletion
    try {
      await db.insert(auditLogs).values({
        userId: (session.user as any).id,
        organizationId: orgIdNum,
        action: "DELETE",
        entity: "BranchAssignment",
        entityId: id || "bulk",
        metadata: {
          deletedCount: assignmentsToDelete.length,
          branchId,
          productId
        },
      })
    } catch (auditError) {
      console.error("Failed to insert audit log:", auditError)
    }

    // Log to inventory audit file
    try {
      logInventoryAction(
        'REMOVE',
        'BRANCH_ASSIGNMENT',
        {
          id: (session.user as any).id,
          email: (session.user as any).email || 'unknown',
          role: (session.user as any).role || userRole
        },
        {
          organizationId: orgIdNum,
          branchId: branchId ? Number.parseInt(branchId) : undefined,
          assignmentIds: assignmentsToDelete.map(a => a.id),
          count: assignmentsToDelete.length,
          metadata: { productId }
        }
      )
    } catch (logError) {
      console.error("Failed to log inventory action:", logError)
    }

    // Invalidate branch inventory cache so portals see changes instantly
    await invalidateByPrefix('branch-inv')

    return NextResponse.json({
      message: "Branch assignments removed successfully",
      count: assignmentsToDelete.length
    })
  } catch (error: any) {
    console.error("Error deleting branch assignments:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/head-office/branch-assignments - Update branch-level settings
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "HEAD_OFFICE" && userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Head Office or Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    const {
      id,
      isVisible,
      isActive,
      organizationId: bodyOrgId
    } = body

    let organizationId = (session.user as any).organizationId
    if (userRole === "SUPER_ADMIN" && bodyOrgId) {
      organizationId = bodyOrgId
    }

    if (!organizationId) {
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 })
    }

    if (!id) {
      return NextResponse.json({ error: "Assignment ID is required" }, { status: 400 })
    }

    const updateData: any = {
      updatedAt: new Date()
    }

    if (isVisible !== undefined) updateData.isVisible = isVisible
    if (isActive !== undefined) updateData.isActive = isActive

    const [updatedAssignment] = await db.update(branchInventory)
      .set(updateData)
      .where(
        and(
          eq(branchInventory.id, Number.parseInt(id)),
          eq(branchInventory.organizationId, Number.parseInt(organizationId)),
          isNull(branchInventory.deletedAt)
        )
      )
      .returning()

    if (!updatedAssignment) {
      return NextResponse.json({ error: "Assignment not found or access denied" }, { status: 404 })
    }

    // Log the update
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "UPDATE",
      entity: "BranchAssignment",
      entityId: id.toString(),
      metadata: {
        organizationId,
        updateData,
        level: "head_office"
      },
    })

    return NextResponse.json({
      message: "Branch assignment updated successfully",
      assignment: updatedAssignment
    })
  } catch (error: any) {
    console.error("Error updating branch assignment:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

