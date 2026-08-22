import "server-only"

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm"

import {
  branchInventory,
  categories,
  globalProducts,
  organizationInventory,
  productQuantityBudgets,
} from "@/db/schema"
import { db } from "@/lib/db"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { escapeLikePattern } from "@/lib/utils"

/**
 * The catalogue a Group Order Portal user may order from for a chosen set of
 * branches.
 *
 * A product is offered only when it is assigned, active, and visible at *every*
 * selected branch. Showing the union instead would mean either silently
 * dropping lines from some branch orders or failing the submission late, so the
 * intersection is taken up front and the number of products left out is
 * reported alongside it.
 *
 * Unit prices come from `organization_inventory` / `global_products` and are
 * therefore identical for every branch in the tenant; no per-branch price
 * reconciliation is needed or performed.
 */

export const CATALOG_PAGE_SIZE_DEFAULT = 48
export const CATALOG_PAGE_SIZE_MAX = 100

export type GroupCatalogItem = {
  organizationInventoryId: number
  globalProductId: number
  name: string
  productCode: string | null
  description: string | null
  imageUrl: string | null
  unit: string
  priceCents: number
  stockQuantity: number
  allowDecimalQuantity: boolean
  quantityStep: number | null
  categoryName: string | null
  /** Smallest remaining allocation across the selected branches, in quantity mode. */
  quantityBudgetRemaining: number | null
}

export type GroupCatalogPage = {
  items: GroupCatalogItem[]
  total: number
  page: number
  limit: number
  /** Products stocked at some but not all selected branches, hence not offered. */
  excludedProductCount: number
  quantityBudgetActive: boolean
}

type CatalogQuery = {
  organizationId: number
  branchIds: number[]
  search?: string
  categoryId?: number
  subCategoryId?: number
  page: number
  limit: number
}

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7)
}

/** The assignment predicate a branch must satisfy for a product to be orderable there. */
function assignmentConditions(organizationId: number, branchIds: number[]): SQL[] {
  return [
    inArray(branchInventory.branchId, branchIds),
    eq(branchInventory.organizationId, organizationId),
    eq(branchInventory.isActive, true),
    eq(branchInventory.isVisible, true),
    isNull(branchInventory.deletedAt),
    eq(organizationInventory.organizationId, organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    eq(globalProducts.status, "active"),
    isNull(globalProducts.deletedAt),
  ] as SQL[]
}

async function searchAndCategoryConditions(query: CatalogQuery): Promise<SQL[]> {
  const conditions: SQL[] = []

  const search = query.search ? escapeLikePattern(query.search.trim()) : ""
  if (search) {
    const pattern = `%${search}%`
    conditions.push(or(
      sql`${globalProducts.name} ILIKE ${pattern}`,
      sql`${globalProducts.productCode} ILIKE ${pattern}`,
      sql`${organizationInventory.customName} ILIKE ${pattern}`,
    ) as SQL)
  }

  if (query.subCategoryId) {
    conditions.push(eq(globalProducts.categoryId, query.subCategoryId))
  } else if (query.categoryId) {
    const subCategories = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.parentId, query.categoryId))
    const ids = subCategories.map((row) => row.id)
    // A parent with no children must match nothing, not everything.
    conditions.push(ids.length > 0
      ? inArray(globalProducts.categoryId, ids)
      : sql`false`)
  }

  return conditions
}

/**
 * Branches that currently run on quantity budgets. A branch with no allocation
 * at all keeps its full catalogue, exactly as the single-branch portal does.
 */
async function resolveQuantityBudgetBranches(
  organizationId: number,
  branchIds: number[],
  period: string,
): Promise<number[]> {
  const mode = await getBudgetAllocationModeForOrganization(organizationId)
  if (mode !== "quantity") return []

  const rows = await db
    .selectDistinct({ branchId: productQuantityBudgets.branchId })
    .from(productQuantityBudgets)
    .where(and(
      eq(productQuantityBudgets.organizationId, organizationId),
      eq(productQuantityBudgets.period, period),
      inArray(productQuantityBudgets.branchId, branchIds),
      sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`,
    ))

  return rows.map((row) => row.branchId)
}

/**
 * Require a positive allocation at every quantity-budgeted branch. Written as a
 * correlated count rather than a join so it composes with the coverage HAVING
 * clause without multiplying rows.
 */
function quantityBudgetCondition(
  organizationId: number,
  quantityBudgetBranchIds: number[],
  period: string,
): SQL | null {
  if (quantityBudgetBranchIds.length === 0) return null
  return sql`(
    SELECT COUNT(DISTINCT ${productQuantityBudgets.branchId})
    FROM ${productQuantityBudgets}
    WHERE ${productQuantityBudgets.organizationId} = ${organizationId}
      AND ${productQuantityBudgets.period} = ${period}
      AND ${inArray(productQuantityBudgets.branchId, quantityBudgetBranchIds)}
      AND ${productQuantityBudgets.organizationInventoryId} = ${organizationInventory.id}
      AND (${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0
  ) = ${quantityBudgetBranchIds.length}`
}

/**
 * Smallest remaining allocation per product across the quantity-budgeted
 * branches — the most any single branch order can take before one of them runs
 * short.
 */
async function loadMinimumRemainingQuantities(
  organizationId: number,
  quantityBudgetBranchIds: number[],
  period: string,
  organizationInventoryIds: number[],
): Promise<Map<number, number>> {
  if (quantityBudgetBranchIds.length === 0 || organizationInventoryIds.length === 0) {
    return new Map()
  }

  const rows = await db
    .select({
      organizationInventoryId: productQuantityBudgets.organizationInventoryId,
      remaining: sql<number>`MIN(
        ${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}
        - ${productQuantityBudgets.usedQuantity} - ${productQuantityBudgets.heldQuantity}
      )`.mapWith(Number),
    })
    .from(productQuantityBudgets)
    .where(and(
      eq(productQuantityBudgets.organizationId, organizationId),
      eq(productQuantityBudgets.period, period),
      inArray(productQuantityBudgets.branchId, quantityBudgetBranchIds),
      inArray(productQuantityBudgets.organizationInventoryId, organizationInventoryIds),
    ))
    .groupBy(productQuantityBudgets.organizationInventoryId)

  return new Map(rows.map((row) => [row.organizationInventoryId, Math.max(row.remaining, 0)]))
}

export async function loadGroupCatalog(query: CatalogQuery): Promise<GroupCatalogPage> {
  const { organizationId, branchIds } = query
  const period = currentPeriod()
  const branchCount = branchIds.length

  const quantityBudgetBranchIds = await resolveQuantityBudgetBranches(organizationId, branchIds, period)
  const filters = await searchAndCategoryConditions(query)
  const budgetFilter = quantityBudgetCondition(organizationId, quantityBudgetBranchIds, period)

  const where = and(
    ...assignmentConditions(organizationId, branchIds),
    ...filters,
    ...(budgetFilter ? [budgetFilter] : []),
  )

  const displayName = sql<string>`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`

  const rows = await db
    .select({
      organizationInventoryId: organizationInventory.id,
      globalProductId: globalProducts.id,
      name: displayName,
      productCode: globalProducts.productCode,
      description: sql<string | null>`COALESCE(${organizationInventory.customDescription}, ${globalProducts.description})`,
      imageUrl: sql<string | null>`COALESCE(${organizationInventory.customImageUrl}, ${globalProducts.imageUrl})`,
      unit: globalProducts.unit,
      priceCents: sql<number>`COALESCE(${organizationInventory.customPrice}, ${globalProducts.basePrice})`.mapWith(Number),
      stockQuantity: sql<number>`${globalProducts.stockQuantity}`.mapWith(Number),
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
      categoryName: categories.name,
    })
    .from(branchInventory)
    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
    .where(where)
    .groupBy(organizationInventory.id, globalProducts.id, categories.name)
    // A product qualifies only when it is assigned at every selected branch.
    .having(sql`COUNT(DISTINCT ${branchInventory.branchId}) = ${branchCount}`)
    .orderBy(asc(displayName))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)

  // One pass for both counters: how many products qualify, and how many were
  // left out because they are missing from at least one selected branch.
  const coverage = db
    .select({
      organizationInventoryId: organizationInventory.id,
      covered: sql<number>`COUNT(DISTINCT ${branchInventory.branchId})`.as("covered"),
    })
    .from(branchInventory)
    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .where(where)
    .groupBy(organizationInventory.id)
    .as("coverage")

  const [coverageRow] = await db
    .select({
      matched: sql<number>`COUNT(*) FILTER (WHERE ${coverage.covered} = ${branchCount})`.mapWith(Number),
      excluded: sql<number>`COUNT(*) FILTER (WHERE ${coverage.covered} < ${branchCount})`.mapWith(Number),
    })
    .from(coverage)

  const minimumRemaining = await loadMinimumRemainingQuantities(
    organizationId,
    quantityBudgetBranchIds,
    period,
    rows.map((row) => row.organizationInventoryId),
  )

  return {
    items: rows.map((row) => ({
      organizationInventoryId: row.organizationInventoryId,
      globalProductId: row.globalProductId,
      name: row.name,
      productCode: row.productCode,
      description: row.description,
      imageUrl: row.imageUrl,
      unit: row.unit,
      priceCents: row.priceCents,
      stockQuantity: row.stockQuantity,
      allowDecimalQuantity: Boolean(row.allowDecimalQuantity),
      quantityStep: row.quantityStep ?? null,
      categoryName: row.categoryName,
      quantityBudgetRemaining: minimumRemaining.get(row.organizationInventoryId) ?? null,
    })),
    total: Number(coverageRow?.matched ?? 0),
    page: query.page,
    limit: query.limit,
    excludedProductCount: Number(coverageRow?.excluded ?? 0),
    quantityBudgetActive: quantityBudgetBranchIds.length > 0,
  }
}
