import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { organizationInventory,globalProducts,categories,auditLogs } from "@/db/schema"
import { eq,and,ilike,or,desc,sql,isNull,SQL,inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { cascadeOrgStatusChange } from "@/lib/inventory-cascade"
import { getCached,invalidateByPrefix,scopedCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { canViewGlobalBasePrice } from "@/lib/pricing-access"
import { normalizeSafeImageUrl } from "@/lib/security"
import { resolveEffectivePriceCents } from "@/lib/server/effective-price"

/**
 * One organization's catalogue: what is assigned to it, and what it pays.
 *
 * Reading and writing are deliberately not the same audience. **GET** is open
 * to Head Office as well as Super Admin, because a tenant has to see its own
 * catalogue. **PUT** is Super Admin only, and has been since long before the
 * pricing rule — it writes `custom_price` among other overrides, and only a
 * Super Admin may write a price at any tier (`lib/pricing-access.ts`). The path
 * says "head-office" because of the tier it edits, not the role that may edit
 * it.
 *
 * One figure is read-only for Head Office and absent rather than merely hidden:
 * the global base price. It is the internal cost the whole catalogue is built
 * on, so `withVisiblePrices` strips it from the payload for any role that may
 * not see it — the same rule, and the same treatment, as the group pricing
 * screen. What every reader keeps is `effectivePriceCents`: what this
 * organization's branches actually pay.
 */

/** The two price tiers this screen reads. The group tier needs a group scope. */
type PricedCatalogueRow = {
  customPrice: number | null
  basePrice: number | null
}

/**
 * Apply the price-visibility rule on the way out of the cache.
 *
 * Deliberately not applied inside `getCached`: the cache holds the unredacted
 * rows, so one cached page serves both roles and no entry can ever be handed to
 * the role it was not built for. Redacting first and caching the result would
 * make the cache key the only thing standing between Head Office and the
 * internal cost.
 */
function withVisiblePrices<Row extends PricedCatalogueRow, Data extends { items: Row[] }>(
  data: Data,
  role: unknown,
) {
  const showBasePrice = canViewGlobalBasePrice(role)

  return {
    ...data,
    canViewGlobalBasePrice: showBasePrice,
    items: data.items.map((item) => ({
      ...item,
      basePrice: showBasePrice ? item.basePrice : null,
      // Resolved from the real base price, before it is stripped. This screen
      // is organization-wide, so no single group is in scope and only the two
      // upper tiers of the ladder can apply.
      effectivePriceCents: resolveEffectivePriceCents({
        organizationPriceCents: item.customPrice,
        basePriceCents: item.basePrice,
      }),
    })),
  }
}

function validateOrganizationInventoryUpdate(body: any) {
  const inventoryId = Number(body.id)
  if (!Number.isInteger(inventoryId) || inventoryId <= 0) return { error: "Inventory ID is required" }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") return { error: "isActive must be a boolean" }
  if (body.customName !== undefined && body.customName !== null && (typeof body.customName !== "string" || body.customName.length > 255)) {
    return { error: "customName must be at most 255 characters" }
  }
  if (body.customDescription !== undefined && body.customDescription !== null
    && (typeof body.customDescription !== "string" || body.customDescription.length > 10_000)) {
    return { error: "customDescription must be at most 10,000 characters" }
  }
  const customImageUrl = normalizeSafeImageUrl(body.customImageUrl)
  if (body.customImageUrl && !customImageUrl) {
    return { error: "Image URL must be a same-origin path, HTTPS URL, or supported raster data URL" }
  }
  let customPrice: number | null | undefined
  if (body.customPrice === null || body.customPrice === "") customPrice = null
  else if (body.customPrice !== undefined) {
    const parsedPrice = Number(body.customPrice)
    customPrice = Math.round(parsedPrice * 100)
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0 || !Number.isSafeInteger(customPrice)) {
      return { error: "customPrice must be a non-negative amount" }
    }
  }
  return { inventoryId, customImageUrl, customPrice }
}

function buildOrganizationInventoryUpdate(body: any, validated: any) {
  return {
    updatedAt: new Date(),
    isActive: body.isActive,
    customName: body.customName !== undefined ? body.customName || null : undefined,
    customPrice: body.customPrice !== undefined ? validated.customPrice : undefined,
    customDescription: body.customDescription !== undefined ? body.customDescription || null : undefined,
    customImageUrl: body.customImageUrl !== undefined ? validated.customImageUrl : undefined,
  }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Cascade a status change to the branches, on the caller's transaction so the
 * organization row, its branch rows and the audit entry commit together.
 * Returns whether anything changed, so the caller clears the shop's cache
 * only once the transaction has committed.
 */
async function cascadeOrganizationInventoryStatus(
  tx: Transaction,
  inventoryId: number,
  isActive: boolean,
  previousStatus: boolean,
  userId: string,
  // The role that actually performed the change, rather than the tier being
  // edited. Only a Super Admin can reach this write, so recording "HEAD_OFFICE"
  // named the wrong actor in every cascade audit entry it wrote.
  performedByRole: string,
): Promise<boolean> {
  if (isActive === previousStatus) return false
  const cascadeResult = await cascadeOrgStatusChange(inventoryId, isActive, userId, performedByRole, tx)
  await tx.insert(auditLogs).values({
    userId,
    action: "CASCADE_UPDATE",
    entity: "OrganizationInventory",
    entityId: String(inventoryId),
    metadata: {
      organizationInventoryId: inventoryId,
      isActive,
      branchUpdates: cascadeResult.updatedCount,
      affectedBranches: cascadeResult.affectedBranches,
      performedByRole,
    },
  })
  return true
}

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
        organizationId = Number.parseInt(orgIdParam)
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
        eq(organizationInventory.organizationId, Number.parseInt(organizationId)),
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
        const catId = Number.parseInt(category)
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
        conditions.push(eq(globalProducts.categoryId, Number.parseInt(subCategory)))
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
    }, CACHE_TTL.INVENTORY).then(data => NextResponse.json(withVisiblePrices(data, userRole)))
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
      organizationId = Number.parseInt(body.organizationId)
    }
    if (!organizationId) {
      return NextResponse.json({ error: "Organization not found in session" }, { status: 400 })
    }
    const { id, isActive } = body

    const validated = validateOrganizationInventoryUpdate(body)
    if (validated.error) return NextResponse.json({ error: validated.error }, { status: 400 })
    const inventoryId = validated.inventoryId!

    // Check if inventory item exists and get current status
    const [existingItem] = await db.select({
      id: organizationInventory.id,
      isActive: organizationInventory.isActive,
    })
      .from(organizationInventory)
      .where(
        and(
          eq(organizationInventory.id, inventoryId),
          eq(organizationInventory.organizationId, Number.parseInt(organizationId)),
          isNull(organizationInventory.deletedAt)
        )
      )
      .limit(1)

    if (!existingItem) {
      return NextResponse.json({ error: "Inventory item not found or access denied" }, { status: 404 })
    }

    const updateData = buildOrganizationInventoryUpdate(body, validated)

    // One transaction: the organization row, the branch cascade and the audit
    // entries commit together, so a failure part-way cannot leave a product
    // switched off at the organization and still on sale at its branches.
    const { updatedInventory, statusChanged } = await db.transaction(async (tx) => {
      const [updated] = await tx.update(organizationInventory)
        .set(updateData)
        .where(
          and(
            eq(organizationInventory.id, inventoryId),
            eq(organizationInventory.organizationId, Number.parseInt(organizationId))
          )
        )
        .returning()

      // If isActive status changed, cascade to branches
      const changed = isActive !== undefined && await cascadeOrganizationInventoryStatus(
        tx,
        inventoryId,
        isActive,
        existingItem.isActive,
        (session.user as any).id,
        userRole,
      )

      // Log the update
      await tx.insert(auditLogs).values({
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

      return { updatedInventory: updated, statusChanged: changed }
    })

    // Invalidate organization inventory cache for any update, and the shop's
    // listing when the product was switched on or off.
    await invalidateByPrefix('org-inv')
    if (statusChanged) await invalidateByPrefix('branch-inv')

    return NextResponse.json({
      message: "Inventory updated successfully",
      inventory: updatedInventory
    })
  } catch (error: any) {
    console.error("Error updating organization inventory:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

