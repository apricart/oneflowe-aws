import "server-only"

import { and, asc, count, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm"

import { branchInventory, globalProducts, organizationInventory } from "@/db/schema"
import { db } from "@/lib/db"
import type { DeskCatalogueQuery } from "@/lib/order-desk-catalogue-query"
import type { DeskLineLineage } from "@/lib/order-desk-lines"
import {
  loadGroupPriceOverrides,
  resolveBranchGroupId,
  resolveEffectivePriceCents,
} from "@/lib/server/effective-price"
import { escapeLikePattern } from "@/lib/utils"

/**
 * What an Order Desk user may order for one branch: every active Apricart
 * global product, whether or not the branch carries it
 * (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md).
 *
 * The caller has already checked that the desk reaches this branch
 * (`isOrderDeskTarget`); nothing here widens or reads another target. Whether
 * the branch carries a product is reference only — it never decides whether
 * the desk may select it — and the branch's catalogue price is resolved through
 * the ladder only for a product it carries, so a product it does not carry
 * never shows the global base price as if it were the customer's price.
 */

export type OrderDeskCatalogueItem = {
  globalProductId: number
  /** The branch's own catalogue entry, when it carries the product. Reference only. */
  organizationInventoryId: number | null
  productCode: string
  name: string
  unit: string
  allowDecimalQuantity: boolean
  quantityStep: number
  stockQuantity: number
  assignedToBranch: boolean
  /** What the branch is normally charged; null when it does not carry the product. */
  cataloguePriceCents: number | null
}

export type OrderDeskCataloguePage = {
  items: OrderDeskCatalogueItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

/** The pool, or a transaction — creation and the edit read lineage inside theirs. */
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The branch's catalogue entry and price for each named global product it
 * carries today — active and visible at the branch, active in the
 * organization, none deleted. The same rule `POST /api/v1/orders` uses for every
 * other role's lines, read here only to label a desk line and record its
 * reference price; one function for the catalogue, creation and the edit.
 */
export async function loadDeskBranchLineage(
  executor: Executor,
  scope: { organizationId: number; branchId: number; globalProductIds: readonly number[] },
): Promise<Map<number, DeskLineLineage>> {
  const ids = [...new Set(scope.globalProductIds)]
  if (ids.length === 0) return new Map()
  const rows = await executor
    .select({
      organizationInventoryId: organizationInventory.id,
      globalProductId: organizationInventory.globalProductId,
      customPrice: organizationInventory.customPrice,
      basePrice: globalProducts.basePrice,
    })
    .from(branchInventory)
    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .where(and(
      eq(branchInventory.branchId, scope.branchId),
      eq(branchInventory.organizationId, scope.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      eq(organizationInventory.organizationId, scope.organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      inArray(organizationInventory.globalProductId, ids),
    ))
  if (rows.length === 0) return new Map()

  const groupId = await resolveBranchGroupId(executor, { branchId: scope.branchId, organizationId: scope.organizationId })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(executor, {
    organizationId: scope.organizationId,
    groupId,
    organizationInventoryIds: rows.map((row) => row.organizationInventoryId),
  })
  return new Map(rows.map((row) => [row.globalProductId, {
    organizationInventoryId: row.organizationInventoryId,
    cataloguePriceCents: resolveEffectivePriceCents({
      groupPriceCents: groupPriceByInventoryId.get(row.organizationInventoryId),
      organizationPriceCents: row.customPrice,
      basePriceCents: row.basePrice,
    }),
  }]))
}

function catalogueCondition(search: string | null): SQL {
  const active = and(eq(globalProducts.status, "active"), isNull(globalProducts.deletedAt)) as SQL
  if (!search) return active
  // A parameter, with the LIKE wildcards in what was typed escaped.
  const pattern = `%${escapeLikePattern(search)}%`
  return and(active, or(ilike(globalProducts.name, pattern), ilike(globalProducts.productCode, pattern))) as SQL
}

export async function loadOrderDeskCatalogue(
  scope: { organizationId: number; branchId: number },
  query: DeskCatalogueQuery,
): Promise<OrderDeskCataloguePage> {
  const where = catalogueCondition(query.search)
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(globalProducts).where(where),
    db
      .select({
        globalProductId: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        unit: globalProducts.unit,
        allowDecimalQuantity: globalProducts.allowDecimalQuantity,
        quantityStep: globalProducts.quantityStep,
        stockQuantity: globalProducts.stockQuantity,
      })
      .from(globalProducts)
      .where(where)
      .orderBy(asc(globalProducts.name), asc(globalProducts.id))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
  ])

  const lineage = await loadDeskBranchLineage(db, {
    ...scope,
    globalProductIds: rows.map((row) => row.globalProductId),
  })

  return {
    items: rows.map((row) => {
      const carried = lineage.get(row.globalProductId)
      return {
        globalProductId: row.globalProductId,
        organizationInventoryId: carried?.organizationInventoryId ?? null,
        productCode: row.productCode,
        name: row.name,
        unit: row.unit,
        allowDecimalQuantity: row.allowDecimalQuantity,
        quantityStep: Number(row.quantityStep),
        stockQuantity: Number(row.stockQuantity),
        assignedToBranch: Boolean(carried),
        cataloguePriceCents: carried?.cataloguePriceCents ?? null,
      }
    }),
    pagination: {
      page: query.page,
      limit: query.limit,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / query.limit),
    },
  }
}
