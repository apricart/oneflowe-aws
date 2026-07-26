import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, eq, inArray, sql } from "drizzle-orm"
import { z } from "zod"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { auditLogs, categories, globalProducts, productImportBatches } from "@/db/schema"
import { cascadeGlobalProductFieldUpdate } from "@/lib/inventory-cascade"
import { withRateLimit } from "@/lib/rate-limiter"
import { normalizeSafeImageUrl } from "@/lib/security"

const importRowSchema = z.object({
  productCode: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(255),
  description: z.string().trim().max(10_000).optional(),
  category: z.string().trim().max(255).optional(),
  imageUrl: z.string().trim().max(6_000_000).optional(),
  basePrice: z.union([z.string(), z.number()]).optional(),
  unit: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["active", "inactive"]).optional(),
}).strict()

const importPayloadSchema = z.object({
  fileName: z.string().trim().min(1).max(255)
    .regex(/^[^\\/\u0000-\u001f]+\.csv$/i, "fileName must be a plain .csv file name"),
  rows: z.array(importRowSchema).min(1).max(1000),
}).strict()

type PreparedRow = z.infer<typeof importRowSchema> & {
  rowNumber: number
  categoryId: number | null
  normalizedImageUrl: string | null
  basePriceCents: number
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

    let json: unknown
    try {
      json = await req.json()
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 })
    }

    const parsed = importPayloadSchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({
        error: "Invalid import data",
        details: parsed.error.issues.slice(0, 50).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }, { status: 400 })
    }

    const allCategories = await db.select().from(categories)
    const categoryMap = new Map(allCategories.map((category) => [
      category.name.toLowerCase(),
      category.id,
    ]))
    const validationErrors: Array<{ row: number; errors: string[] }> = []
    const preparedRows: PreparedRow[] = []
    const seenCodes = new Set<string>()

    parsed.data.rows.forEach((row, index) => {
      const rowNumber = index + 2
      const errors: string[] = []
      const codeKey = row.productCode.toLowerCase()
      if (seenCodes.has(codeKey)) errors.push("Product code is duplicated in this import")
      seenCodes.add(codeKey)

      let categoryId: number | null = null
      if (row.category) {
        categoryId = categoryMap.get(row.category.toLowerCase()) ?? null
        if (!categoryId) errors.push(`Category "${row.category}" was not found`)
      }

      const rawPrice = String(row.basePrice ?? "0").trim()
      const basePriceCents = Math.round(Number(rawPrice) * 100)
      if (
        !/^\d+(?:\.\d{1,2})?$/.test(rawPrice) ||
        !Number.isSafeInteger(basePriceCents) ||
        basePriceCents < 0
      ) {
        errors.push("Base price must be a non-negative number with at most two decimal places")
      }

      const normalizedImageUrl = normalizeSafeImageUrl(row.imageUrl)
      if (row.imageUrl && !normalizedImageUrl) {
        errors.push("Image URL must be a same-origin path, HTTPS URL, or supported raster data URL")
      }

      if (errors.length > 0) {
        validationErrors.push({ row: rowNumber, errors })
        return
      }

      preparedRows.push({
        ...row,
        rowNumber,
        categoryId,
        normalizedImageUrl,
        basePriceCents,
      })
    })

    if (validationErrors.length > 0) {
      return NextResponse.json({
        error: "Import validation failed; no products were imported",
        validationErrors: validationErrors.slice(0, 50),
      }, { status: 400 })
    }

    const productCodes = preparedRows.map((row) => row.productCode)
    const existingProducts = await db
      .select()
      .from(globalProducts)
      .where(inArray(globalProducts.productCode, productCodes))
    const existingByCode = new Map(existingProducts.map((product) => [product.productCode, product]))

    const result = await db.transaction(async (tx) => {
      const importedProductIds: number[] = []

      for (const row of preparedRows) {
        const existingProduct = existingByCode.get(row.productCode)
        if (existingProduct) {
          const [updated] = await tx
            .update(globalProducts)
            .set({
              name: row.name,
              description: row.description || null,
              categoryId: row.categoryId,
              imageUrl: row.normalizedImageUrl,
              basePrice: row.basePriceCents,
              unit: row.unit || "unit",
              status: row.status || "active",
              updatedAt: new Date(),
              lastSyncedAt: new Date(),
            })
            .where(eq(globalProducts.id, existingProduct.id))
            .returning()

          const updates = [
            existingProduct.name !== row.name
              ? { field: "name" as const, oldValue: existingProduct.name, newValue: row.name }
              : null,
            existingProduct.description !== (row.description || null)
              ? { field: "description" as const, oldValue: existingProduct.description, newValue: row.description || null }
              : null,
            existingProduct.imageUrl !== row.normalizedImageUrl
              ? { field: "imageUrl" as const, oldValue: existingProduct.imageUrl, newValue: row.normalizedImageUrl }
              : null,
            existingProduct.basePrice !== row.basePriceCents
              ? { field: "basePrice" as const, oldValue: existingProduct.basePrice, newValue: row.basePriceCents }
              : null,
          ].filter((update): update is NonNullable<typeof update> => update !== null)
          await cascadeGlobalProductFieldUpdate(updated.id, updates, userId, tx)
          importedProductIds.push(updated.id)
        } else {
          const [created] = await tx
            .insert(globalProducts)
            .values({
              productCode: row.productCode,
              name: row.name,
              description: row.description || null,
              categoryId: row.categoryId,
              imageUrl: row.normalizedImageUrl,
              basePrice: row.basePriceCents,
              unit: row.unit || "unit",
              status: row.status || "active",
              createdByUserId: userId,
              lastSyncedAt: new Date(),
            })
            .returning()
          importedProductIds.push(created.id)
        }
      }

      const [batch] = await tx
        .insert(productImportBatches)
        .values({
          fileName: parsed.data.fileName,
          uploadedByUserId: userId,
          totalRows: preparedRows.length,
          successfulRows: preparedRows.length,
          failedRows: 0,
          status: "completed",
          validationErrors: [],
          importedProductIds,
          completedAt: new Date(),
        })
        .returning()

      await tx.insert(auditLogs).values({
        userId,
        organizationId: null,
        branchId: null,
        action: "import_products",
        entity: "global_products",
        entityId: batch.id.toString(),
        metadata: {
          fileName: parsed.data.fileName,
          totalRows: preparedRows.length,
          successfulRows: preparedRows.length,
          failedRows: 0,
        },
      })

      return { batch, importedProductIds }
    })

    return NextResponse.json({
      batchId: result.batch.id,
      summary: {
        total: preparedRows.length,
        successful: preparedRows.length,
        failed: 0,
        status: "completed",
      },
      validationErrors: [],
      importedProductIds: result.importedProductIds,
    })
  } catch (error) {
    console.error("Error importing products:", error)
    return NextResponse.json(
      { error: "Import failed; no products were committed" },
      { status: 500 },
    )
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userId = (session.user as any).id as string
    const { searchParams } = new URL(req.url)
    const batchIdValue = searchParams.get("batchId")

    if (!batchIdValue) {
      const batches = await db
        .select()
        .from(productImportBatches)
        .where(eq(productImportBatches.uploadedByUserId, userId))
        .orderBy(sql`${productImportBatches.createdAt} DESC`)
        .limit(20)
      return NextResponse.json({ batches })
    }

    const batchId = Number(batchIdValue)
    if (!Number.isInteger(batchId) || batchId <= 0) {
      return NextResponse.json({ error: "Invalid batchId" }, { status: 400 })
    }

    const [batch] = await db
      .select()
      .from(productImportBatches)
      .where(and(
        eq(productImportBatches.id, batchId),
        eq(productImportBatches.uploadedByUserId, userId),
      ))
      .limit(1)

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    return NextResponse.json({ batch })
  } catch (error) {
    console.error("Error fetching import batch:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
