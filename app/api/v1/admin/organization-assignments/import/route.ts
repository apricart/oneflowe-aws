import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import {
  auditLogs,
  globalProducts,
  organizationInventory,
  organizations,
} from "@/db/schema"
import { withRateLimit } from "@/lib/rate-limiter"
import { readStrictCsvFile } from "@/lib/server/csv-import"

const ALLOWED_HEADERS = [
  "productcode",
  "customprice",
  "customname",
  "customdescription",
  "isactive",
] as const

type ParsedRow = {
  rowNumber: number
  productCode: string
  customPrice: number | null
  customName: string | null
  customDescription: string | null
  isActive?: boolean
}

function parseOptionalBoolean(value: string): boolean | null | undefined {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("import", userId)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("file")
    const organizationIdValue = formData.get("organizationId")
    const defaultIsActiveValue = String(formData.get("isActive") ?? "")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 })
    }

    const organizationId = Number(organizationIdValue)
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return NextResponse.json({ error: "A valid organizationId is required" }, { status: 400 })
    }

    const defaultIsActive = parseOptionalBoolean(defaultIsActiveValue)
    if (defaultIsActive === null) {
      return NextResponse.json({ error: "isActive must be true or false" }, { status: 400 })
    }

    let records: Array<Record<string, string>>
    try {
      records = await readStrictCsvFile(file, {
        requiredHeaders: ["productcode"],
        allowedHeaders: ALLOWED_HEADERS,
      })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid CSV file" },
        { status: 400 },
      )
    }

    const validationErrors: Array<{ row: number; errors: string[] }> = []
    const parsedRows: ParsedRow[] = []
    const seenCodes = new Set<string>()

    records.forEach((record, index) => {
      const rowNumber = index + 2
      const errors: string[] = []
      const productCode = record.productcode.trim().toUpperCase()
      const customName = record.customname?.trim() || null
      const customDescription = record.customdescription?.trim() || null
      const rawPrice = record.customprice?.trim() || ""
      const isActive = parseOptionalBoolean(record.isactive ?? "")

      if (!productCode || productCode.length > 128) {
        errors.push("productCode is required and must be at most 128 characters")
      }
      if (seenCodes.has(productCode)) errors.push("productCode is duplicated in this file")
      seenCodes.add(productCode)
      if (customName && customName.length > 255) errors.push("customName must be at most 255 characters")
      if (customDescription && customDescription.length > 10_000) {
        errors.push("customDescription must be at most 10,000 characters")
      }
      if (isActive === null) errors.push("isActive must be true/false, yes/no, or 1/0")

      let customPrice: number | null = null
      if (rawPrice) {
        customPrice = Math.round(Number(rawPrice) * 100)
        if (
          !/^\d+(?:\.\d{1,2})?$/.test(rawPrice) ||
          !Number.isSafeInteger(customPrice) ||
          customPrice < 0
        ) {
          errors.push("customPrice must be a non-negative number with at most two decimal places")
        }
      }

      if (errors.length > 0) {
        validationErrors.push({ row: rowNumber, errors })
        return
      }

      parsedRows.push({
        rowNumber,
        productCode,
        customPrice,
        customName,
        customDescription,
        isActive: isActive ?? defaultIsActive ?? true,
      })
    })

    if (validationErrors.length > 0) {
      return NextResponse.json({
        error: "CSV validation failed; no assignments were imported",
        validationErrors: validationErrors.slice(0, 50),
      }, { status: 400 })
    }

    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    if (!organization) {
      return NextResponse.json({ error: "Organization not found" }, { status: 404 })
    }

    const productCodes = parsedRows.map((row) => row.productCode)
    const products = await db
      .select({ id: globalProducts.id, productCode: globalProducts.productCode })
      .from(globalProducts)
      .where(inArray(globalProducts.productCode, productCodes))
    const productMap = new Map(products.map((product) => [product.productCode.toUpperCase(), product]))
    const missingProducts = productCodes.filter((code) => !productMap.has(code))
    if (missingProducts.length > 0) {
      return NextResponse.json({
        error: "Some product codes were not found; no assignments were imported",
        missingProducts,
      }, { status: 400 })
    }

    const productIds = parsedRows.map((row) => productMap.get(row.productCode)!.id)
    const existingAssignments = await db
      .select({ globalProductId: organizationInventory.globalProductId })
      .from(organizationInventory)
      .where(and(
        eq(organizationInventory.organizationId, organizationId),
        inArray(organizationInventory.globalProductId, productIds),
      ))
    if (existingAssignments.length > 0) {
      const existingIds = new Set(existingAssignments.map((assignment) => assignment.globalProductId))
      const alreadyAssigned = parsedRows
        .filter((row) => existingIds.has(productMap.get(row.productCode)!.id))
        .map((row) => row.productCode)
      return NextResponse.json({
        error: "Some products are already assigned or archived for this organization; no assignments were imported",
        alreadyAssigned,
      }, { status: 409 })
    }

    const inserted = await db.transaction(async (tx) => {
      const assignments = await tx
        .insert(organizationInventory)
        .values(parsedRows.map((row) => ({
          globalProductId: productMap.get(row.productCode)!.id,
          organizationId,
          assignedByUserId: userId,
          isActive: row.isActive ?? true,
          customName: row.customName,
          customPrice: row.customPrice,
          customDescription: row.customDescription,
          customImageUrl: null,
        })))
        .returning()

      await tx.insert(auditLogs).values({
        userId,
        action: "CREATE",
        entity: "OrganizationAssignmentImport",
        entityId: assignments.map((row) => row.id).join(","),
        metadata: {
          organizationId,
          importedCount: assignments.length,
          fileName: file.name,
        },
      })

      return assignments
    })

    return NextResponse.json({
      message: `Imported ${inserted.length} products successfully`,
      imported: inserted.length,
      skippedExisting: 0,
      missingProducts: [],
    })
  } catch (error) {
    console.error("Error importing assignments:", error)
    return NextResponse.json(
      { error: "Import failed; no assignments were committed" },
      { status: 500 },
    )
  }
}
