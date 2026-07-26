import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationInventory, globalProducts, categories, auditLogs } from "@/db/schema"
import { eq, and, like, ilike, or, desc, sql, isNull, SQL, ne, inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { cascadeOrgStatusChange } from "@/lib/inventory-cascade"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { normalizeSafeImageUrl } from "@/lib/security"

// GET /api/v1/head-office/organization-inventory - List products in organization inventory
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

    // Get organization ID from session context (should be set by middleware)
    // For Super Admin, get from query params if available
    let organizationId = (session.user as any).organizationId
    if (userRole === "SUPER_ADMIN") {
      const { searchParams } = new URL(req.url)
      const orgIdParam = searchParams.get("organizationId")
      if (orgIdParam) {
        organizationId = parseInt(orgIdParam)
      }
    }
    if (!organizationId) {
      return NextResponse.json({ error: "Organization not found in session" }, { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const search = searchParams.get("search") || ""
    const category = searchParams.get("category") || ""
    const subCategory = searchParams.get("subCategory") || ""
    const status = searchParams.get("status") || ""
    const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get("limit"))) || 50, 1), 1_000)
    const offset = (page - 1) * limit

    const cacheKey = scopedCacheKey('org-inv', { orgId: organizationId }, {
      search, category, subCategory, status, page, limit
    })

    return getCached(cacheKey, async () => {
      const conditions: (SQL | undefined)[] = [
        eq(organizationInventory.organizationId, parseInt(organizationId)),
        isNull(organizationInventory.deletedAt),
        isNull(globalProducts.deletedAt),
        eq(globalProducts.status, "active"),
      ]

      // Filter by organization product status (active/inactive/all)
      if (status === "inactive") {
        conditions.push(eq(organizationInventory.isActive, false))
      } else if (status !== "all") {
        // Default to active-only when no filter or "active" is selected
        conditions.push(eq(organizationInventory.isActive, true))
      }

      if (search) {
        conditions.push(
          or(
            ilike(globalProducts.name, `%${search}%`),
            ilike(globalProducts.productCode, `%${search}%`),
            ilike(organizationInventory.customName, `%${search}%`)
          )
        )
      }
      if (category && category !== 'all') {
        const catId = parseInt(category)
        const subCatsList = await db.select({ id: categories.id })
          .from(categories)
          .where(eq(categories.parentId, catId))

        const subCatIds = subCatsList.map(sc => sc.id)
        if (subCatIds.length > 0) {
          conditions.push(inArray(globalProducts.categoryId, subCatIds))
        } else {
          conditions.push(eq(globalProducts.categoryId, -1))
        }
      }
      if (subCategory && subCategory !== 'all') {
        conditions.push(eq(globalProducts.categoryId, parseInt(subCategory)))
      }

      const whereClause = and(...conditions)

      const subCats = alias(categories, "subCategories")
      const parentCats = alias(categories, "parentCategories")

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
          updatedAt: organizationInventory.updatedAt,
          // Global product details
          productName: globalProducts.name,
          productCode: globalProducts.productCode,
          productImageUrl: globalProducts.imageUrl,
          basePrice: globalProducts.basePrice,
          unit: globalProducts.unit,
          status: globalProducts.status,
          categoryName: subCats.name,
          parentCategoryName: parentCats.name,
          discountType: globalProducts.discountType,
          discountValue: globalProducts.discountValue,
          discountStartAt: globalProducts.discountStartAt,
          discountEndAt: globalProducts.discountEndAt,
          discountActive: globalProducts.discountActive,
        })
          .from(organizationInventory)
          .leftJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
          .leftJoin(subCats, eq(globalProducts.categoryId, subCats.id))
          .leftJoin(parentCats, eq(subCats.parentId, parentCats.id))
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
      return { items, total, page, limit }
    }, CACHE_TTL.INVENTORY).then(data => NextResponse.json(data))
  } catch (error) {
    console.error("Error fetching organization inventory:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/head-office/organization-inventory - Update organization-level overrides
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

    // Get organization ID from session context (should be set by middleware)
    // For Super Admin, get from request body if available
    let organizationId = (session.user as any).organizationId
    if (body.organizationId) {
      organizationId = parseInt(body.organizationId)
    }
    if (!organizationId) {
      return NextResponse.json({ error: "Organization not found in session" }, { status: 400 })
    }
    const {
      id,
      isActive,
      customName,
      customPrice,
      customDescription,
      customImageUrl
    } = body

    const inventoryId = Number(id)
    if (!Number.isInteger(inventoryId) || inventoryId <= 0) {
      return NextResponse.json({ error: "Inventory ID is required" }, { status: 400 })
    }
    if (isActive !== undefined && typeof isActive !== "boolean") {
      return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 })
    }
    if (customName !== undefined && customName !== null && (typeof customName !== "string" || customName.length > 255)) {
      return NextResponse.json({ error: "customName must be at most 255 characters" }, { status: 400 })
    }
    if (
      customDescription !== undefined &&
      customDescription !== null &&
      (typeof customDescription !== "string" || customDescription.length > 10_000)
    ) {
      return NextResponse.json({ error: "customDescription must be at most 10,000 characters" }, { status: 400 })
    }

    const normalizedCustomImageUrl = normalizeSafeImageUrl(customImageUrl)
    if (customImageUrl && !normalizedCustomImageUrl) {
      return NextResponse.json({
        error: "Image URL must be a same-origin path, HTTPS URL, or supported raster data URL",
      }, { status: 400 })
    }

    let customPriceCents: number | null | undefined
    if (customPrice !== undefined) {
      if (customPrice === null || customPrice === "") {
        customPriceCents = null
      } else {
        const parsedPrice = Number(customPrice)
        customPriceCents = Math.round(parsedPrice * 100)
        if (!Number.isFinite(parsedPrice) || parsedPrice < 0 || !Number.isSafeInteger(customPriceCents)) {
          return NextResponse.json({ error: "customPrice must be a non-negative amount" }, { status: 400 })
        }
      }
    }

    // Check if inventory item exists and get current status
    const [existingItem] = await db.select({
      id: organizationInventory.id,
      isActive: organizationInventory.isActive,
    })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.id, inventoryId),
          eq(organizationInventory.organizationId, parseInt(organizationId)),
          isNull(organizationInventory.deletedAt)
        )
      )
      .limit(1)

    if (!existingItem) {
      return NextResponse.json({ error: "Inventory item not found or access denied" }, { status: 404 })
    }

    const updateData: any = {
      updatedAt: new Date()
    }

    if (isActive !== undefined) updateData.isActive = isActive
    if (customName !== undefined) updateData.customName = customName || null
    if (customPrice !== undefined) updateData.customPrice = customPriceCents
    if (customDescription !== undefined) updateData.customDescription = customDescription || null
    if (customImageUrl !== undefined) updateData.customImageUrl = normalizedCustomImageUrl

    const [updatedInventory] = await db.update(organizationInventory)
      .set(updateData)
      .where(
        and(
          eq(organizationInventory.id, inventoryId),
          eq(organizationInventory.organizationId, parseInt(organizationId))
        )
      )
      .returning()

    // If isActive status changed, cascade to branches
    if (isActive !== undefined && isActive !== existingItem.isActive) {
      const cascadeResult = await cascadeOrgStatusChange(
        inventoryId,
        isActive,
        (session.user as any).id,
        "HEAD_OFFICE"
      )

      // Log the cascade update
      await db.insert(auditLogs).values({
        userId: (session.user as any).id,
        action: "CASCADE_UPDATE",
        entity: "OrganizationInventory",
        entityId: id.toString(),
        metadata: {
          organizationInventoryId: parseInt(id),
          isActive,
          branchUpdates: cascadeResult.updatedCount,
          affectedBranches: cascadeResult.affectedBranches,
          performedByRole: "HEAD_OFFICE"
        },
      })

      // Invalidate both organization and branch inventory caches
      await invalidateByPrefix('org-inv')
      await invalidateByPrefix('branch-inv')
    }

    // Log the update
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "UPDATE",
      entity: "OrganizationInventory",
      entityId: id.toString(),
      metadata: {
        organizationId,
        updateData,
        level: "head_office"
      },
    })

    // Invalidate organization inventory cache for any update
    await invalidateByPrefix('org-inv')

    return NextResponse.json({
      message: "Inventory updated successfully",
      inventory: updatedInventory
    })
  } catch (error: any) {
    console.error("Error updating organization inventory:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

