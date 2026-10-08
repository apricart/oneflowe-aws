import "server-only"

import { and, asc, eq, ilike, isNull, lte, or, sql, type SQL } from "drizzle-orm"

import { globalProducts } from "@/db/schema"
import { db } from "@/lib/db"
import { escapeLikePattern } from "@/lib/utils"
import { WAREHOUSE_LOW_STOCK_THRESHOLD, isLowStock, type WarehouseStockQuery } from "@/lib/warehouse-stock"

/**
 * The warehouse's stock list: every global product's code, name, unit, status
 * and stock. Read-only — the warehouse changes no stock in Phase 1. It is
 * Apricart's own catalogue, so no tenant fence applies; no tenant's override
 * (custom name, price, visibility) is read.
 */
export async function listWarehouseStock(query: WarehouseStockQuery) {
  const conditions: SQL[] = [isNull(globalProducts.deletedAt)]
  if (query.status !== "all") conditions.push(eq(globalProducts.status, query.status))
  if (query.lowOnly) conditions.push(lte(globalProducts.stockQuantity, WAREHOUSE_LOW_STOCK_THRESHOLD))
  if (query.search) {
    const pattern = `%${escapeLikePattern(query.search)}%`
    conditions.push(or(ilike(globalProducts.name, pattern), ilike(globalProducts.productCode, pattern))!)
  }
  const where = and(...conditions)

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        unit: globalProducts.unit,
        status: globalProducts.status,
        stockQuantity: globalProducts.stockQuantity,
        updatedAt: globalProducts.updatedAt,
      })
      .from(globalProducts)
      .where(where)
      .orderBy(asc(globalProducts.name), asc(globalProducts.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(globalProducts).where(where),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      productCode: row.productCode,
      name: row.name,
      unit: row.unit,
      status: row.status,
      stockQuantity: Number(row.stockQuantity),
      low: isLowStock(Number(row.stockQuantity)),
      updatedAt: row.updatedAt?.toISOString() ?? null,
    })),
    total,
    page: query.page,
    limit: query.limit,
    lowStockThreshold: WAREHOUSE_LOW_STOCK_THRESHOLD,
  }
}
