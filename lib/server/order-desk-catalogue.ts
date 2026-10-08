import "server-only"

import { and, asc, eq, isNull } from "drizzle-orm"

import { branchInventory, globalProducts, organizationInventory } from "@/db/schema"
import { db } from "@/lib/db"
import {
  loadGroupPriceOverrides,
  resolveBranchGroupId,
  resolveEffectivePriceCents,
} from "@/lib/server/effective-price"

/**
 * What an Order Desk user may order for one branch, at the price that branch
 * will be charged.
 *
 * The filters are the ones `POST /api/v1/orders` applies when it loads the
 * order's lines (`loadCreationInventory`): the branch row active and visible,
 * the organization row active, the global product active, none deleted. The
 * price goes through the same ladder — group override, organization price,
 * global base price — with the same two helpers, so the figure on the desk's
 * screen is the figure the order is created at. The caller has already checked
 * that the desk reaches this branch.
 */

/** Matches the shop's ceiling: a branch never lists more than this. */
export const ORDER_DESK_CATALOGUE_LIMIT = 1000

export type OrderDeskCatalogueItem = {
  organizationInventoryId: number
  productCode: string
  name: string
  unit: string
  allowDecimalQuantity: boolean
  quantityStep: number
  stockQuantity: number
  priceCents: number | null
}

export async function loadOrderDeskCatalogue(scope: {
  organizationId: number
  branchId: number
}): Promise<OrderDeskCatalogueItem[]> {
  const rows = await db
    .select({
      organizationInventoryId: organizationInventory.id,
      customPrice: organizationInventory.customPrice,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      unit: globalProducts.unit,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
      stockQuantity: globalProducts.stockQuantity,
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
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ))
    .orderBy(asc(globalProducts.name))
    .limit(ORDER_DESK_CATALOGUE_LIMIT)

  const groupId = await resolveBranchGroupId(db, scope)
  const groupPriceByInventoryId = await loadGroupPriceOverrides(db, {
    organizationId: scope.organizationId,
    groupId,
    organizationInventoryIds: rows.map((row) => row.organizationInventoryId),
  })

  return rows.map((row) => ({
    organizationInventoryId: row.organizationInventoryId,
    productCode: row.productCode,
    name: row.name,
    unit: row.unit,
    allowDecimalQuantity: row.allowDecimalQuantity,
    quantityStep: Number(row.quantityStep),
    stockQuantity: Number(row.stockQuantity),
    priceCents: resolveEffectivePriceCents({
      groupPriceCents: groupPriceByInventoryId.get(row.organizationInventoryId),
      organizationPriceCents: row.customPrice,
      basePriceCents: row.basePrice,
    }),
  }))
}
