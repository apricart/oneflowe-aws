import { type NextRequest } from "next/server"

import { and, eq, inArray, isNull, sql } from "drizzle-orm"

import { branchInventory, globalProducts, organizationInventory } from "@/db/schema"
import { error, ok } from "@/lib/api"
import { db } from "@/lib/db"
import {
  effectivePriceCentsSql,
  groupPriceJoinOn,
  groupPriceTier,
} from "@/lib/server/effective-price"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { loadScopedGroups } from "@/lib/server/group-order-portal"

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
 * Prices are resolved per group: a product can carry a group override on top of
 * the organization price, so this answer is only meaningful for one group at a
 * time. `groupId` is therefore required — an empty value selects the bucket of
 * branches that belong to no group, and an absent one is refused rather than
 * silently answered at organization prices. The requested group is authorized
 * against the caller's own assignments before a single row is read, and
 * visibility is still enforced: an item is returned only when it is assigned to
 * at least one branch of that group within the caller's scope.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const { searchParams } = new URL(req.url)

  const requestedIds = [...new Set(
    (searchParams.get("organizationInventoryIds") || "")
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

  if (!searchParams.has("groupId")) {
    return error("groupId is required so prices are resolved for the right group", 400)
  }
  const rawGroupId = (searchParams.get("groupId") || "").trim()
  // An empty value is the ungrouped bucket; anything non-numeric is rejected
  // rather than coerced into it.
  if (rawGroupId !== "" && !/^\d+$/.test(rawGroupId)) {
    return error("Invalid groupId", 400)
  }
  const groupId = rawGroupId === "" ? null : Number(rawGroupId)

  const scopedGroups = await loadScopedGroups(actor.scope.userId, actor.organizationId)
  const group = scopedGroups.find((candidate) => candidate.id === groupId)
  // Fail closed: a group the caller was not assigned, or an empty scope, yields
  // no prices rather than the organization's whole catalogue.
  if (!group) return ok({ items: [] })

  const branchIds = group.branches.map((branch) => branch.id)
  if (branchIds.length === 0) return ok({ items: [] })

  const items = await db
    .selectDistinct({
      organizationInventoryId: organizationInventory.id,
      name: sql<string>`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`,
      unit: globalProducts.unit,
      priceCents: effectivePriceCentsSql().mapWith(Number),
      // The quantity rules travel with the line so a resumed draft can still be
      // adjusted on the review step without the catalogue on screen.
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
    })
    .from(branchInventory)
    .innerJoin(organizationInventory, eq(branchInventory.organizationInventoryId, organizationInventory.id))
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .leftJoin(groupPriceTier, groupPriceJoinOn({
      organizationId: actor.organizationId,
      groupId: group.id,
    }))
    .where(and(
      inArray(organizationInventory.id, requestedIds),
      inArray(branchInventory.branchId, branchIds),
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
