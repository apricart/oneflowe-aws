import { type NextRequest } from "next/server"
import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import { branchInventory, globalProducts, organizationInventory } from "@/db/schema"
import { error, ok } from "@/lib/api"
import { db } from "@/lib/db"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { loadScopedBranches } from "@/lib/server/group-order-portal"

export const dynamic = "force-dynamic"

const MAX_REQUESTED_IDS = 500

/**
 * Current name, unit, and unit price for inventory the caller already selected.
 *
 * A draft can be resumed days later and a long session can outlive a price
 * change, so the workspace refreshes these values before showing the review
 * preview. Without it the user could approve a total the server would not
 * charge — the server always re-prices from the database at submission, so the
 * preview is the only thing that can drift.
 *
 * Prices in this application live on `organization_inventory` / `global_products`
 * and are identical for every branch of a tenant, which is why this can answer
 * without a branch context. Visibility is still enforced: an item is returned
 * only when it is assigned to at least one branch in the caller's own scope.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const requestedIds = [...new Set(
    (new URL(req.url).searchParams.get("organizationInventoryIds") || "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => /^\d+$/.test(part))
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  )]

  if (requestedIds.length === 0) return ok({ items: [] })
  if (requestedIds.length > MAX_REQUESTED_IDS) {
    return error(`At most ${MAX_REQUESTED_IDS} products can be priced in one request`, 400)
  }

  const scopedBranches = await loadScopedBranches(actor.scope.userId, actor.organizationId)
  // Fail closed: no assigned branches means no inventory is visible to this user.
  if (scopedBranches.length === 0) return ok({ items: [] })

  const items = await db
    .selectDistinct({
      organizationInventoryId: organizationInventory.id,
      name: sql<string>`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`,
      unit: globalProducts.unit,
      priceCents: sql<number>`COALESCE(${organizationInventory.customPrice}, ${globalProducts.basePrice})`.mapWith(Number),
    })
    .from(branchInventory)
    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .where(and(
      inArray(organizationInventory.id, requestedIds),
      inArray(branchInventory.branchId, scopedBranches.map((branch) => branch.id)),
      eq(branchInventory.organizationId, actor.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      eq(organizationInventory.organizationId, actor.organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ))

  return ok({ items })
}
