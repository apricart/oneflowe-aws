import "server-only"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  branches,
  globalProducts,
  groupAuditLogs,
  groupInventoryPrices,
  groups,
  organizationInventory,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  groupsWithChangedPrice,
  planGroupPricePropagation,
  type PropagationMode,
  type PropagationPlan,
} from "@/lib/group-price-propagation"

/**
 * Reading the rows a propagation plan needs, and applying the plan.
 *
 * The planning rule itself lives in `lib/group-price-propagation.ts`, with no
 * database, so the confirmation screen and this module compute the same plan
 * from the same code. What the client sends is only the *mode* and the chosen
 * group ids — never a plan. The plan applied to the database is always rebuilt
 * here from rows read inside the transaction, so a stale or crafted preview can
 * never decide what a branch is charged.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export type PropagationContext = {
  item: {
    organizationInventoryId: number
    organizationId: number
    globalProductId: number
    name: string
    unit: string
    basePriceCents: number
    organizationPriceCents: number | null
  }
  groups: Array<{
    groupId: number
    name: string
    groupPriceCents: number | null
    branchCount: number
  }>
}

/**
 * The catalogue item and every group of its organization, with each group's own
 * price for it.
 *
 * Returns null when the item does not exist or has been deleted. Groups are
 * read for the item's own organization only, which is what keeps a propagation
 * inside one tenant no matter which id the caller supplied.
 */
export async function loadPropagationContext(
  client: DbClient,
  organizationInventoryId: number,
): Promise<PropagationContext | null> {
  const [item] = await client
    .select({
      organizationInventoryId: organizationInventory.id,
      organizationId: organizationInventory.organizationId,
      globalProductId: organizationInventory.globalProductId,
      name: sql<string>`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`,
      unit: globalProducts.unit,
      basePriceCents: globalProducts.basePrice,
      organizationPriceCents: organizationInventory.customPrice,
    })
    .from(organizationInventory)
    .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
    .where(and(
      eq(organizationInventory.id, organizationInventoryId),
      isNull(organizationInventory.deletedAt),
    ))
    .limit(1)

  if (!item) return null

  const groupRows = await client
    .select({
      groupId: groups.id,
      name: groups.name,
      groupPriceCents: groupInventoryPrices.customPriceCents,
      branchCount: sql<number>`count(distinct ${branches.id})::int`,
    })
    .from(groups)
    .leftJoin(groupInventoryPrices, and(
      eq(groupInventoryPrices.groupId, groups.id),
      eq(groupInventoryPrices.organizationInventoryId, organizationInventoryId),
      eq(groupInventoryPrices.organizationId, item.organizationId),
    ))
    .leftJoin(branches, and(
      eq(branches.groupId, groups.id),
      eq(branches.organizationId, item.organizationId),
    ))
    .where(and(
      eq(groups.organizationId, item.organizationId),
      sql`${groups.status} IS DISTINCT FROM 'deleted'`,
    ))
    .groupBy(groups.id, groups.name, groupInventoryPrices.customPriceCents)
    .orderBy(asc(groups.name))

  return { item, groups: groupRows }
}

/**
 * Rebuild the plan from rows read under `client`.
 *
 * `nextOrganizationPriceCents` is what the organization override is about to
 * become — `null` meaning it is being cleared back to the global base price.
 */
export function buildPropagationPlan(
  context: PropagationContext,
  input: {
    mode: PropagationMode
    selectedGroupIds?: number[]
    nextOrganizationPriceCents: number | null
  },
): PropagationPlan {
  return planGroupPricePropagation({
    mode: input.mode,
    selectedGroupIds: input.selectedGroupIds,
    basePriceCents: context.item.basePriceCents,
    currentOrganizationPriceCents: context.item.organizationPriceCents,
    nextOrganizationPriceCents: input.nextOrganizationPriceCents,
    groups: context.groups.map((group) => ({
      groupId: group.groupId,
      name: group.name,
      groupPriceCents: group.groupPriceCents,
    })),
  })
}

export type PropagationOutcome = {
  cleared: number
  pinned: number
  /** Groups whose price actually moved, for the response message. */
  changedGroupCount: number
}

/**
 * Apply a plan inside the caller's transaction.
 *
 * Must run in the same transaction as the organization price update it
 * accompanies: a cleared override without the new organization price, or a pin
 * without it, would each leave a branch on a price nobody chose.
 *
 * Writes one group audit entry describing the whole propagation, so the group's
 * price history shows why an override it never asked for appeared.
 */
export async function applyGroupPricePropagation(
  tx: DbClient,
  input: {
    context: PropagationContext
    plan: PropagationPlan
    performedByUserId: string
    performedByRole: string
  },
): Promise<PropagationOutcome> {
  const { context, plan } = input
  const changed = groupsWithChangedPrice(plan)

  if (plan.isNoOp) {
    return { cleared: 0, pinned: 0, changedGroupCount: changed.length }
  }

  if (plan.clearGroupIds.length > 0) {
    await tx.delete(groupInventoryPrices).where(and(
      eq(groupInventoryPrices.organizationInventoryId, context.item.organizationInventoryId),
      eq(groupInventoryPrices.organizationId, context.item.organizationId),
      inArray(groupInventoryPrices.groupId, plan.clearGroupIds),
    ))
  }

  if (plan.pins.length > 0) {
    await tx
      .insert(groupInventoryPrices)
      .values(plan.pins.map((pin) => ({
        groupId: pin.groupId,
        organizationId: context.item.organizationId,
        organizationInventoryId: context.item.organizationInventoryId,
        customPriceCents: pin.customPriceCents,
        updatedByUserId: input.performedByUserId,
      })))
      .onConflictDoUpdate({
        target: [groupInventoryPrices.groupId, groupInventoryPrices.organizationInventoryId],
        set: {
          customPriceCents: sql`excluded.custom_price_cents`,
          updatedByUserId: input.performedByUserId,
          updatedAt: new Date(),
        },
      })
  }

  await tx.insert(groupAuditLogs).values({
    organizationId: context.item.organizationId,
    // The propagation spans several groups, so it is filed against the
    // organization rather than any one of them.
    groupId: null,
    action: "PROPAGATE_ORGANIZATION_PRICE",
    performedByUserId: input.performedByUserId,
    performedByRole: input.performedByRole,
    metadata: {
      mode: plan.mode,
      organizationInventoryId: context.item.organizationInventoryId,
      productName: context.item.name,
      clearedGroupIds: plan.clearGroupIds,
      pinnedGroups: plan.pins,
      changedGroups: changed.map((action) => ({
        groupId: action.groupId,
        name: action.name,
        beforeCents: action.beforeCents,
        afterCents: action.afterCents,
      })),
    },
  })

  return {
    cleared: plan.clearGroupIds.length,
    pinned: plan.pins.length,
    changedGroupCount: changed.length,
  }
}
