import "server-only"

import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import {
  branchInventory,
  branches,
  categories,
  globalProducts,
  groups,
  organizationInventory,
  organizations,
  productRequests,
} from "@/db/schema"
import { db } from "@/lib/db"
import { resolveEffectivePriceCents } from "@/lib/price-ladder"
import { isProductRequestImagePath } from "@/lib/product-request"
import { groupPriceJoinOn, groupPriceTier, scopedOverrideCentsSql } from "@/lib/server/effective-price"
import { isStoredImagePath } from "@/lib/server/image-storage"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import { escapeLikePattern } from "@/lib/utils"
import {
  warehouseCatalogCategoryLabels,
  type WarehouseGroupProductsQuery,
  type WarehouseOrganizationProductsQuery,
  type WarehouseProductRequestsQuery,
} from "@/lib/warehouse-catalog"

/**
 * The tenant-owned half of the warehouse's read-only catalogue — Organization
 * Products, Group Products and Product Requests — fenced to the organizations
 * whose branches the warehouse serves. See
 * plans/OF-WAREHOUSE-full-read-only-catalog.md.
 *
 * The fence is resolved from `loadWarehouseReach` on every request, never from
 * the request: an organization the caller names outside it reads as not found.
 * Prices are shown, as Super Admin sees them; people are not (no requester,
 * reviewer or assigner), as on every other warehouse read. Nothing here writes.
 */

type DbClient = typeof db

export type WarehouseCatalogFence = {
  branchIds: number[]
  organizations: Array<{ id: number; name: string }>
}

/** The branches the warehouse serves and the organizations they belong to. Empty means none, never all. */
export async function loadWarehouseCatalogFence(userId: string, client: DbClient = db): Promise<WarehouseCatalogFence> {
  const branchIds = await loadWarehouseReach(client, userId)
  if (branchIds.length === 0) return { branchIds, organizations: [] }
  const rows = await client
    .selectDistinct({ id: organizations.id, name: organizations.name })
    .from(branches)
    .innerJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(inArray(branches.id, branchIds))
    .orderBy(asc(organizations.name), asc(organizations.id))
  return { branchIds, organizations: rows }
}

export function fenceAdmitsOrganization(fence: WarehouseCatalogFence, organizationId: number): boolean {
  return fence.organizations.some((organization) => organization.id === organizationId)
}

const storedImage = (value: string | null): string | null => (isStoredImagePath(value) ? value : null)

// ---------------------------------------------------------------------------
// Organization Products
// ---------------------------------------------------------------------------

export type WarehouseOrganizationProduct = {
  id: number
  productCode: string
  name: string
  imageUrl: string | null
  unit: string
  category: string | null
  subcategory: string | null
  basePriceCents: number
  /** The organization's own price, or null when it inherits the base price. */
  customPriceCents: number | null
  /** What the organization pays: its own price, else the base price. */
  effectivePriceCents: number
  active: boolean
  assignedAt: string | null
}

export type WarehouseOrganizationProductsPage = {
  organization: { id: number; name: string }
  items: WarehouseOrganizationProduct[]
  total: number
  page: number
  limit: number
}

/** One organization's catalogue — the caller has already checked it is inside the fence. */
export async function listWarehouseOrganizationProducts(
  query: WarehouseOrganizationProductsQuery,
  organization: { id: number; name: string },
): Promise<WarehouseOrganizationProductsPage> {
  const direct = alias(categories, "warehouse_org_products_direct")
  const parent = alias(categories, "warehouse_org_products_parent")
  const conditions: SQL[] = [
    eq(organizationInventory.organizationId, organization.id),
    isNull(organizationInventory.deletedAt),
    isNull(globalProducts.deletedAt),
  ]
  if (query.search) {
    const pattern = `%${escapeLikePattern(query.search)}%`
    conditions.push(or(ilike(globalProducts.name, pattern), ilike(globalProducts.productCode, pattern))!)
  }
  const activeSql = sql<boolean>`(${organizationInventory.isActive} AND ${globalProducts.status} = 'active')`
  if (query.status === "active") conditions.push(sql`${activeSql}`)
  if (query.status === "inactive") conditions.push(sql`NOT ${activeSql}`)
  const where = and(...conditions)

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: organizationInventory.id,
        productCode: globalProducts.productCode,
        name: sql<string>`COALESCE(NULLIF(${organizationInventory.customName}, ''), ${globalProducts.name})`,
        globalImage: globalProducts.imageUrl,
        customImage: organizationInventory.customImageUrl,
        unit: globalProducts.unit,
        basePriceCents: globalProducts.basePrice,
        customPriceCents: organizationInventory.customPrice,
        active: activeSql,
        assignedAt: organizationInventory.assignedAt,
        categoryName: direct.name,
        categoryParentId: direct.parentId,
        parentName: parent.name,
      })
      .from(organizationInventory)
      .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
      .leftJoin(direct, eq(globalProducts.categoryId, direct.id))
      .leftJoin(parent, eq(direct.parentId, parent.id))
      .where(where)
      .orderBy(desc(organizationInventory.assignedAt), desc(organizationInventory.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db
      .select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(organizationInventory)
      .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
      .where(where),
  ])

  return {
    organization,
    items: rows.map((row) => {
      const basePriceCents = Number(row.basePriceCents)
      const customPriceCents = row.customPriceCents === null ? null : Number(row.customPriceCents)
      return {
        id: row.id,
        productCode: row.productCode,
        name: row.name,
        imageUrl: storedImage(row.customImage) ?? storedImage(row.globalImage),
        unit: row.unit,
        ...warehouseCatalogCategoryLabels({ name: row.categoryName, parentId: row.categoryParentId, parentName: row.parentName }),
        basePriceCents,
        customPriceCents,
        effectivePriceCents: resolveEffectivePriceCents({ basePriceCents, organizationPriceCents: customPriceCents }) ?? 0,
        active: Boolean(row.active),
        assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
      }
    }),
    total,
    page: query.page,
    limit: query.limit,
  }
}

// ---------------------------------------------------------------------------
// Group Products
// ---------------------------------------------------------------------------

export type WarehouseGroup = { id: number; name: string; branches: string[] }

export type WarehouseGroupProduct = {
  id: number
  productCode: string
  name: string
  imageUrl: string | null
  unit: string
  basePriceCents: number
  /** What the whole group pays when it differs from the base: its own price, else the organization's. */
  overridePriceCents: number | null
  effectivePriceCents: number
  active: boolean
  branchCount: number
  assignedAt: string | null
}

export type WarehouseGroupProductsResponse = {
  organization: { id: number; name: string }
  groups: WarehouseGroup[]
  group: WarehouseGroup | null
  items: WarehouseGroupProduct[]
  total: number
  page: number
  limit: number
}

/**
 * The organization's groups and, when one is chosen, the products its branches
 * carry, priced by the ladder exactly as Super Admin's Group Products shows
 * them: group price, else organization price, else base. A group of another
 * organization reads as not found (null).
 */
export async function listWarehouseGroupProducts(
  query: WarehouseGroupProductsQuery,
  organization: { id: number; name: string },
): Promise<WarehouseGroupProductsResponse | null> {
  const groupRows = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(and(eq(groups.organizationId, organization.id), sql`lower(coalesce(${groups.status}, 'active')) <> 'deleted'`))
    .orderBy(asc(groups.name), asc(groups.id))
  const groupIds = groupRows.map((group) => group.id)
  const branchRows = groupIds.length === 0
    ? []
    : await db
      .select({ groupId: branches.groupId, name: branches.name })
      .from(branches)
      .where(and(eq(branches.organizationId, organization.id), inArray(branches.groupId, groupIds)))
      .orderBy(asc(branches.name))
  const groupList: WarehouseGroup[] = groupRows.map((group) => ({
    ...group,
    branches: branchRows.filter((branch) => branch.groupId === group.id).map((branch) => branch.name),
  }))

  const empty = { organization, groups: groupList, items: [], total: 0, page: query.page, limit: query.limit }
  if (query.groupId === null) return { ...empty, group: null }
  const group = groupList.find((candidate) => candidate.id === query.groupId)
  if (!group) return null

  const scope = { organizationId: organization.id, groupId: group.id }
  const joinBranches = and(
    eq(branchInventory.branchId, branches.id),
    eq(branches.organizationId, organization.id),
    eq(branches.groupId, group.id),
  )
  const joinOrganizationInventory = and(
    eq(branchInventory.organizationInventoryId, organizationInventory.id),
    eq(organizationInventory.organizationId, organization.id),
    isNull(organizationInventory.deletedAt),
  )
  const joinGlobal = and(eq(organizationInventory.globalProductId, globalProducts.id), isNull(globalProducts.deletedAt))
  const membership = and(eq(branchInventory.organizationId, organization.id), isNull(branchInventory.deletedAt))

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: organizationInventory.id,
        productCode: globalProducts.productCode,
        name: sql<string>`COALESCE(NULLIF(${organizationInventory.customName}, ''), ${globalProducts.name})`,
        globalImage: globalProducts.imageUrl,
        unit: globalProducts.unit,
        basePriceCents: globalProducts.basePrice,
        overridePriceCents: scopedOverrideCentsSql(),
        active: sql<boolean>`(${organizationInventory.isActive} AND ${globalProducts.status} = 'active')`,
        branchCount: sql<number>`count(distinct ${branchInventory.branchId})::int`,
        assignedAt: sql<Date | null>`min(${branchInventory.assignedAt})`,
      })
      .from(branchInventory)
      .innerJoin(branches, joinBranches)
      .innerJoin(organizationInventory, joinOrganizationInventory)
      .innerJoin(globalProducts, joinGlobal)
      .leftJoin(groupPriceTier, groupPriceJoinOn(scope))
      .where(membership)
      .groupBy(globalProducts.id, organizationInventory.id, groupPriceTier.customPriceCents)
      .orderBy(desc(sql`min(${branchInventory.assignedAt})`), desc(organizationInventory.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db
      .select({ total: sql<number>`count(distinct ${organizationInventory.id})`.mapWith(Number) })
      .from(branchInventory)
      .innerJoin(branches, joinBranches)
      .innerJoin(organizationInventory, joinOrganizationInventory)
      .innerJoin(globalProducts, joinGlobal)
      .where(membership),
  ])

  return {
    ...empty,
    group,
    items: rows.map((row) => {
      const basePriceCents = Number(row.basePriceCents)
      const overridePriceCents = row.overridePriceCents === null ? null : Number(row.overridePriceCents)
      return {
        id: row.id,
        productCode: row.productCode,
        name: row.name,
        imageUrl: storedImage(row.globalImage),
        unit: row.unit,
        basePriceCents,
        overridePriceCents,
        // The override already layers group over organization (`scopedOverrideCentsSql`).
        effectivePriceCents: resolveEffectivePriceCents({ basePriceCents, organizationPriceCents: overridePriceCents }) ?? 0,
        active: Boolean(row.active),
        branchCount: Number(row.branchCount),
        assignedAt: row.assignedAt ? new Date(row.assignedAt).toISOString() : null,
      }
    }),
    total,
  }
}

// ---------------------------------------------------------------------------
// Product Requests
// ---------------------------------------------------------------------------

export type WarehouseProductRequest = {
  id: number
  status: string
  productName: string | null
  brand: string | null
  description: string | null
  category: string | null
  subcategory: string | null
  unit: string | null
  packSize: string | null
  barcode: string | null
  expectedPriceCents: number | null
  estimatedMonthlyQuantity: number | null
  preferredSupplier: string | null
  /** Shown as text only; never rendered as a link. */
  referenceUrl: string | null
  notes: string | null
  imageUrl: string | null
  reviewNote: string | null
  estimatedAvailableOn: string | null
  organizationId: number
  organizationName: string
  createdAt: string | null
  reviewedAt: string | null
}

export type WarehouseProductRequestsPage = {
  items: WarehouseProductRequest[]
  total: number
  counts: Record<string, number>
  page: number
  limit: number
}

/** Requests raised by the organizations in the fence, newest first. */
export async function listWarehouseProductRequests(
  query: WarehouseProductRequestsQuery,
  organizationIds: number[],
): Promise<WarehouseProductRequestsPage> {
  if (organizationIds.length === 0) return { items: [], total: 0, counts: {}, page: query.page, limit: query.limit }
  const tenant = query.organizationId === null
    ? inArray(productRequests.organizationId, organizationIds)
    : eq(productRequests.organizationId, query.organizationId)
  const filtered = and(tenant, query.status === null ? undefined : eq(productRequests.status, query.status))
  const category = alias(categories, "warehouse_request_category")
  const subcategory = alias(categories, "warehouse_request_subcategory")

  const [rows, [totalRow], countRows] = await Promise.all([
    db
      .select({
        id: productRequests.id,
        status: productRequests.status,
        productName: productRequests.productName,
        brand: productRequests.brand,
        description: productRequests.description,
        categoryName: category.name,
        subcategoryName: subcategory.name,
        unit: productRequests.unit,
        packSize: productRequests.packSize,
        barcode: productRequests.barcode,
        expectedPriceCents: productRequests.expectedPriceCents,
        estimatedMonthlyQuantity: productRequests.estimatedMonthlyQuantity,
        preferredSupplier: productRequests.preferredSupplier,
        referenceUrl: productRequests.referenceUrl,
        notes: productRequests.notes,
        imageUrl: productRequests.imageUrl,
        reviewNote: productRequests.reviewNote,
        estimatedAvailableOn: productRequests.estimatedAvailableOn,
        organizationId: organizations.id,
        organizationName: organizations.name,
        createdAt: productRequests.createdAt,
        reviewedAt: productRequests.reviewedAt,
      })
      .from(productRequests)
      .innerJoin(organizations, eq(productRequests.organizationId, organizations.id))
      .leftJoin(category, eq(productRequests.categoryId, category.id))
      .leftJoin(subcategory, eq(productRequests.subcategoryId, subcategory.id))
      .where(filtered)
      .orderBy(desc(productRequests.createdAt), desc(productRequests.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db.select({ value: count() }).from(productRequests).where(filtered),
    db.select({ status: productRequests.status, value: count() }).from(productRequests).where(tenant).groupBy(productRequests.status),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      productName: row.productName,
      brand: row.brand,
      description: row.description,
      category: row.categoryName,
      subcategory: row.subcategoryName,
      unit: row.unit,
      packSize: row.packSize,
      barcode: row.barcode,
      expectedPriceCents: row.expectedPriceCents === null ? null : Number(row.expectedPriceCents),
      estimatedMonthlyQuantity: row.estimatedMonthlyQuantity === null ? null : Number(row.estimatedMonthlyQuantity),
      preferredSupplier: row.preferredSupplier,
      referenceUrl: row.referenceUrl,
      notes: row.notes,
      imageUrl: isProductRequestImagePath(row.imageUrl) ? row.imageUrl : null,
      reviewNote: row.reviewNote,
      estimatedAvailableOn: row.estimatedAvailableOn ? String(row.estimatedAvailableOn) : null,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      createdAt: row.createdAt ? row.createdAt.toISOString() : null,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    })),
    total: Number(totalRow?.value ?? 0),
    counts: Object.fromEntries(countRows.map((row) => [row.status, Number(row.value)])),
    page: query.page,
    limit: query.limit,
  }
}
