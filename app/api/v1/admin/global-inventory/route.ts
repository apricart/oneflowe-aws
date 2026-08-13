import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { globalProducts,categories,organizationInventory,auditLogs } from "@/db/schema"
import { eq,and,ilike,or,desc,sql,inArray,isNull,ne,type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { cascadeGlobalProductStatusChange,cascadeGlobalProductFieldUpdate } from "@/lib/inventory-cascade"
import { escapeLikePattern } from "@/lib/utils"
import { getCached,invalidateByPrefix,scopedCacheKey } from "@/lib/cache-utils"
import {
  globalProductAdminCreateSchema,
  globalProductAdminUpdateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import { parseQuantity,sanitizeQuantityStep,validateProductQuantity } from "@/lib/quantity"

// Increase body size limit to handle Base64-encoded product images
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb',
    },
  },
}

async function getProductImagesResponse(searchParams: URLSearchParams) {
  if (searchParams.get("imagesOnly") !== "true") return null

  const idsParam = searchParams.get("ids")
  const productIds = idsParam
    ? idsParam.split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0)
    : []

  if (productIds.length === 0) return NextResponse.json({ items: [] })
  if (productIds.length > 100) {
    return NextResponse.json({ error: "A maximum of 100 image IDs is allowed" }, { status: 400 })
  }

  const items = await db
    .select({ id: globalProducts.id, imageUrl: globalProducts.imageUrl })
    .from(globalProducts)
    .where(and(inArray(globalProducts.id, productIds), isNull(globalProducts.deletedAt)))
  return NextResponse.json({ items })
}

async function getSingleProductResponse(searchParams: URLSearchParams) {
  const id = searchParams.get("id")
  if (!id) return null

  const productId = Number.parseInt(id)
  if (Number.isNaN(productId)) {
    return NextResponse.json({ error: "Invalid product ID" }, { status: 400 })
  }

  const [item] = await db
    .select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      description: globalProducts.description,
      categoryId: globalProducts.categoryId,
      imageUrl: globalProducts.imageUrl,
      basePrice: globalProducts.basePrice,
      unit: globalProducts.unit,
      status: globalProducts.status,
      stockQuantity: globalProducts.stockQuantity,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
      metadata: globalProducts.metadata,
      discountType: globalProducts.discountType,
      discountValue: globalProducts.discountValue,
      discountStartAt: globalProducts.discountStartAt,
      discountEndAt: globalProducts.discountEndAt,
      discountActive: globalProducts.discountActive,
      createdAt: globalProducts.createdAt,
      updatedAt: globalProducts.updatedAt,
      categoryName: categories.name,
    })
    .from(globalProducts)
    .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
    .where(eq(globalProducts.id, productId))
    .limit(1)

  if (!item) return NextResponse.json({ error: "Product not found" }, { status: 404 })

  const [assignment] = await db
    .select({
      globalProductId: organizationInventory.globalProductId,
      assignedOrganizations: sql<number>`count(distinct ${organizationInventory.organizationId})`,
    })
    .from(organizationInventory)
    .where(and(
      eq(organizationInventory.globalProductId, productId),
      eq(organizationInventory.isActive, true),
    ))
    .groupBy(organizationInventory.globalProductId)

  return NextResponse.json({
    item: { ...item, assignedOrganizations: assignment?.assignedOrganizations || 0 },
  })
}

async function addCategoryCondition(conditions: SQL[], category: string) {
  if (!category) return
  const categoryId = Number.parseInt(category)
  const [categoryInfo] = await db
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)

  if (!categoryInfo) return
  if (categoryInfo.parentId !== null) {
    conditions.push(eq(globalProducts.categoryId, categoryId))
    return
  }

  const subCategories = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.parentId, categoryId))
  const subCategoryIds = subCategories.map((subCategory) => subCategory.id)
  conditions.push(
    subCategoryIds.length > 0
      ? inArray(globalProducts.categoryId, subCategoryIds)
      : eq(globalProducts.categoryId, -1),
  )
}

async function buildGlobalInventoryConditions(options: {
  search: string
  category: string
  subCategory: string | null
  status: string
}) {
  const { search, category, subCategory, status } = options
  const conditions: SQL[] = [isNull(globalProducts.deletedAt)]
  if (search) {
    const searchCondition = or(
      ilike(globalProducts.name, `%${search}%`),
      ilike(globalProducts.productCode, `%${search}%`),
      ilike(globalProducts.description, `%${search}%`),
    )
    if (searchCondition) conditions.push(searchCondition)
  }
  await addCategoryCondition(conditions, category)
  if (subCategory) conditions.push(eq(globalProducts.categoryId, Number.parseInt(subCategory)))
  if (status && status !== "all") conditions.push(eq(globalProducts.status, status))
  return conditions
}

// GET /api/v1/admin/global-inventory - List all global products with assignment stats
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
    const imagesResponse = await getProductImagesResponse(searchParams)
    if (imagesResponse) return imagesResponse
    const productResponse = await getSingleProductResponse(searchParams)
    if (productResponse) return productResponse

    // Otherwise, return paginated list
    const searchRaw = searchParams.get("search") || ""
    const search = searchRaw ? escapeLikePattern(searchRaw) : "" // Sanitize LIKE patterns
    const category = searchParams.get("category") || ""
    const status = searchParams.get("status") || ""
    const lite = searchParams.get("lite") === "true"
    const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
    const limit = Math.min(Math.max(Math.trunc(Number(searchParams.get("limit"))) || 50, 1), 500)
    const offset = (page - 1) * limit

    const cacheKey = scopedCacheKey('global-inv', { role: 'SUPER_ADMIN' }, {
      search, category, subCategory: searchParams.get("subCategory") || '', status, page, limit
    })

    return getCached(cacheKey, async () => {

    const subCategory = searchParams.get("subCategory")
    const conditions = await buildGlobalInventoryConditions({ search, category, subCategory, status })

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const subCategories = alias(categories, "subCategories")
    const parentCategories = alias(categories, "parentCategories")

    // Fetch products with pagination and category information
    const [items, totalResult, overallSummary] = await Promise.all([
      db.select({
        id: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        description: lite ? sql<string | null>`NULL` : globalProducts.description,
        categoryId: globalProducts.categoryId,
        imageUrl: lite ? sql<string | null>`NULL` : globalProducts.imageUrl,
        basePrice: globalProducts.basePrice,
        unit: globalProducts.unit,
        status: globalProducts.status,
        stockQuantity: globalProducts.stockQuantity,
        allowDecimalQuantity: globalProducts.allowDecimalQuantity,
        quantityStep: globalProducts.quantityStep,
        metadata: lite ? sql<Record<string, any> | null>`NULL` : globalProducts.metadata,
        discountType: lite ? sql<string | null>`NULL` : globalProducts.discountType,
        discountValue: lite ? sql<number | null>`NULL` : globalProducts.discountValue,
        discountStartAt: lite ? sql<Date | null>`NULL` : globalProducts.discountStartAt,
        discountEndAt: lite ? sql<Date | null>`NULL` : globalProducts.discountEndAt,
        discountActive: lite ? sql<boolean | null>`NULL` : globalProducts.discountActive,
        createdAt: lite ? sql<Date | null>`NULL` : globalProducts.createdAt,
        updatedAt: lite ? sql<Date | null>`NULL` : globalProducts.updatedAt,
        categoryName: subCategories.name,
        parentCategoryName: parentCategories.name,
      })
        .from(globalProducts)
        .leftJoin(subCategories, eq(globalProducts.categoryId, subCategories.id))
        .leftJoin(parentCategories, eq(subCategories.parentId, parentCategories.id))
        .where(whereClause)
        .orderBy(desc(globalProducts.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(globalProducts).where(whereClause),
      db.select({
        totalProducts: sql<number>`COUNT(*)::int`,
        activeProducts: sql<number>`COUNT(CASE WHEN ${globalProducts.status} = 'active' THEN 1 END)::int`,
        inactiveProducts: sql<number>`COUNT(CASE WHEN ${globalProducts.status} = 'inactive' THEN 1 END)::int`,
      })
        .from(globalProducts)
        .where(isNull(globalProducts.deletedAt))
    ])

    const total = totalResult[0]?.count || 0

    // Get assignment counts for each product
    const productIds = items.map(item => item.id)
    const assignmentCounts = productIds.length > 0 ? await db.select({
      globalProductId: organizationInventory.globalProductId,
      assignedOrganizations: sql<number>`count(distinct ${organizationInventory.organizationId})`,
    })
      .from(organizationInventory)
      .where(
        and(
          inArray(organizationInventory.globalProductId, productIds),
          eq(organizationInventory.isActive, true)
        )
      )
      .groupBy(organizationInventory.globalProductId) : []

    // Create a map for quick lookup
    const assignmentMap = new Map()
    assignmentCounts.forEach(assignment => {
      assignmentMap.set(assignment.globalProductId, {
        assignedOrganizations: assignment.assignedOrganizations,
      })
    })

    // Add assignment counts to items
    const itemsWithAssignments = items.map(item => ({
      ...item,
      assignedOrganizations: assignmentMap.get(item.id)?.assignedOrganizations || 0,
    }))

    return {
      items: itemsWithAssignments,
      summary: {
        totalProducts: overallSummary[0]?.totalProducts || 0,
        activeProducts: overallSummary[0]?.activeProducts || 0,
        inactiveProducts: overallSummary[0]?.inactiveProducts || 0,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    }
    }, 30).then(data => NextResponse.json(data))
  } catch (error: any) {
    console.error("Error fetching global products:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// POST /api/v1/admin/global-inventory - Create new global product
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

    const rawBody = await req.json().catch(() => null)
    const parsedBody = globalProductAdminCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const {
      productCode,
      name,
      description,
      categoryId,
      imageUrl,
      basePrice,
      unit,
      status = "active",
      stockQuantity = 0,
      allowDecimalQuantity = false,
      quantityStep,
      metadata = {},
      discountType,
      discountValue, // for percent provide number in basis points (e.g., 1000 = 10%) or cents for flat
      discountStartAt,
      discountEndAt,
      discountActive,
    } = parsedBody.data

    if (!productCode || !name || !basePrice) {
      return NextResponse.json({ error: "Product code, name, and base price are required" }, { status: 400 })
    }

    // Check if product code already exists (excluding soft-deleted products)
    const existingProduct = await db.select()
      .from(globalProducts)
      .where(
        and(
          eq(globalProducts.productCode, productCode),
          isNull(globalProducts.deletedAt)
        )
      )
      .limit(1)

    if (existingProduct.length > 0) {
      return NextResponse.json({ error: "Product code already exists" }, { status: 400 })
    }

    const decimalEnabled = Boolean(allowDecimalQuantity)
    const normalizedQuantityStep = sanitizeQuantityStep(decimalEnabled, quantityStep)
    const stockValidation = validateProductQuantity(parseQuantity(stockQuantity ?? 0), {
      allowDecimalQuantity: decimalEnabled,
      quantityStep: normalizedQuantityStep,
      label: "Stock quantity",
    })

    if (!stockValidation.ok && parseQuantity(stockQuantity ?? 0) !== 0) {
      return NextResponse.json({ error: stockValidation.error }, { status: 400 })
    }

    const normalizedStockQuantity = Math.max(0, parseQuantity(stockQuantity ?? 0) || 0)

    const [newProduct] = await db.insert(globalProducts)
      .values({
        productCode,
        name,
        description: description || null,
        categoryId: categoryId ?? null,
        imageUrl: imageUrl || null,
        basePrice: Math.round(basePrice * 100), // Convert to cents
        unit: unit || "unit",
        status,
        stockQuantity: normalizedStockQuantity,
        allowDecimalQuantity: decimalEnabled,
        quantityStep: normalizedQuantityStep,
        metadata,
        discountType: discountType || null,
        discountValue: discountValue ?? null,
        discountStartAt: discountStartAt ? new Date(discountStartAt) : null,
        discountEndAt: discountEndAt ? new Date(discountEndAt) : null,
        discountActive: !!discountActive,
      })
      .returning()

    // Log the creation
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "CREATE",
      entity: "GlobalProduct",
      entityId: newProduct.id.toString(),
      metadata: { productCode, name, basePrice },
    })

    // Invalidate global inventory cache
    await invalidateByPrefix('global-inv')

    return NextResponse.json({
      message: "Product created successfully",
      product: newProduct
    })
  } catch (error: any) {
    console.error("Error creating product:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

function applyBasicProductUpdates(updateData: Record<string, any>, input: Record<string, any>) {
  const { productCode, name, description, categoryId, imageUrl, basePrice, unit, status, metadata } = input
  if (productCode !== undefined) updateData.productCode = productCode
  if (name !== undefined) updateData.name = name
  if (description !== undefined) updateData.description = description
  if (categoryId !== undefined) updateData.categoryId = categoryId
  if (imageUrl !== undefined) updateData.imageUrl = imageUrl
  if (basePrice !== undefined) updateData.basePrice = Math.round(basePrice * 100)
  if (unit !== undefined) updateData.unit = unit
  if (status !== undefined) updateData.status = status
  if (metadata !== undefined) updateData.metadata = metadata
}

function applyDiscountUpdates(updateData: Record<string, any>, input: Record<string, any>) {
  const { discountType, discountValue, discountStartAt, discountEndAt, discountActive } = input
  if (discountType !== undefined) updateData.discountType = discountType || null
  if (discountValue !== undefined) updateData.discountValue = discountValue
  if (discountStartAt !== undefined) updateData.discountStartAt = discountStartAt ? new Date(discountStartAt) : null
  if (discountEndAt !== undefined) updateData.discountEndAt = discountEndAt ? new Date(discountEndAt) : null
  if (discountActive !== undefined) updateData.discountActive = Boolean(discountActive)
}

function applyQuantityUpdates(
  updateData: Record<string, any>,
  input: Record<string, any>,
  existingProduct: Record<string, any>,
) {
  const { allowDecimalQuantity, quantityStep, stockQuantity } = input
  const existingDecimalEnabled = Boolean(existingProduct.allowDecimalQuantity)
  const nextDecimalEnabled = allowDecimalQuantity === undefined
    ? existingDecimalEnabled
    : Boolean(allowDecimalQuantity)
  const nextQuantityStep = sanitizeQuantityStep(
    nextDecimalEnabled,
    quantityStep ?? existingProduct.quantityStep ?? 1,
  )
  if (allowDecimalQuantity !== undefined) updateData.allowDecimalQuantity = nextDecimalEnabled
  if (quantityStep !== undefined || allowDecimalQuantity !== undefined) {
    updateData.quantityStep = nextQuantityStep
  }
  if (stockQuantity === undefined) return null

  const parsedStock = parseQuantity(stockQuantity)
  const stockValidation = validateProductQuantity(parsedStock, {
    allowDecimalQuantity: nextDecimalEnabled,
    quantityStep: nextQuantityStep,
    label: "Stock quantity",
  })
  if (!stockValidation.ok && parsedStock !== 0) return stockValidation.error
  updateData.stockQuantity = Math.max(0, parsedStock || 0)
  return null
}

function buildGlobalProductUpdateData(input: Record<string, any>, existingProduct: Record<string, any>) {
  const updateData: Record<string, any> = {}
  applyBasicProductUpdates(updateData, input)
  applyDiscountUpdates(updateData, input)
  const stockError = applyQuantityUpdates(updateData, input, existingProduct)
  updateData.updatedAt = new Date()
  return { updateData, stockError }
}

type ProductFieldChange = {
  field: "name" | "description" | "imageUrl" | "basePrice"
  oldValue: any
  newValue: any
}

function getProductFieldChanges(input: Record<string, any>, existingProduct: Record<string, any>) {
  const changes: ProductFieldChange[] = []
  if (input.name !== undefined && input.name !== existingProduct.name) {
    changes.push({ field: "name", oldValue: existingProduct.name, newValue: input.name })
  }
  if (input.description !== undefined && input.description !== existingProduct.description) {
    changes.push({ field: "description", oldValue: existingProduct.description, newValue: input.description })
  }
  if (input.imageUrl !== undefined && input.imageUrl !== existingProduct.imageUrl) {
    changes.push({ field: "imageUrl", oldValue: existingProduct.imageUrl, newValue: input.imageUrl })
  }
  if (input.basePrice !== undefined) {
    const newPriceCents = Math.round(input.basePrice * 100)
    if (newPriceCents !== existingProduct.basePrice) {
      changes.push({ field: "basePrice", oldValue: existingProduct.basePrice, newValue: newPriceCents })
    }
  }
  return changes
}

async function cascadeProductUpdates(options: {
  id: number
  userId: string
  status: string | undefined
  existingProduct: Record<string, any>
  input: Record<string, any>
}) {
  const { id, userId, status, existingProduct, input } = options
  if (status !== undefined && status !== existingProduct.status) {
    const result = await cascadeGlobalProductStatusChange(id, status, userId, "SUPER_ADMIN")
    await db.insert(auditLogs).values({
      userId,
      action: "CASCADE_UPDATE",
      entity: "GlobalProduct",
      entityId: id.toString(),
      metadata: {
        globalProductId: id,
        status,
        orgUpdates: result.updatedOrgCount,
        branchUpdates: result.updatedBranchCount,
        affectedOrgs: result.affectedOrgs,
        affectedBranches: result.affectedBranches,
        performedByRole: "SUPER_ADMIN",
      },
    })
  }

  const fieldChanges = getProductFieldChanges(input, existingProduct)
  if (fieldChanges.length === 0) return
  const result = await cascadeGlobalProductFieldUpdate(id, fieldChanges, userId)
  if (result.updatedCount > 0) {
    console.log(`[Cascade] Cleared ${result.updatedCount} overrides for global product ${id}`)
  }
}

function isDuplicateProductCodeError(error: any) {
  const errorCode = error.code || error.cause?.code
  const errorMessage = error.message || error.cause?.message || ""
  return errorCode === "23505"
    || (errorMessage.includes("unique constraint") && errorMessage.includes("product_code"))
}

// PUT /api/v1/admin/global-inventory - Update global product
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

    const rawBody = await req.json().catch(() => null)
    const parsedBody = globalProductAdminUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const {
      id,
      productCode,
      name,
      description,
      categoryId,
      imageUrl,
      basePrice,
      unit,
      status,
      stockQuantity,
      allowDecimalQuantity,
      quantityStep,
      metadata,
      discountType,
      discountValue,
      discountStartAt,
      discountEndAt,
      discountActive,
    } = parsedBody.data

    if (!id) {
      return NextResponse.json({ error: "Product ID is required" }, { status: 400 })
    }

    const productId = id

    // Check if product code already exists for another product (excluding soft-deleted)
    if (productCode) {
      const [existingProductWithCode] = await db.select()
        .from(globalProducts)
        .where(
          and(
            eq(globalProducts.productCode, productCode.toString().trim()),
            ne(globalProducts.id, productId),
            isNull(globalProducts.deletedAt)
          )
        )
        .limit(1)

      if (existingProductWithCode) {
        return NextResponse.json({ error: "Product code already exists" }, { status: 400 })
      }
    }

    // Check if product exists and get current status
    const [existingProduct] = await db.select({
      id: globalProducts.id,
      status: globalProducts.status,
      name: globalProducts.name,
      description: globalProducts.description,
      imageUrl: globalProducts.imageUrl,
      basePrice: globalProducts.basePrice,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
    })
      .from(globalProducts)
      .where(eq(globalProducts.id, id))
      .limit(1)

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 })
    }

    const productInput = {
      productCode, name, description, categoryId, imageUrl, basePrice, unit, status,
      stockQuantity, allowDecimalQuantity, quantityStep, metadata, discountType,
      discountValue, discountStartAt, discountEndAt, discountActive,
    }
    const { updateData, stockError } = buildGlobalProductUpdateData(productInput, existingProduct)
    if (stockError) return NextResponse.json({ error: stockError }, { status: 400 })

    const [updatedProduct] = await db.update(globalProducts)
      .set(updateData)
      .where(eq(globalProducts.id, id))
      .returning()

    await cascadeProductUpdates({
      id,
      userId: (session.user as any).id,
      status,
      existingProduct,
      input: productInput,
    })

    // Log the update
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: "UPDATE",
      entity: "GlobalProduct",
      entityId: id.toString(),
      metadata: updateData,
    })

    // Invalidate global inventory cache
    await invalidateByPrefix('global-inv')

    return NextResponse.json({
      message: "Product updated successfully",
      product: updatedProduct
    })
  } catch (error: any) {
    console.error("Error updating product:", error)

    // Handle unique constraint violation (Postgres code 23505)
    // Handle unique constraint violation (Postgres code 23505)
    // Drizzle/pg may wrap the error in a cause property, so we check both
    if (isDuplicateProductCodeError(error)) {
      return NextResponse.json({ error: "Product code already exists" }, { status: 400 })
    }

    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

// DELETE /api/v1/admin/global-inventory - Delete global product (Soft Delete)
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
    const mode = searchParams.get("mode") || "deactivate" // Default to deactivate for backward compatibility

    if (!id) {
      return NextResponse.json({ error: "Product ID is required" }, { status: 400 })
    }

    const productId = Number.parseInt(id)

    // Check if product exists
    const [existingProduct] = await db.select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      status: globalProducts.status,
    })
      .from(globalProducts)
      .where(and(eq(globalProducts.id, productId), isNull(globalProducts.deletedAt)))
      .limit(1)

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 })
    }

    if (mode === "delete") {
      // Soft delete by marking deletedAt
      await db.update(globalProducts)
        .set({
          status: "inactive",
          deletedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(globalProducts.id, productId))
    } else {
      // Just deactivate
      await db.update(globalProducts)
        .set({
          status: "inactive",
          updatedAt: new Date()
        })
        .where(eq(globalProducts.id, productId))
    }

    // Cascade status change to organization and branch inventory
    const cascadeResult = await cascadeGlobalProductStatusChange(
      productId,
      "inactive",
      (session.user as any).id,
      "SUPER_ADMIN"
    )

    // Log the action
    await db.insert(auditLogs).values({
      userId: (session.user as any).id,
      action: mode === "delete" ? "DELETE" : "UPDATE",
      entity: "GlobalProduct",
      entityId: id.toString(),
      metadata: {
        productCode: existingProduct.productCode,
        productName: existingProduct.name,
        mode,
        type: mode === "delete" ? "soft_delete" : "status_change",
        cascadeResult: {
          updatedOrgCount: cascadeResult.updatedOrgCount,
          updatedBranchCount: cascadeResult.updatedBranchCount,
          affectedOrgs: cascadeResult.affectedOrgs,
          affectedBranches: cascadeResult.affectedBranches
        }
      },
    })

    // Invalidate global inventory cache
    await invalidateByPrefix('global-inv')

    return NextResponse.json({
      message: "Product deleted successfully",
      product: existingProduct,
      cascadeResult
    })
  } catch (error: any) {
    console.error("Error deleting product:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

