import "server-only"

import { and, asc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { categories, globalProducts } from "@/db/schema"
import { db } from "@/lib/db"
import { IMAGE_PATH_PREFIX, isStoredImagePath } from "@/lib/server/image-storage"
import { escapeLikePattern } from "@/lib/utils"
import {
  WAREHOUSE_CATALOG_CATEGORY_MAX,
  WAREHOUSE_LOW_STOCK_THRESHOLD,
  buildWarehouseCatalogCategories,
  isLowStock,
  warehouseCatalogCategoryLabels,
  type WarehouseCatalogCategory,
  type WarehouseCatalogQuery,
} from "@/lib/warehouse-catalog"

/**
 * The warehouse's product catalogue, read-only: Apricart's global catalogue,
 * so no tenant fence applies and no tenant's assignment, override or price is
 * joined. Every column is named, and none of them is a price — not
 * `base_price_cents`, not `tax_rate_bp`, not a discount — so there is no price
 * in the payload to hide. See plans/OF-WAREHOUSE-read-only-product-catalog.md.
 */

export type WarehouseCatalogItem = {
  id: number
  productCode: string
  name: string
  unit: string
  status: string
  stockQuantity: number
  low: boolean
  imageUrl: string | null
  category: string | null
  subcategory: string | null
}

export type WarehouseCatalogPage = {
  items: WarehouseCatalogItem[]
  total: number
  page: number
  limit: number
  lowStockThreshold: number
}

/** Only a picture in the bucket, which the image route serves; never a legacy `data:` URL. */
const storedImageSql = sql<string | null>`CASE WHEN ${globalProducts.imageUrl} LIKE ${`${IMAGE_PATH_PREFIX}/products/%`} THEN ${globalProducts.imageUrl} END`

function catalogConditions(query: WarehouseCatalogQuery): SQL {
  const conditions: SQL[] = [isNull(globalProducts.deletedAt)]
  if (query.status !== "all") conditions.push(eq(globalProducts.status, query.status))
  if (query.search) {
    const pattern = `%${escapeLikePattern(query.search)}%`
    conditions.push(or(ilike(globalProducts.name, pattern), ilike(globalProducts.productCode, pattern))!)
  }
  if (query.categoryId !== null) {
    // A top-level category holds the products filed under it directly and
    // those under each of its subcategories.
    const children = db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, query.categoryId))
    conditions.push(or(eq(globalProducts.categoryId, query.categoryId), inArray(globalProducts.categoryId, children))!)
  }
  if (query.subcategoryId !== null) conditions.push(eq(globalProducts.categoryId, query.subcategoryId))
  return and(...conditions)!
}

export async function listWarehouseCatalog(query: WarehouseCatalogQuery): Promise<WarehouseCatalogPage> {
  const where = catalogConditions(query)
  const direct = alias(categories, "warehouse_catalog_direct")
  const parent = alias(categories, "warehouse_catalog_parent")

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        unit: globalProducts.unit,
        status: globalProducts.status,
        stockQuantity: globalProducts.stockQuantity,
        imageUrl: storedImageSql,
        categoryName: direct.name,
        categoryParentId: direct.parentId,
        parentName: parent.name,
      })
      .from(globalProducts)
      .leftJoin(direct, eq(globalProducts.categoryId, direct.id))
      .leftJoin(parent, eq(direct.parentId, parent.id))
      .where(where)
      .orderBy(asc(globalProducts.name), asc(globalProducts.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(globalProducts).where(where),
  ])

  return {
    items: rows.map((row) => {
      const stockQuantity = Number(row.stockQuantity)
      return {
        id: row.id,
        productCode: row.productCode,
        name: row.name,
        unit: row.unit,
        status: row.status,
        stockQuantity,
        low: isLowStock(stockQuantity),
        imageUrl: isStoredImagePath(row.imageUrl) ? row.imageUrl : null,
        ...warehouseCatalogCategoryLabels({ name: row.categoryName, parentId: row.categoryParentId, parentName: row.parentName }),
      }
    }),
    total,
    page: query.page,
    limit: query.limit,
    lowStockThreshold: WAREHOUSE_LOW_STOCK_THRESHOLD,
  }
}

/**
 * The category filter: every category a live global product is filed under,
 * with its parent. Never the whole `categories` table, so a category no
 * global product carries is not named here.
 */
export async function listWarehouseCatalogCategories(): Promise<WarehouseCatalogCategory[]> {
  const parent = alias(categories, "warehouse_catalog_parent")
  const used = db
    .selectDistinct({ id: globalProducts.categoryId })
    .from(globalProducts)
    .where(and(isNull(globalProducts.deletedAt), isNotNull(globalProducts.categoryId)))

  const rows = await db
    .select({ id: categories.id, name: categories.name, parentId: categories.parentId, parentName: parent.name })
    .from(categories)
    .leftJoin(parent, eq(categories.parentId, parent.id))
    .where(inArray(categories.id, used))
    .orderBy(asc(categories.id))
    .limit(WAREHOUSE_CATALOG_CATEGORY_MAX)

  return buildWarehouseCatalogCategories(rows)
}
