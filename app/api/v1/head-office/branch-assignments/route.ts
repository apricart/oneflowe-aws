import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchInventory,organizationInventory,branches,globalProducts,auditLogs,groups,categories } from "@/db/schema"
import { eq,and,desc,sql,inArray,isNull } from "drizzle-orm"
import { logInventoryAction } from "@/lib/global-logger"
import { invalidateByPrefix } from "@/lib/cache-utils"

function resolveAssignmentOrganizationId(role: string, sessionOrganizationId: any, requestedOrganizationId: any) {
  return Number(role === "SUPER_ADMIN" && requestedOrganizationId ? requestedOrganizationId : sessionOrganizationId)
}

async function loadAssignmentState(organizationId: number, groupIdValue: string | null) {
  const groupId = Number(groupIdValue)
  if (!Number.isInteger(groupId) || groupId <= 0) return { error: "A valid groupId is required for assignment-state view", status: 400 }
  const [group] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.organizationId, organizationId))).limit(1)
  if (!group) return { error: "Group not found", status: 404 }
  const [branchRows, assignmentCounts] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(branches)
      .where(and(eq(branches.organizationId, organizationId), eq(branches.groupId, groupId))),
    db.select({
      organizationInventoryId: branchInventory.organizationInventoryId,
      assignedBranchCount: sql<number>`count(distinct ${branchInventory.branchId})::int`,
    }).from(branchInventory)
      .innerJoin(branches, and(eq(branchInventory.branchId, branches.id), eq(branches.organizationId, organizationId)))
      .innerJoin(organizationInventory, and(
        eq(branchInventory.organizationInventoryId, organizationInventory.id),
        eq(organizationInventory.organizationId, organizationId),
        isNull(organizationInventory.deletedAt),
      ))
      .innerJoin(globalProducts, and(eq(organizationInventory.globalProductId, globalProducts.id), isNull(globalProducts.deletedAt)))
      .where(and(eq(branchInventory.organizationId, organizationId), eq(branches.groupId, groupId), isNull(branchInventory.deletedAt)))
      .groupBy(branchInventory.organizationInventoryId),
  ])
  const branchCount = Number(branchRows[0]?.count ?? 0)
  const assigned: number[] = []
  const partial: number[] = []
  assignmentCounts.forEach((assignment) => {
    const count = Number(assignment.assignedBranchCount)
    if (branchCount > 0 && count === branchCount) assigned.push(assignment.organizationInventoryId)
    else if (count > 0) partial.push(assignment.organizationInventoryId)
  })
  return { organizationInventoryIds: assigned, partialOrganizationInventoryIds: partial, branchCount }
}

function buildAssignmentConditions(organizationId: number, branchId: string | null, groupId: string | null) {
  const conditions: any[] = [
    eq(branchInventory.organizationId, organizationId),
    eq(branches.organizationId, organizationId),
    eq(organizationInventory.organizationId, organizationId),
    isNull(branchInventory.deletedAt),
    isNull(organizationInventory.deletedAt),
    isNull(globalProducts.deletedAt),
  ]
  if (branchId) conditions.push(eq(branchInventory.branchId, Number.parseInt(branchId)))
  if (groupId) conditions.push(eq(branches.groupId, Number.parseInt(groupId)))
  return conditions
}

async function resolveAssignmentBranches(organizationId: number, groupIdValue: any, directBranchIds: any) {
  if (!groupIdValue) {
    if (!Array.isArray(directBranchIds) || directBranchIds.length === 0) return { error: "Either groupId or branchIds is required", status: 400 }
    const ids = directBranchIds.map(Number)
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: "Invalid branch IDs", status: 400 }
    return { branchIds: [...new Set<number>(ids)], groupName: null }
  }
  const groupId = Number(groupIdValue)
  if (!Number.isInteger(groupId) || groupId <= 0) return { error: "Invalid group ID", status: 400 }
  const [group] = await db.select().from(groups).where(eq(groups.id, groupId)).limit(1)
  if (!group) return { error: "Group not found", status: 400 }
  if (group.organizationId !== organizationId) return { error: "Group does not belong to this organization", status: 403 }
  const groupBranches = await db.select({ id: branches.id }).from(branches)
    .where(and(eq(branches.organizationId, organizationId), eq(branches.groupId, groupId)))
  if (groupBranches.length === 0) return { error: `No branches found in group "${group.name}"`, status: 400 }
  return { branchIds: groupBranches.map((branch) => branch.id), groupName: group.name }
}

function planAssignmentWrites(context: any) {
  const activeKeys = new Set(context.existing.filter((assignment: any) => assignment.deletedAt === null)
    .map((assignment: any) => `${assignment.organizationInventoryId}-${assignment.branchId}`))
  const deleted = new Map(context.existing.filter((assignment: any) => assignment.deletedAt !== null)
    .map((assignment: any) => [`${assignment.organizationInventoryId}-${assignment.branchId}`, assignment]))
  const inventoryById = new Map(context.inventoryItems.map((item: any) => [item.id, item]))
  const toInsert: any[] = []
  const toRestore: any[] = []
  context.inventoryIds.forEach((inventoryId: number) => context.branchIds.forEach((branchId: number) => {
    const item: any = inventoryById.get(inventoryId)
    const key = `${inventoryId}-${branchId}`
    if (!item || activeKeys.has(key)) return
    const deletedAssignment: any = deleted.get(key)
    if (deletedAssignment) toRestore.push({ id: deletedAssignment.id, isActive: item.isActive })
    else toInsert.push({
      branchId,
      organizationId: context.organizationId,
      organizationInventoryId: inventoryId,
      assignedByUserId: context.userId,
      isVisible: context.isVisible,
      isActive: item.isActive,
    })
  }))
  return { toInsert, toRestore }
}

async function writeAssignments(tx: any, context: any) {
  const written: any[] = []
  const chunkSize = 1000
  for (const isActive of [true, false]) {
    const ids = context.toRestore.filter((item: any) => item.isActive === isActive).map((item: any) => item.id)
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      written.push(...await tx.update(branchInventory).set({
        deletedAt: null, isActive, isVisible: context.isVisible, assignedByUserId: context.userId, updatedAt: new Date(),
      }).where(inArray(branchInventory.id, ids.slice(offset, offset + chunkSize))).returning())
    }
  }
  for (let offset = 0; offset < context.toInsert.length; offset += chunkSize) {
    written.push(...await tx.insert(branchInventory).values(context.toInsert.slice(offset, offset + chunkSize)).onConflictDoNothing().returning())
  }
  if (written.length === 0) return written
  const entityId = written.length === 1 ? String(written[0].id) : `${written[0].id}-${written.at(-1).id}`
  await tx.insert(auditLogs).values({
    userId: context.userId,
    organizationId: context.organizationId,
    action: "CREATE",
    entity: "BranchAssignment",
    entityId,
    metadata: context.metadata,
  })
  return written
}

function getAssignmentCreateErrorResponse(caughtError: any) {
  if (caughtError.message?.includes("duplicate key") || caughtError.code === "23505") {
    return NextResponse.json({ error: "Some products are already assigned to these branches" }, { status: 400 })
  }
  if (caughtError.code === "23503") {
    return NextResponse.json({ error: "Invalid reference: One or more IDs do not exist in the database" }, { status: 400 })
  }
  return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
}

function validateAssignmentInventoryIds(value: any) {
  if (!Array.isArray(value) || value.length === 0) return { error: "Organization inventory IDs are required" }
  const ids = value.map(Number)
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: "Invalid organization inventory IDs" }
  return { ids: [...new Set<number>(ids)] }
}

function validateAssignmentOrganizationId(value: any) {
  if (!value) return { error: "Organization ID is required" }
  const organizationId = Number(value)
  return Number.isInteger(organizationId) && organizationId > 0 ? { organizationId } : { error: "Invalid organization ID" }
}

async function resolveDeleteAssignmentOrganizationId(context: any) {
  if (context.sessionOrganizationId) return Number(context.sessionOrganizationId)
  if (context.role === "SUPER_ADMIN" && context.queryOrganizationId) return Number(context.queryOrganizationId)
  if (!context.assignmentId) return null
  const [assignment] = await db.select({ organizationId: branchInventory.organizationId }).from(branchInventory)
    .where(eq(branchInventory.id, Number.parseInt(context.assignmentId))).limit(1)
  return assignment?.organizationId || null
}

function buildDeleteAssignmentConditions(organizationId: number, id: string | null, branchId: string | null) {
  const conditions: any[] = [eq(branchInventory.organizationId, organizationId), isNull(branchInventory.deletedAt)]
  if (id) conditions.push(eq(branchInventory.id, Number.parseInt(id)))
  if (branchId) conditions.push(eq(branchInventory.branchId, Number.parseInt(branchId)))
  return conditions
}

async function logDeletedAssignments(context: any) {
  try {
    await db.insert(auditLogs).values({
      userId: context.user.id,
      organizationId: context.organizationId,
      action: "DELETE",
      entity: "BranchAssignment",
      entityId: context.id || "bulk",
      metadata: { deletedCount: context.assignments.length, branchId: context.branchId, productId: context.productId },
    })
  } catch (caughtError) {
    console.error("Failed to insert audit log:", caughtError)
  }
  try {
    logInventoryAction("REMOVE", "BRANCH_ASSIGNMENT", {
      id: context.user.id,
      email: context.user.email || "unknown",
      role: context.user.role || context.role,
    }, {
      organizationId: context.organizationId,
      branchId: context.branchId ? Number.parseInt(context.branchId) : undefined,
      assignmentIds: context.assignments.map((assignment: any) => assignment.id),
      count: context.assignments.length,
      metadata: { productId: context.productId },
    })
  } catch (caughtError) {
    console.error("Failed to log inventory action:", caughtError)
  }
}

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

    if (view === "assignment-state") {
      const assignmentState = await loadAssignmentState(parsedOrganizationId, groupId)
      if ("error" in assignmentState) return NextResponse.json({ error: assignmentState.error }, { status: assignmentState.status })
      return NextResponse.json(assignmentState)
    }
    const conditions = buildAssignmentConditions(parsedOrganizationId, branchId, groupId)

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
    const organizationId = userRole === "SUPER_ADMIN" && bodyOrgId ? bodyOrgId : (session.user as any).organizationId
    const validatedOrganization = validateAssignmentOrganizationId(organizationId)
    if (validatedOrganization.error) return NextResponse.json({ error: validatedOrganization.error }, { status: 400 })
    const parsedOrganizationId = validatedOrganization.organizationId!

    const validatedInventory = validateAssignmentInventoryIds(requestedOrganizationInventoryIds)
    if (validatedInventory.error) return NextResponse.json({ error: validatedInventory.error }, { status: 400 })
    const organizationInventoryIds = validatedInventory.ids!

    const resolvedBranches = await resolveAssignmentBranches(parsedOrganizationId, groupId, directBranchIds)
    if (resolvedBranches.error) return NextResponse.json({ error: resolvedBranches.error }, { status: resolvedBranches.status })
    const branchIds = resolvedBranches.branchIds!
    const groupName = resolvedBranches.groupName
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

    const { toInsert, toRestore } = planAssignmentWrites({
      existing: allExistingAssignments,
      inventoryItems: orgInventoryItems,
      inventoryIds: organizationInventoryIds,
      branchIds,
      organizationId: parsedOrganizationId,
      userId: (session.user as any).id,
      isVisible: Boolean(isVisible),
    })
    if (toInsert.length === 0 && toRestore.length === 0) {
      return NextResponse.json({ message: "All selected products are already assigned to the selected branches", assignments: [] })
    }
    const skippedCount = organizationInventoryIds.length * branchIds.length - toInsert.length - toRestore.length
    const newAssignments = await db.transaction((tx) => writeAssignments(tx, {
      toInsert,
      toRestore,
      userId: (session.user as any).id,
      organizationId: parsedOrganizationId,
      isVisible: Boolean(isVisible),
      metadata: {
        assignedCount: toInsert.length + toRestore.length,
        organizationId: parsedOrganizationId,
        organizationInventoryIds,
        branchIds,
        groupId: groupId || null,
        groupName: groupName || null,
        skippedCount,
      },
    }))
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

    return getAssignmentCreateErrorResponse(error)
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

    const organizationId = await resolveDeleteAssignmentOrganizationId({
      role: userRole,
      sessionOrganizationId: (session.user as any).organizationId,
      queryOrganizationId: queryOrgId,
      assignmentId: id,
    })

    if (!organizationId) {
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 })
    }

    // Parse organizationId to number for use in queries and logging
    const orgIdNum = Number(organizationId)
    const whereConditions = buildDeleteAssignmentConditions(orgIdNum, id, branchId)
    if (!id && !branchId && !productId) {
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

    await logDeletedAssignments({
      user: session.user,
      role: userRole,
      organizationId: orgIdNum,
      id,
      branchId,
      productId,
      assignments: assignmentsToDelete,
    })

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

