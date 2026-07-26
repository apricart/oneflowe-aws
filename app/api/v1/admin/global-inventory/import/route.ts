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
      const rowNumber = index + 2
      const errors: string[] = []
      const productCode = csvValue(row, "productcode", "product_code").trim()
      const normalizedCode = productCode.toLowerCase()
      const name = row.name.trim()
      const description = row.description?.trim() || null
      const categoryName = row.category?.trim() || ""
      const rawImageUrl = csvValue(row, "imageurl", "image_url").trim()
      const normalizedImageUrl = normalizeSafeImageUrl(rawImageUrl)
      const rawBasePrice = csvValue(row, "baseprice", "base_price").trim()
      const unit = row.unit?.trim() || "unit"
      const rawStatus = row.status?.trim().toLowerCase() || "active"
      const rawStock = csvValue(row, "stockquantity", "stock_quantity").trim() || "0"
      const rawAllowDecimal = csvValue(row, "allowdecimalquantity", "allow_decimal_quantity")
      const rawQuantityStep = csvValue(row, "quantitystep", "quantity_step").trim()

      if (!productCode || productCode.length > 128) errors.push("Product code is required and must be at most 128 characters")
      if (seenCodes.has(normalizedCode)) errors.push("Product code is duplicated in this file")
      seenCodes.add(normalizedCode)
      if (!name || name.length > 255) errors.push("Product name is required and must be at most 255 characters")
      if (description && description.length > 10_000) errors.push("Description must be at most 10,000 characters")
      if (unit.length > 64) errors.push("Unit must be at most 64 characters")
      if (rawImageUrl && !normalizedImageUrl) errors.push("Image URL must be a same-origin path, HTTPS URL, or supported raster data URL")

      let categoryId: number | null = null
      if (categoryName) {
        categoryId = categoryMap.get(categoryName.toLowerCase()) ?? null
        if (!categoryId) errors.push(`Category "${categoryName}" was not found`)
      }

      const price = Number(rawBasePrice)
      const basePrice = Math.round(price * 100)
      if (
        !/^\d+(?:\.\d{1,2})?$/.test(rawBasePrice) ||
        !Number.isSafeInteger(basePrice) ||
        basePrice < 0
      ) {
        errors.push("Base price must be a non-negative number with at most two decimal places")
      }

      const allowDecimalQuantity = parseBoolean(rawAllowDecimal)
      if (allowDecimalQuantity === null) {
        errors.push("allowDecimalQuantity must be true/false, yes/no, or 1/0")
      }

      const stockQuantity = parseQuantity(rawStock)
      const quantityStep = sanitizeQuantityStep(Boolean(allowDecimalQuantity), rawQuantityStep)
      if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
        errors.push("Stock quantity must be a non-negative number")
      } else if (stockQuantity > 0) {
        const stockValidation = validateProductQuantity(stockQuantity, {
          allowDecimalQuantity: Boolean(allowDecimalQuantity),
          quantityStep,
          label: "Stock quantity",
        })
        if (!stockValidation.ok) errors.push(stockValidation.error)
      }
      if (
        Boolean(allowDecimalQuantity) &&
        rawQuantityStep &&
        (!Number.isFinite(parseQuantity(rawQuantityStep)) || parseQuantity(rawQuantityStep) <= 0)
      ) {
        errors.push("Quantity step must be greater than zero")
      }

      if (rawStatus !== "active" && rawStatus !== "inactive") {
        errors.push("Status must be active or inactive")
      }

      if (errors.length > 0) {
        validationErrors.push({ row: rowNumber, errors })
        return
      }

      preparedRows.push({
        rowNumber,
        productCode,
        name,
        description,
        categoryId,
        imageUrl: normalizedImageUrl,
        basePrice,
        unit,
        status: rawStatus as "active" | "inactive",
        stockQuantity,
        allowDecimalQuantity: Boolean(allowDecimalQuantity),
        quantityStep,
      })
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
        if (existingProduct) {
          const [updated] = await tx
            .update(globalProducts)
            .set({
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
            })
            .where(eq(globalProducts.id, existingProduct.id))
            .returning()

          const updates = [
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

          await cascadeGlobalProductFieldUpdate(updated.id, updates, userId, tx)
          importedIds.push(updated.id)
        } else {
          const [created] = await tx
            .insert(globalProducts)
            .values({
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
            })
            .returning()
          importedIds.push(created.id)
        }
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
