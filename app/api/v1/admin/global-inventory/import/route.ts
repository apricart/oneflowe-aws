import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { eq, inArray } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { globalProducts, categories, auditLogs } from "@/db/schema"
import { cascadeGlobalProductFieldUpdate } from "@/lib/inventory-cascade"
import { parseQuantity, sanitizeQuantityStep, validateProductQuantity } from "@/lib/quantity"
import { withRateLimit } from "@/lib/rate-limiter"
import { normalizeSafeImageUrl } from "@/lib/security"
import { readStrictCsvFile } from "@/lib/server/csv-import"

const ALLOWED_HEADERS = [
  "productcode",
  "product_code",
  "name",
  "description",
  "category",
  "imageurl",
  "image_url",
  "baseprice",
  "base_price",
  "unit",
  "status",
  "stockquantity",
  "stock_quantity",
  "allowdecimalquantity",
  "allow_decimal_quantity",
  "quantitystep",
  "quantity_step",
] as const

type PreparedProduct = {
  rowNumber: number
  productCode: string
  name: string
  description: string | null
  categoryId: number | null
  imageUrl: string | null
  basePrice: number
  unit: string
  status: "active" | "inactive"
  stockQuantity: number
  allowDecimalQuantity: boolean
  quantityStep: number
}

const csvValue = (row: Record<string, string>, ...keys: string[]) =>
  keys.map((key) => row[key]).find((value) => value !== undefined) ?? ""

const parseBoolean = (value: string) => {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  if (["true", "yes", "1"].includes(normalized)) return true
  if (["false", "no", "0"].includes(normalized)) return false
  return null
}

type ProductTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type ExistingProduct = typeof globalProducts.$inferSelect

function collectBasicProductErrors(input: {
  productCode: string
  normalizedCode: string
  name: string
  description: string | null
  unit: string
  rawImageUrl: string
  normalizedImageUrl: string | null
  seenCodes: Set<string>
}) {
  const errors: string[] = []
  if (!input.productCode || input.productCode.length > 128) errors.push("Product code is required and must be at most 128 characters")
  if (input.seenCodes.has(input.normalizedCode)) errors.push("Product code is duplicated in this file")
  input.seenCodes.add(input.normalizedCode)
  if (!input.name || input.name.length > 255) errors.push("Product name is required and must be at most 255 characters")
  if (input.description && input.description.length > 10_000) errors.push("Description must be at most 10,000 characters")
  if (input.unit.length > 64) errors.push("Unit must be at most 64 characters")
  if (input.rawImageUrl && !input.normalizedImageUrl) {
    errors.push("Image URL must be a same-origin path, HTTPS URL, or supported raster data URL")
  }
  return errors
}

function resolveCategory(categoryName: string, categoryMap: Map<string, number>) {
  if (!categoryName) return { categoryId: null, error: null }
  const categoryId = categoryMap.get(categoryName.toLowerCase()) ?? null
  return {
    categoryId,
    error: categoryId ? null : `Category "${categoryName}" was not found`,
  }
}

function resolveQuantityFields(rawStock: string, rawAllowDecimal: string, rawQuantityStep: string) {
  const errors: string[] = []
  const allowDecimalQuantity = parseBoolean(rawAllowDecimal)
  if (allowDecimalQuantity === null) {
    errors.push("allowDecimalQuantity must be true/false, yes/no, or 1/0")
  }
  const stockQuantity = parseQuantity(rawStock)
  const quantityStep = sanitizeQuantityStep(Boolean(allowDecimalQuantity), rawQuantityStep)
  if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
    errors.push("Stock quantity must be a non-negative number")
  } else if (stockQuantity > 0) {
    const validation = validateProductQuantity(stockQuantity, {
      allowDecimalQuantity: Boolean(allowDecimalQuantity),
      quantityStep,
      label: "Stock quantity",
    })
    if (!validation.ok) errors.push(validation.error)
  }
  const parsedStep = parseQuantity(rawQuantityStep)
  if (Boolean(allowDecimalQuantity) && rawQuantityStep && (!Number.isFinite(parsedStep) || parsedStep <= 0)) {
    errors.push("Quantity step must be greater than zero")
  }
  return { allowDecimalQuantity: Boolean(allowDecimalQuantity), stockQuantity, quantityStep, errors }
}

function prepareProductRow(
  row: Record<string, string>,
  rowNumber: number,
  categoryMap: Map<string, number>,
  seenCodes: Set<string>,
) {
  const productCode = csvValue(row, "productcode", "product_code").trim()
  const normalizedCode = productCode.toLowerCase()
  const name = row.name.trim()
  const description = row.description?.trim() || null
  const categoryName = row.category?.trim() || ""
  const rawImageUrl = csvValue(row, "imageurl", "image_url").trim()
  const imageUrl = normalizeSafeImageUrl(rawImageUrl)
  const rawBasePrice = csvValue(row, "baseprice", "base_price").trim()
  const unit = row.unit?.trim() || "unit"
  const status = row.status?.trim().toLowerCase() || "active"
  const errors = collectBasicProductErrors({
    productCode, normalizedCode, name, description, unit, rawImageUrl,
    normalizedImageUrl: imageUrl, seenCodes,
  })

  const { categoryId, error: categoryError } = resolveCategory(categoryName, categoryMap)
  if (categoryError) errors.push(categoryError)
  const basePrice = Math.round(Number(rawBasePrice) * 100)
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawBasePrice) || !Number.isSafeInteger(basePrice) || basePrice < 0) {
    errors.push("Base price must be a non-negative number with at most two decimal places")
  }
  const quantity = resolveQuantityFields(
    csvValue(row, "stockquantity", "stock_quantity").trim() || "0",
    csvValue(row, "allowdecimalquantity", "allow_decimal_quantity"),
    csvValue(row, "quantitystep", "quantity_step").trim(),
  )
  errors.push(...quantity.errors)
  if (status !== "active" && status !== "inactive") errors.push("Status must be active or inactive")
  if (errors.length > 0) return { errors }

  const product: PreparedProduct = {
    rowNumber, productCode, name, description, categoryId, imageUrl, basePrice, unit,
    status: status as "active" | "inactive",
    stockQuantity: quantity.stockQuantity,
    allowDecimalQuantity: quantity.allowDecimalQuantity,
    quantityStep: quantity.quantityStep,
  }
  return { product, errors }
}

const getProductCascadeUpdates = (existingProduct: ExistingProduct, row: PreparedProduct) => [
  existingProduct.name !== row.name
    ? { field: "name" as const, oldValue: existingProduct.name, newValue: row.name }
    : null,
  existingProduct.description !== row.description
    ? { field: "description" as const, oldValue: existingProduct.description, newValue: row.description }
    : null,
  existingProduct.imageUrl !== row.imageUrl
    ? { field: "imageUrl" as const, oldValue: existingProduct.imageUrl, newValue: row.imageUrl }
    : null,
  existingProduct.basePrice !== row.basePrice
    ? { field: "basePrice" as const, oldValue: existingProduct.basePrice, newValue: row.basePrice }
    : null,
].filter((update): update is NonNullable<typeof update> => update !== null)

async function upsertProduct(
  tx: ProductTransaction,
  row: PreparedProduct,
  existingProduct: ExistingProduct | undefined,
  userId: string,
) {
  if (existingProduct) {
    const [updated] = await tx.update(globalProducts).set({
      name: row.name,
      description: row.description,
      categoryId: row.categoryId,
      imageUrl: row.imageUrl,
      basePrice: row.basePrice,
      unit: row.unit,
      status: row.status,
      stockQuantity: row.stockQuantity,
      allowDecimalQuantity: row.allowDecimalQuantity,
      quantityStep: row.quantityStep,
      updatedAt: new Date(),
      lastSyncedAt: new Date(),
    }).where(eq(globalProducts.id, existingProduct.id)).returning()
    await cascadeGlobalProductFieldUpdate(updated.id, getProductCascadeUpdates(existingProduct, row), userId, tx)
    return updated.id
  }

  const [created] = await tx.insert(globalProducts).values({
    productCode: row.productCode,
    name: row.name,
    description: row.description,
    categoryId: row.categoryId,
    imageUrl: row.imageUrl,
    basePrice: row.basePrice,
    unit: row.unit,
    status: row.status,
    stockQuantity: row.stockQuantity,
    allowDecimalQuantity: row.allowDecimalQuantity,
    quantityStep: row.quantityStep,
    createdByUserId: userId,
    lastSyncedAt: new Date(),
  }).returning()
  return created.id
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = (session.user as any).id as string
    if ((session.user as any).role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("import", userId)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("file")
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 })
    }

    let rows: Array<Record<string, string>>
    try {
      rows = await readStrictCsvFile(file, {
        requiredHeaders: ["name"],
        requiredHeaderGroups: [["productcode", "product_code"], ["baseprice", "base_price"]],
        allowedHeaders: ALLOWED_HEADERS,
      })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid CSV file" },
        { status: 400 },
      )
    }

    const allCategories = await db.select().from(categories)
    const categoryMap = new Map(allCategories.map((category) => [
      category.name.toLowerCase(),
      category.id,
    ]))

    const validationErrors: Array<{ row: number; errors: string[] }> = []
    const preparedRows: PreparedProduct[] = []
    const seenCodes = new Set<string>()

    rows.forEach((row, index) => {
      const prepared = prepareProductRow(row, index + 2, categoryMap, seenCodes)
      if (prepared.product) preparedRows.push(prepared.product)
      else validationErrors.push({ row: index + 2, errors: prepared.errors })
    })

    if (validationErrors.length > 0) {
      return NextResponse.json({
        error: "CSV validation failed; no products were imported",
        validationErrors: validationErrors.slice(0, 50),
      }, { status: 400 })
    }

    const productCodes = preparedRows.map((row) => row.productCode)
    const existingProducts = productCodes.length > 0
      ? await db.select().from(globalProducts).where(inArray(globalProducts.productCode, productCodes))
      : []
    const existingByCode = new Map(existingProducts.map((product) => [product.productCode, product]))

    const importedProductIds = await db.transaction(async (tx) => {
      const importedIds: number[] = []

      for (const row of preparedRows) {
        const existingProduct = existingByCode.get(row.productCode)
        importedIds.push(await upsertProduct(tx, row, existingProduct, userId))
      }

      await tx.insert(auditLogs).values({
        userId,
        organizationId: null,
        branchId: null,
        action: "import_products",
        entity: "global_products",
        entityId: "bulk_import",
        metadata: {
          fileName: file.name,
          totalRows: preparedRows.length,
          successfulRows: preparedRows.length,
          failedRows: 0,
        },
      })

      return importedIds
    })

    return NextResponse.json({
      message: `Successfully imported ${importedProductIds.length} product(s)`,
      imported: importedProductIds.length,
      failed: 0,
      importedProductIds,
    })
  } catch (error) {
    console.error("Error importing products:", error)
    return NextResponse.json({ error: "Failed to import products; no changes were committed" }, { status: 500 })
  }
}
