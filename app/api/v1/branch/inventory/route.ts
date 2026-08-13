import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branchInventory,globalProducts,organizationInventory,categories,auditLogs,productQuantityBudgets } from "@/db/schema"
import { eq,and,ilike,or,desc,sql,isNull,SQL,inArray } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { escapeLikePattern } from "@/lib/utils"
import { coalesceInFlight,getCached,invalidateByPrefix,scopedCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"

function parseOptionalId(value: unknown) {
  if (!value) return null
  return typeof value === "string" ? Number.parseInt(value) : Number(value)
}

function resolveInventoryContext(
  userRole: string,
  sessionOrganizationId: unknown,
  sessionBranchId: unknown,
  searchParams: URLSearchParams,
): { organizationId?: number; branchId?: number; error?: string; status?: number } {
  let organizationId = parseOptionalId(sessionOrganizationId)
  let branchId = parseOptionalId(sessionBranchId)
  if (["BRANCH_ADMIN", "EMPLOYEE", "ORDER_PORTAL"].includes(userRole)) {
    if (!organizationId || !branchId) {
      return { error: "Organization or branch not found in session", status: 400 }
    }
    return { organizationId, branchId }
  }
  if (!["HEAD_OFFICE", "SUPER_ADMIN"].includes(userRole)) {
    return { error: "Forbidden - Access denied", status: 403 }
  }
  const branchIdParam = searchParams.get("branchId")
  const organizationIdParam = searchParams.get("organizationId")
  if (!branchIdParam) return { error: "branchId parameter required for admin users", status: 400 }
  branchId = Number.parseInt(branchIdParam)
  if (!Number.isFinite(branchId)) return { error: "Invalid branch ID", status: 400 }
  if (organizationIdParam) organizationId = Number.parseInt(organizationIdParam)
  if (!organizationId) return { error: "Organization context not found", status: 400 }
  if (!Number.isFinite(organizationId)) return { error: "Invalid organization ID", status: 400 }
  return { organizationId, branchId }
}

async function buildInventoryConditions({
  organizationId,
  branchId,
  quantityBudgetCatalogActive,
  currentPeriod,
  search,
  category,
  subCategory,
}: {
  organizationId: number
  branchId: number
  quantityBudgetCatalogActive: boolean
  currentPeriod: string
  search: string
  category: string
  subCategory: string
}) {
  const conditions: (SQL | undefined)[] = [
    eq(branchInventory.branchId, branchId),
    eq(branchInventory.organizationId, organizationId),
    eq(branchInventory.isActive, true),
    eq(branchInventory.isVisible, true),
    isNull(branchInventory.deletedAt),
    eq(globalProducts.status, "active"),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    isNull(globalProducts.deletedAt),
  ]
  if (quantityBudgetCatalogActive) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${productQuantityBudgets}
      WHERE ${productQuantityBudgets.organizationId} = ${organizationId}
        AND ${productQuantityBudgets.branchId} = ${branchId}
        AND ${productQuantityBudgets.period} = ${currentPeriod}
        AND ${productQuantityBudgets.organizationInventoryId} = ${branchInventory.organizationInventoryId}
        AND (${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0
    )`)
  }
  if (search) {
    conditions.push(or(
      ilike(globalProducts.name, `%${search}%`),
      ilike(globalProducts.productCode, `%${search}%`),
      ilike(organizationInventory.customName, `%${search}%`),
    ))
  }
  if (category && category !== "all") {
    const categoryId = Number.parseInt(category)
    const subcategories = await db.select({ id: categories.id })
      .from(categories)
      .where(eq(categories.parentId, categoryId))
    const ids = subcategories.map((subcategory) => subcategory.id)
    conditions.push(ids.length > 0 ? inArray(globalProducts.categoryId, ids) : eq(globalProducts.categoryId, -1))
  }
  if (subCategory && subCategory !== "all") {
    conditions.push(eq(globalProducts.categoryId, Number.parseInt(subCategory)))
  }
  return conditions
}

// GET /api/v1/branch/inventory - List products in branch inventory
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if ((session.user as any).mustChangePassword === true) {
      return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    }

    const userRole = (session.user as any).role
    const { searchParams } = new URL(req.url)
    const context = resolveInventoryContext(
      userRole,
      (session.user as any).organizationId,
      (session.user as any).branchId,
      searchParams,
    )
    if (context.error) return NextResponse.json({ error: context.error }, { status: context.status })
    const organizationId = context.organizationId!
    const branchId = context.branchId!

    const searchRaw = searchParams.get("search") || ""
    const search = searchRaw ? escapeLikePattern(searchRaw) : "" // Sanitize LIKE patterns
    const visibility = searchParams.get("visibility") || ""
    const category = searchParams.get("category") || ""
    const subCategory = searchParams.get("subCategory") || ""
    const includeQuantityBudget = searchParams.get("includeQuantityBudget") === "true"
    const pageNum = Math.max(1, Number.parseInt(searchParams.get("page") || "1") || 1)
    const limitNum = Math.max(1, Number.parseInt(searchParams.get("limit") || "50") || 50)
    const offset = (pageNum - 1) * limitNum

    const orgIdNum = Number(organizationId)

    if (Number.isNaN(orgIdNum)) {
      return NextResponse.json({ error: "Invalid organization ID" }, { status: 400 })
    }

    const pricesHidden = await shouldHidePricesForRole(userRole, orgIdNum)
    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(orgIdNum)
    const shouldApplyQuantityBudget = includeQuantityBudget && budgetAllocationMode === "quantity"
    const currentPeriod = new Date().toISOString().slice(0, 7)
    const positiveQuantityBudgetTotal = sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`
    const quantityBudgetCatalogState = shouldApplyQuantityBudget
      ? await coalesceInFlight(
        scopedCacheKey('inflight:branch-inv:quantity-budget-catalog', {
          orgId: orgIdNum,
          branchId,
        }, { period: currentPeriod }),
        async () => {
          const [row] = await db
            .select({ id: productQuantityBudgets.id })
            .from(productQuantityBudgets)
            .where(and(
              eq(productQuantityBudgets.organizationId, orgIdNum),
              eq(productQuantityBudgets.branchId, branchId),
              eq(productQuantityBudgets.period, currentPeriod),
              positiveQuantityBudgetTotal,
            ))
            .limit(1)

          return { active: Boolean(row) }
        },
      )
      : { active: false }
    const quantityBudgetCatalogActive = quantityBudgetCatalogState.active

    const conditions = await buildInventoryConditions({
      organizationId: orgIdNum,
      branchId,
      quantityBudgetCatalogActive,
      currentPeriod,
      search,
      category,
      subCategory,
    })
    const whereClause = and(...conditions)

    const cacheKey = scopedCacheKey('branch-inv', { branchId, orgId: orgIdNum, role: userRole }, {
      search,
      visibility,
      category,
      subCategory,
      page: pageNum,
      limit: limitNum,
      pricesHidden,
      quantityBudgetCatalogActive,
    })

    const subCats = alias(categories, "subCategories")
    const parentCats = alias(categories, "parentCategories")

    const result = await getCached(cacheKey, async () => {
      const [items, totalResult] = await Promise.all([
        db.select({
          id: branchInventory.id,
          branchId: branchInventory.branchId,
          organizationId: branchInventory.organizationId,
          organizationInventoryId: branchInventory.organizationInventoryId,
          isVisible: branchInventory.isVisible,
          isActive: branchInventory.isActive,
          stockQuantity: globalProducts.stockQuantity,
          allowDecimalQuantity: globalProducts.allowDecimalQuantity,
          quantityStep: globalProducts.quantityStep,
          reorderThreshold: sql<number>`10`,
          assignedAt: branchInventory.assignedAt,
          updatedAt: branchInventory.updatedAt,
          productName: globalProducts.name,
          productCode: globalProducts.productCode,
          productImageUrl: globalProducts.imageUrl,
          basePrice: globalProducts.basePrice,
          unit: globalProducts.unit,
          status: globalProducts.status,
          productDescription: globalProducts.description,
          categoryName: subCats.name,
          parentCategoryName: parentCats.name,
          customName: organizationInventory.customName,
          customPrice: organizationInventory.customPrice,
          customDescription: organizationInventory.customDescription,
          customImageUrl: organizationInventory.customImageUrl,
          discountType: globalProducts.discountType,
          discountValue: globalProducts.discountValue,
          discountStartAt: globalProducts.discountStartAt,
          discountEndAt: globalProducts.discountEndAt,
          discountActive: globalProducts.discountActive,
        })
          .from(branchInventory)
          .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
          .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
          .leftJoin(subCats, eq(globalProducts.categoryId, subCats.id))
          .leftJoin(parentCats, eq(subCats.parentId, parentCats.id))
          .where(whereClause)
          .orderBy(desc(branchInventory.assignedAt))
          .limit(limitNum)
          .offset(offset),

        db
          .select({ count: sql<number>`cast(count(*) as integer)` })
          .from(branchInventory)
          .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
          .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
          .where(whereClause),
      ])

      const total = Number(totalResult[0]?.count || 0)
      return {
        items: pricesHidden
          ? items.map((item) => ({ ...item, basePrice: null, customPrice: null }))
          : items,
        total,
        page: pageNum,
        limit: limitNum,
        pricesHidden,
      }
    }, CACHE_TTL.INVENTORY)

    if (!shouldApplyQuantityBudget || !quantityBudgetCatalogActive) {
      return NextResponse.json({
        ...result,
        ...(includeQuantityBudget ? { quantityBudgetCatalogActive } : {}),
        pricesHidden,
      })
    }

    // Keep the filtered inventory listing cached, but fetch remaining units fresh
    // so cart guidance tracks used/held quantities.
    const organizationInventoryIds = result.items.map((item) => item.organizationInventoryId)
    const quantityBudgetRows = organizationInventoryIds.length > 0
      ? await coalesceInFlight(
        scopedCacheKey('inflight:branch-inv:quantity-budget-remaining', {
          orgId: orgIdNum,
          branchId,
        }, {
          period: currentPeriod,
          organizationInventoryIds: [...organizationInventoryIds].sort((a, b) => a - b).join(','),
        }),
        () => db
          .select({
            organizationInventoryId: productQuantityBudgets.organizationInventoryId,
            allocatedQuantity: productQuantityBudgets.allocatedQuantity,
            creditedQuantity: productQuantityBudgets.creditedQuantity,
            heldQuantity: productQuantityBudgets.heldQuantity,
            usedQuantity: productQuantityBudgets.usedQuantity,
          })
          .from(productQuantityBudgets)
          .where(and(
            eq(productQuantityBudgets.organizationId, orgIdNum),
            eq(productQuantityBudgets.branchId, branchId),
            eq(productQuantityBudgets.period, currentPeriod),
            positiveQuantityBudgetTotal,
            inArray(productQuantityBudgets.organizationInventoryId, organizationInventoryIds),
          )),
      )
      : []

    const quantityRemainingByInventoryId = new Map(
      quantityBudgetRows.map((quantityBudget) => [
        quantityBudget.organizationInventoryId,
        quantityBudget.allocatedQuantity +
          quantityBudget.creditedQuantity -
          quantityBudget.usedQuantity -
          quantityBudget.heldQuantity,
      ])
    )

    return NextResponse.json({
      ...result,
      items: result.items.map((item) => ({
        ...item,
        quantityBudgetRemaining: quantityRemainingByInventoryId.get(item.organizationInventoryId) ?? null,
      })),
      quantityBudgetCatalogActive,
      pricesHidden,
    })
  } catch (error: any) {
    console.error("Error fetching branch inventory:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// PUT /api/v1/branch/inventory - Toggle visibility and update stock levels
export async function PUT(req: NextRequest) {
  try {
    console.log("PUT /api/v1/branch/inventory - Starting")
    const session = await getServerSession(authOptions)
    console.log("Session retrieved:", !!session?.user)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const { searchParams } = new URL(req.url)
    const organizationIdParam = searchParams.get("organizationId")
    const branchIdParam = searchParams.get("branchId")

    if (!organizationIdParam || !branchIdParam) {
      return NextResponse.json({ error: "organizationId and branchId query params are required" }, { status: 400 })
    }

    const organizationId = Number.parseInt(organizationIdParam)
    const branchId = Number.parseInt(branchIdParam)
    console.log(`Params: org=${organizationId}, branch=${branchId}`)

    const body = await req.json()
    console.log("Body received:", JSON.stringify(body))
    const {
      id,
      isActive,
    } = body

    if (!id) {
      return NextResponse.json({ error: "Inventory ID is required" }, { status: 400 })
    }

    // Validate that only allowed fields are being updated
    const allowedFields = ['isActive']
    const providedFields = Object.keys(body).filter(key => key !== 'id')
    const invalidFields = providedFields.filter(field => !allowedFields.includes(field))

    if (invalidFields.length > 0) {
      return NextResponse.json({
        error: `Branch admin can only update: ${allowedFields.join(', ')}. Invalid fields: ${invalidFields.join(', ')}`
      }, { status: 400 })
    }

    const updateData: any = {
      updatedAt: new Date()
    }

    if (isActive !== undefined) updateData.isActive = isActive

    const [updatedInventory] = await db.update(branchInventory)
      .set(updateData)
      .where(
        and(
          eq(branchInventory.id, Number(id)),
          eq(branchInventory.organizationId, organizationId),
          eq(branchInventory.branchId, branchId),
          isNull(branchInventory.deletedAt)
        )
      )
      .returning()

    console.log("Update query finished. Result:", !!updatedInventory)

    if (!updatedInventory) {
      return NextResponse.json({ error: "Inventory item not found or access denied" }, { status: 404 })
    }

    // Log the update
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "UPDATE",
      entity: "BranchInventory",
      entityId: id.toString(),
      metadata: {
        organizationId,
        branchId,
        updateData,
        level: "branch_admin"
      },
    })

    // Invalidate branch inventory cache
    await invalidateByPrefix('branch-inv')

    return NextResponse.json({
      message: "Inventory updated successfully",
      inventory: updatedInventory
    })
  } catch (error: any) {
    console.error("Error updating branch inventory:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

