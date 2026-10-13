import "server-only"

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { categories, globalProducts } from "@/db/schema"
import { db } from "@/lib/db"
import { IMAGE_PATH_PREFIX, isStoredImagePath } from "@/lib/server/image-storage"
import { escapeLikePattern } from "@/lib/utils"
import {
  WAREHOUSE_TAXONOMY_ROW_MAX,
  type WarehouseTaxonomyQuery,
  WAREHOUSE_CATALOG_CATEGORY_MAX,
  WAREHOUSE_LOW_STOCK_THRESHOLD,
  buildWarehouseCatalogCategories,
  isLowStock,
  warehouseCatalogCategoryLabels,
  type WarehouseCatalogCategory,
  type WarehouseCatalogQuery,
} from "@/lib/warehouse-catalog"

/**
 * The warehouse's product catalogue, read-only: Apricart's global catalogue
 * (Global Products, Categories, Subcategories), so no tenant fence applies and
 * no tenant's assignment or override is joined. Every column is named; the
 * global base price is shown, as on Super Admin's Global Products
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md). Nothing here writes.
 */

export type WarehouseCatalogItem = {
  id: number
  productCode: string
  name: string
  unit: string
  status: string
  basePriceCents: number
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
        basePriceCents: globalProducts.basePrice,
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
        basePriceCents: Number(row.basePriceCents),
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

export type WarehouseTaxonomyRow = {
  id: number
  name: string
  parentId: number | null
  parentName: string | null
  subcategoriesCount: number
  productsCount: number
  createdAt: string | null
}

export type WarehouseTaxonomyList = { items: WarehouseTaxonomyRow[]; total: number; truncated: boolean }

/**
 * Super Admin's Categories (top level) or Subcategories (with a parent) list,
 * with the same counts: subcategories under a category, live global products
 * filed under it (a category counts its subcategories' products). Newest first,
 * as there.
 */
export async function listWarehouseTaxonomy(
  query: WarehouseTaxonomyQuery,
  level: "category" | "subcategory",
): Promise<WarehouseTaxonomyList> {
  const parent = alias(categories, "warehouse_taxonomy_parent")
  const conditions: SQL[] = [level === "category" ? isNull(categories.parentId) : isNotNull(categories.parentId)]
  if (query.search) conditions.push(ilike(categories.name, `%${escapeLikePattern(query.search)}%`))
  if (level === "subcategory" && query.categoryId !== null) conditions.push(eq(categories.parentId, query.categoryId))
  const where = and(...conditions)

  const productsCount = level === "category"
    ? sql<number>`(SELECT COUNT(*)::int FROM global_products gp WHERE gp.deleted_at IS NULL AND (gp.category_id = ${categories.id} OR gp.category_id IN (SELECT sub.id FROM categories sub WHERE sub.parent_id = ${categories.id})))`
    : sql<number>`(SELECT COUNT(*)::int FROM global_products gp WHERE gp.deleted_at IS NULL AND gp.category_id = ${categories.id})`

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: categories.id,
        name: categories.name,
        parentId: categories.parentId,
        parentName: parent.name,
        createdAt: categories.createdAt,
        subcategoriesCount: sql<number>`(SELECT COUNT(*)::int FROM categories sub WHERE sub.parent_id = ${categories.id})`,
        productsCount,
      })
      .from(categories)
      .leftJoin(parent, eq(categories.parentId, parent.id))
      .where(where)
      .orderBy(desc(categories.createdAt), desc(categories.id))
      .limit(WAREHOUSE_TAXONOMY_ROW_MAX),
    db.select({ total: sql<number>`COUNT(*)`.mapWith(Number) }).from(categories).where(where),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      parentName: row.parentName,
      subcategoriesCount: Number(row.subcategoriesCount),
      productsCount: Number(row.productsCount),
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    })),
    total,
    truncated: total > rows.length,
  }
}
