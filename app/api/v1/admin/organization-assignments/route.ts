import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationInventory, globalProducts, organizations, auditLogs, categories } from "@/db/schema"
import { eq, and, desc, sql, inArray, isNull, or, ilike, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { cascadeOrgDeletion, cascadeOrgStatusChange } from "@/lib/inventory-cascade"
import { validateAssignmentData } from "@/lib/inventory-validation"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { normalizeSafeImageUrl } from "@/lib/security"
import { groupPricePropagationSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  applyGroupPricePropagation,
  buildPropagationPlan,
  loadPropagationContext,
} from "@/lib/server/group-price-propagation"

async function addCategoryCondition(conditions: SQL[], category: string | null) {
  if (!category || category === "all") return
  const categoryId = Number.parseInt(category)
  const [categoryInfo] = await db.select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)
  if (!categoryInfo) return
  if (categoryInfo.parentId !== null) {
    conditions.push(eq(globalProducts.categoryId, categoryId))
    return
  }

  const subcategories = await db.select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId))
  const subcategoryIds = subcategories.map((subcategory) => subcategory.id)
  conditions.push(
    subcategoryIds.length > 0
      ? inArray(globalProducts.categoryId, subcategoryIds)
      : eq(globalProducts.categoryId, -1),
  )
}

function normalizeAssignmentOverrides(overrides: unknown) {
  if (!Array.isArray(overrides)) return []
  return overrides.map((entry: any) => {
    const safeImageUrl = normalizeSafeImageUrl(entry?.customImageUrl)
    if (entry?.customImageUrl && !safeImageUrl) throw new Error("INVALID_ASSIGNMENT_IMAGE_URL")
    return { ...entry, customImageUrl: safeImageUrl }
  })
}

function normalizeAssignmentProductIds(overrides: any[], productIds: unknown) {
  const source = overrides.length > 0 ? overrides.map((entry) => entry.productId) : productIds
  if (!Array.isArray(source)) return []
  return source.map((id) => Number.parseInt(id)).filter((id) => Number.isFinite(id))
}

const resolveCustomPrice = (override: any, fallback: unknown) => {
  if (override?.customPrice !== undefined && override.customPrice !== null) {
    return Math.round(Number.parseFloat(override.customPrice) * 100)
  }
  if (!fallback || (typeof fallback !== "string" && typeof fallback !== "number")) return null
  return Math.round(Number.parseFloat(String(fallback)) * 100)
}

type AssignmentDefaults = {
  isActive: boolean
  customName: unknown
  customPrice: unknown
  customDescription: unknown
  customImageUrl: string | null
}

function buildOrganizationAssignments(
  productIds: number[],
  overrides: any[],
  organizationId: number,
  userId: string,
  defaults: AssignmentDefaults,
) {
  return productIds.map((productId) => {
    const override = overrides.find((entry) => Number.parseInt(entry.productId) === productId)
    return {
      globalProductId: productId,
      organizationId,
      assignedByUserId: userId,
      isActive: override?.isActive ?? defaults.isActive,
      customName: override?.customName ?? defaults.customName ?? null,
      customPrice: resolveCustomPrice(override, defaults.customPrice),
      customDescription: override?.customDescription ?? defaults.customDescription ?? null,
      customImageUrl: override?.customImageUrl ?? defaults.customImageUrl,
    }
  })
}

/**
 * The organization price this update is moving the item to, in cents.
 *
 * `undefined` means the request is not touching the price at all, which is what
 * distinguishes "renamed the product" from "repriced it" — only the latter has
 * anything to propagate to groups.
 */
function nextOrganizationPriceCents(body: any): number | null | undefined {
  if (body.customPrice === undefined) return undefined
  return body.customPrice ? Math.round(Number.parseFloat(body.customPrice) * 100) : null
}

type PropagationRequest = {
  mode: "none" | "all" | "selected"
  groupIds?: number[]
}

/**
 * The pre-change state the plan is computed against, or null when there is
 * nothing to propagate.
 *
 * **Read before the organization price is written.** The plan needs the price
 * the groups are on *now* — that is what an unselected group gets pinned at —
 * so reading it after the update would pin every group at the new price and
 * quietly do the opposite of what was asked.
 */
async function loadPropagationContextIfNeeded(
  tx: any,
  input: {
    organizationInventoryId: number
    propagation: PropagationRequest
    nextPriceCents: number | null | undefined
  },
) {
  // Nothing to do when the caller did not ask, or when the request is not
  // touching the price at all (a rename has nothing to propagate).
  if (input.propagation.mode === "none" || input.nextPriceCents === undefined) return null
  return loadPropagationContext(tx, input.organizationInventoryId)
}

/**
 * Apply the caller's choice about group prices alongside the organization price.
 *
 * The plan is always rebuilt here from rows this transaction read; the request
 * contributes only the mode and the chosen group ids, never a plan.
 */
async function applyPropagation(
  tx: any,
  input: {
    context: Awaited<ReturnType<typeof loadPropagationContext>>
    propagation: PropagationRequest
    nextPriceCents: number | null | undefined
    userId: string
  },
) {
  if (!input.context || input.nextPriceCents === undefined) return null

  const plan = buildPropagationPlan(input.context, {
    mode: input.propagation.mode,
    selectedGroupIds: input.propagation.groupIds,
    nextOrganizationPriceCents: input.nextPriceCents,
  })

  return applyGroupPricePropagation(tx, {
    context: input.context,
    plan,
    performedByUserId: input.userId,
    performedByRole: "SUPER_ADMIN",
  })
}

function buildAssignmentUpdateData(body: any, normalizedCustomImageUrl: string | null) {
  const updateData: any = { updatedAt: new Date() }
  if (body.isActive !== undefined) updateData.isActive = body.isActive
  if (body.customName !== undefined) updateData.customName = body.customName
  if (body.customPrice !== undefined) {
    updateData.customPrice = body.customPrice ? Math.round(Number.parseFloat(body.customPrice) * 100) : null
  }
  if (body.customDescription !== undefined) updateData.customDescription = body.customDescription
  if (body.customImageUrl !== undefined) updateData.customImageUrl = normalizedCustomImageUrl
  return updateData
}

// GET /api/v1/admin/organization-assignments - List organization assignments
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const organizationId = searchParams.get("organizationId")
    const productId = searchParams.get("productId")
    const search = searchParams.get("search")
    const category = searchParams.get("category")
    const subCategory = searchParams.get("subCategory")
    // Same bounds as /admin/global-inventory, which the assignment page reads
    // alongside this list: a malformed value falls back to the default rather
    // than reaching the query as NaN, and the ceiling keeps the list bounded.
    const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get("limit"))) || 50, 1), 500)
    const offset = (page - 1) * limit

    const conditions: SQL[] = [
      isNull(organizationInventory.deletedAt),
      isNull(globalProducts.deletedAt)
    ]
    if (organizationId) {
      conditions.push(eq(organizationInventory.organizationId, Number.parseInt(organizationId)))
    }
    if (productId) {
      conditions.push(eq(organizationInventory.globalProductId, Number.parseInt(productId)))
    }
    if (search) {
      conditions.push(or(
        ilike(globalProducts.name, `%${search}%`),
        ilike(globalProducts.productCode, `%${search}%`)
      ) as SQL)
    }
    await addCategoryCondition(conditions, category)
    if (subCategory && subCategory !== 'all') {
      conditions.push(eq(globalProducts.categoryId, Number.parseInt(subCategory)))
    }

    const whereClause = and(...conditions)

    const subCategories = alias(categories, "subCategories")
    const parentCategories = alias(categories, "parentCategories")

    const [items, totalResult] = await Promise.all([
      db.select({
        id: organizationInventory.id,
        organizationId: organizationInventory.organizationId,
        globalProductId: organizationInventory.globalProductId,
        isActive: organizationInventory.isActive,
        customName: organizationInventory.customName,
        customPrice: organizationInventory.customPrice,
        customDescription: organizationInventory.customDescription,
        customImageUrl: organizationInventory.customImageUrl,
        assignedAt: organizationInventory.assignedAt,
        productName: globalProducts.name,
        productCode: globalProducts.productCode,
        categoryName: subCategories.name,
        parentCategoryName: parentCategories.name,
        productImageUrl: globalProducts.imageUrl,
        globalStatus: globalProducts.status,
        organizationName: organizations.name,
      })
        .from(organizationInventory)
        .leftJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .leftJoin(subCategories, eq(globalProducts.categoryId, subCategories.id))
        .leftJoin(parentCategories, eq(subCategories.parentId, parentCategories.id))
        .leftJoin(organizations, eq(organizationInventory.organizationId, organizations.id))
        .where(whereClause)
        .orderBy(desc(organizationInventory.assignedAt))
        .limit(limit)
        .offset(offset),

      db.select({ count: sql<number>`count(*)` })
        .from(organizationInventory)
        .leftJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .where(whereClause),
    ])

    const total = totalResult[0].count

    return NextResponse.json({ items, total, page, limit })
  } catch (error) {
    console.error("Error fetching organization assignments:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// POST /api/v1/admin/organization-assignments - Assign products to organization
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    console.log("POST /api/v1/admin/organization-assignments - Request body:", body)

    const {
      productIds,
      assignments: assignmentOverrides,
      organizationId,
      isActive = true,
      customName,
      customPrice,
      customDescription,
      customImageUrl,
    } = body

    const normalizedCustomImageUrl = normalizeSafeImageUrl(customImageUrl)
    if (customImageUrl && !normalizedCustomImageUrl) {
      return NextResponse.json({ error: "Invalid custom image URL" }, { status: 400 })
    }

    const normalizedAssignmentOverrides = normalizeAssignmentOverrides(assignmentOverrides)
    const normalizedProductIds = normalizeAssignmentProductIds(normalizedAssignmentOverrides, productIds)

    if (normalizedProductIds.length === 0) {
      console.log("Validation error: Product identifiers are required")
      return NextResponse.json({ error: "Product IDs or detailed assignments are required" }, { status: 400 })
    }
    if (!organizationId) {
      console.log("Validation error: Organization ID is required")
      return NextResponse.json({ error: "Organization ID is required" }, { status: 400 })
    }

    // Validate assignment data
    console.log("Validating assignment data for organizationId:", Number.parseInt(organizationId), "productIds:", productIds)
    const validation = await validateAssignmentData({
      organizationId: Number.parseInt(organizationId),
      globalProductId: normalizedProductIds[0], // representative
      userId: (session.user as any).id
    })

    console.log("Validation result:", validation)

    if (!validation.valid) {
      console.log("Validation failed:", validation.errors)
      return NextResponse.json({
        error: validation.errors[0] || "Validation failed",
        details: validation.errors
      }, { status: 400 })
    }

    // Check for existing assignments to avoid duplicates
    const existingAssignments = await db.select({
      globalProductId: organizationInventory.globalProductId,
    })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.organizationId, Number.parseInt(organizationId)),
          inArray(organizationInventory.globalProductId, normalizedProductIds),
          isNull(organizationInventory.deletedAt)
        )
      )

    // Create a set of existing product IDs for quick lookup
    const existingProductIds = new Set(existingAssignments.map(a => a.globalProductId))
    const unassignedProductIds = normalizedProductIds.filter((id) => !existingProductIds.has(id))

    // If all products are already assigned, return a helpful message
    if (unassignedProductIds.length === 0) {
      return NextResponse.json({
        error: "All selected products are already assigned to this organization",
        alreadyAssigned: normalizedProductIds,
        unassigned: []
      }, { status: 400 })
    }

    const alreadyAssignedIds = normalizedProductIds.filter((id) => existingProductIds.has(id))
    const assignments = buildOrganizationAssignments(
      unassignedProductIds,
      normalizedAssignmentOverrides,
      Number.parseInt(organizationId),
      (session.user as any).id,
      { isActive, customName, customPrice, customDescription, customImageUrl: normalizedCustomImageUrl },
    )
    const newAssignments = await db.insert(organizationInventory).values(assignments).returning()

    if (alreadyAssignedIds.length > 0) {
      return NextResponse.json({
        message: `Successfully assigned ${assignments.length} products. ${alreadyAssignedIds.length} products were already assigned.`,
        assignments: newAssignments,
        alreadyAssigned: alreadyAssignedIds,
        unassigned: unassignedProductIds
      }, { status: 200 })
    }

    // Log the assignment creation
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "CREATE",
      entity: "OrganizationAssignment",
      entityId: newAssignments.map(a => a.id).join(','),
      metadata: {
        assignedCount: newAssignments.length,
        organizationId,
        productIds: normalizedProductIds,
        skippedCount: normalizedProductIds.length - newAssignments.length
      },
    })

    // Invalidate organization inventory cache
    await invalidateByPrefix('org-inv')

    return NextResponse.json({
      message: `${newAssignments.length} products assigned successfully!`,
      assignments: newAssignments,
      skipped: normalizedProductIds.length - newAssignments.length
    })
  } catch (error: any) {
    console.error("Error creating organization assignments:", error)

    if (error?.message === "INVALID_ASSIGNMENT_IMAGE_URL") {
      return NextResponse.json({ error: "Invalid custom image URL" }, { status: 400 })
    }

    // Handle duplicate-assignment case more gracefully
    if (error?.code === "23505") {
      return NextResponse.json(
        { error: "One or more of these products are already assigned to this organization." },
        { status: 400 }
      )
    }

    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// DELETE /api/v1/admin/organization-assignments - Remove product from organization
export async function DELETE(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const id = searchParams.get("id")
    const organizationId = searchParams.get("organizationId")
    const productId = searchParams.get("productId")

    // Support bulk deletion via JSON body: { assignmentIds: number[] }
    let assignmentIdsFromBody: number[] = []
    try {
      const body = await req.json().catch(() => null)
      if (body && Array.isArray(body.assignmentIds)) {
        assignmentIdsFromBody = body.assignmentIds
          .map((v: any) => Number.parseInt(v))
          .filter((v: number) => Number.isFinite(v))
      }
    } catch {
      // Ignore body parse errors – we'll fall back to query-based deletion
    }

    const whereConditions = []
    if (id) {
      whereConditions.push(eq(organizationInventory.id, Number.parseInt(id)))
    }
    if (organizationId) {
      whereConditions.push(eq(organizationInventory.organizationId, Number.parseInt(organizationId)))
    }
    if (productId) {
      whereConditions.push(eq(organizationInventory.globalProductId, Number.parseInt(productId)))
    }
    if (assignmentIdsFromBody.length > 0) {
      whereConditions.push(inArray(organizationInventory.id, assignmentIdsFromBody))
    }

    if (whereConditions.length === 0) {
      return NextResponse.json(
        { error: "Assignment ID, Organization ID, Product ID, or assignmentIds are required" },
        { status: 400 }
      )
    }

    // Find assignments to be deleted
    const assignmentsToDelete = await db
      .select({
        id: organizationInventory.id,
        organizationId: organizationInventory.organizationId,
        globalProductId: organizationInventory.globalProductId,
      })
      .from(organizationInventory)
      .where(and(...whereConditions))

    if (!assignmentsToDelete || assignmentsToDelete.length === 0) {
      return NextResponse.json({ error: "No assignments found" }, { status: 404 })
    }

    // Hard delete each assignment and cascade to branches
    let totalBranchDeletions = 0
    const affectedBranches: number[] = []

    for (const assignment of assignmentsToDelete) {
      // Cascade to branches first
      const cascadeResult = await cascadeOrgDeletion(
        assignment.id,
        (session.user as any).id,
        "SUPER_ADMIN"
      )
      totalBranchDeletions += cascadeResult.deletedCount
      affectedBranches.push(...cascadeResult.affectedBranches)

      // Then hard delete the organization assignment
      await db
        .delete(organizationInventory)
        .where(eq(organizationInventory.id, assignment.id))
    }

    // Log the assignment deletion
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "DELETE",
      entity: "OrganizationAssignment",
      entityId: id || "bulk",
      metadata: {
        deletedCount: assignmentsToDelete.length,
        branchDeletions: totalBranchDeletions,
        affectedBranches: [...new Set(affectedBranches)],
        organizationId,
        productId
      },
    })

    // Invalidate both organization and branch inventory caches
    await invalidateByPrefix('org-inv')
    await invalidateByPrefix('branch-inv')

    return NextResponse.json({
      message: "Assignments removed successfully",
      count: assignmentsToDelete.length,
      branchDeletions: totalBranchDeletions
    })
  } catch (error: any) {
    console.error("Error deleting organization assignments:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/admin/organization-assignments - Update organization assignment
export async function PUT(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const body = await req.json()
    const {
      id,
      isActive,
      customImageUrl
    } = body

    const normalizedCustomImageUrl = normalizeSafeImageUrl(customImageUrl)
    if (customImageUrl && !normalizedCustomImageUrl) {
      return NextResponse.json({ error: "Invalid custom image URL" }, { status: 400 })
    }

    if (!id) {
      return NextResponse.json({ error: "Assignment ID is required" }, { status: 400 })
    }

    // Check if assignment exists
    const [existingAssignment] = await db.select({
      id: organizationInventory.id,
      isActive: organizationInventory.isActive,
    })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.id, Number.parseInt(id)),
          isNull(organizationInventory.deletedAt)
        )
      )

    if (!existingAssignment) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 })
    }

    const updateData = buildAssignmentUpdateData(body, normalizedCustomImageUrl)

    // What should happen to group prices. Absent means `none`: groups keep
    // their own prices and unpriced ones follow the organization, which is what
    // this endpoint did before propagation existed.
    const parsedPropagation = body.groupPricePropagation === undefined
      ? { success: true as const, data: { mode: "none" as const, groupIds: undefined } }
      : groupPricePropagationSchema.safeParse(body.groupPricePropagation)
    if (!parsedPropagation.success) {
      return NextResponse.json({ error: validationMessage(parsedPropagation.error) }, { status: 400 })
    }

    // One transaction: an organization price without its propagation, or a
    // propagation without the price it was planned against, would each leave a
    // branch on a price nobody chose.
    const nextPriceCents = nextOrganizationPriceCents(body)
    const { updatedAssignment, propagation } = await db.transaction(async (tx) => {
      // Read the state the groups are on now, before the price moves under it.
      const propagationContext = await loadPropagationContextIfNeeded(tx, {
        organizationInventoryId: Number.parseInt(id),
        propagation: parsedPropagation.data,
        nextPriceCents,
      })

      const [assignment] = await tx.update(organizationInventory)
        .set(updateData)
        .where(eq(organizationInventory.id, Number.parseInt(id)))
        .returning()

      const outcome = await applyPropagation(tx, {
        context: propagationContext,
        propagation: parsedPropagation.data,
        nextPriceCents,
        userId: (session.user as any).id,
      })

      return { updatedAssignment: assignment, propagation: outcome }
    })

    // If isActive status changed, cascade to branches
    if (isActive !== undefined && isActive !== existingAssignment.isActive) {
      const cascadeResult = await cascadeOrgStatusChange(
        Number.parseInt(id),
        isActive,
        (session.user as any).id,
        "SUPER_ADMIN"
      )

      // Log the cascade update
      await db.insert(auditLogs).values({
        userId: (session.user as any).id,
        action: "CASCADE_UPDATE",
        entity: "OrganizationAssignment",
        entityId: id.toString(),
        metadata: {
          organizationInventoryId: Number.parseInt(id),
          isActive,
          branchUpdates: cascadeResult.updatedCount,
          affectedBranches: cascadeResult.affectedBranches,
          performedByRole: "SUPER_ADMIN"
        },
      })
    }

    // Log the assignment update
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "UPDATE",
      entity: "OrganizationAssignment",
      entityId: id.toString(),
      metadata: {
        updateData,
        performedByRole: "SUPER_ADMIN"
      },
    })

    // Invalidate caches
    await invalidateByPrefix('org-inv')
    if (isActive !== undefined) {
      await invalidateByPrefix('branch-inv')
    }
    if (nextPriceCents !== undefined) {
      // A price change reaches the shop and every branch inventory listing
      // through these; leaving them cached would show one price and charge
      // another.
      await invalidateByPrefix('branch-inv')
      await invalidateByPrefix('group')
    }

    return NextResponse.json({
      message: propagation && propagation.changedGroupCount > 0
        ? `Assignment updated. ${propagation.changedGroupCount} group price(s) changed.`
        : "Assignment updated successfully",
      assignment: updatedAssignment,
      // Absent for every caller that did not ask for propagation.
      ...(propagation ? { groupPricePropagation: propagation } : {}),
    })
  } catch (error: any) {
    console.error("Error updating organization assignment:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

