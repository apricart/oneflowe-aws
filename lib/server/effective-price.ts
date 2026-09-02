import "server-only"

import { and, eq, inArray, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { branches, globalProducts, groupInventoryPrices, organizationInventory } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * The one place the price of a product is decided.
 *
 * Prices are layered, and the layers are resolved in exactly this order:
 *
 *   1. the group override      `group_inventory_prices.custom_price_cents`
 *   2. the organization override `organization_inventory.custom_price_cents`
 *   3. the global base price     `global_products.base_price_cents`
 *
 * A tier that has no value is skipped, so a group without an override pays the
 * organization price and an organization without one pays the global price.
 * Setting a group price therefore never modifies, and never has to modify, the
 * organization price it overrides.
 *
 * Two rules make this safe to apply everywhere:
 *
 *  * **Nullish, never falsy.** A deliberate price of 0 is a price. The SQL
 *    helpers use COALESCE and the TypeScript helper uses `??` so both agree,
 *    and both agree with the write paths that were already written this way.
 *  * **The group tier needs a scope.** It applies only where the question
 *    "which group?" has one answer — a branch resolves to exactly one group via
 *    `branches.group_id`, and a Group Order Portal submission is authorized
 *    against exactly one group. Organization-wide screens have no such answer
 *    and must keep asking for the organization price, which is what
 *    `groupPriceJoinOn` returns when it is given no group.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * The join alias every query uses for the group tier.
 *
 * Shared so the generated SQL is identical everywhere and a reader can grep one
 * name. A query joins it at most once, so a single exported alias is enough.
 */
export const groupPriceTier = alias(groupInventoryPrices, "group_price_tier")

// Re-exported so every caller keeps a single import for "how is a price
// decided", while the rule itself lives in a database-free module that can be
// unit-tested directly — the same split `lib/price-visibility.ts` uses.
export {
  resolveEffectivePriceCents,
  resolveScopedOverrideCents,
  type PriceTiers,
} from "@/lib/price-ladder"

/**
 * Join condition for the group tier.
 *
 * Pass the group the read is scoped to, or null when it has none. With no group
 * the condition is `FALSE`, so the join contributes no row and the ladder
 * resolves to exactly what it resolved to before groups could be priced. This
 * keeps one query shape for both cases instead of two divergent ones.
 */
export function groupPriceJoinOn(
  scope: { organizationId: number; groupId: number | null | undefined },
): SQL {
  if (!scope.groupId) return sql`FALSE`
  return and(
    eq(groupPriceTier.organizationInventoryId, organizationInventory.id),
    eq(groupPriceTier.groupId, scope.groupId),
    // Re-assert the tenant on the join itself, the way every other group read
    // does, so a row that somehow referenced another tenant cannot price this
    // one's catalogue.
    eq(groupPriceTier.organizationId, scope.organizationId),
  ) as SQL
}

/**
 * Join condition for a query whose rows already carry their own branch, so the
 * group differs from row to row.
 *
 * The group is taken from `branches.group_id` per row rather than from a single
 * scope, which is what lets one listing mix branches of different groups and
 * still price every row correctly. The query must already join `branches`.
 * A branch in no group matches nothing and keeps the organization price.
 */
export function groupPriceJoinOnBranchGroup(): SQL {
  return and(
    eq(groupPriceTier.organizationInventoryId, organizationInventory.id),
    eq(groupPriceTier.groupId, branches.groupId),
    eq(groupPriceTier.organizationId, branches.organizationId),
  ) as SQL
}

/** `COALESCE(group, organization, base)` — the full ladder, for SELECT and ORDER BY. */
export function effectivePriceCentsSql(): SQL<number> {
  return sql<number>`COALESCE(${groupPriceTier.customPriceCents}, ${organizationInventory.customPrice}, ${globalProducts.basePrice})`
}

/** `COALESCE(group, organization)` — the override tier only; NULL means "inherits the base price". */
export function scopedOverrideCentsSql(): SQL<number | null> {
  return sql<number | null>`COALESCE(${groupPriceTier.customPriceCents}, ${organizationInventory.customPrice})`
}

/**
 * The group overrides for a set of catalogue items, as a map keyed by
 * `organization_inventory.id`.
 *
 * Used by the write paths, which read their prices row by row inside the
 * transaction that creates the order rather than through a joined query. Pass
 * the transaction so the override is read under the same snapshot as the rows
 * it prices. An empty map means "no group overrides", which resolves to the
 * organization price — never to no price.
 */
export async function loadGroupPriceOverrides(
  client: DbClient,
  scope: {
    organizationId: number
    groupId: number | null | undefined
    organizationInventoryIds: number[]
  },
): Promise<Map<number, number>> {
  if (!scope.groupId || scope.organizationInventoryIds.length === 0) return new Map()

  const rows = await client
    .select({
      organizationInventoryId: groupInventoryPrices.organizationInventoryId,
      customPriceCents: groupInventoryPrices.customPriceCents,
    })
    .from(groupInventoryPrices)
    .where(and(
      eq(groupInventoryPrices.groupId, scope.groupId),
      eq(groupInventoryPrices.organizationId, scope.organizationId),
      inArray(groupInventoryPrices.organizationInventoryId, scope.organizationInventoryIds),
    ))

  return new Map(rows.map((row) => [row.organizationInventoryId, row.customPriceCents]))
}

/**
 * The group a branch belongs to, or null when it belongs to none.
 *
 * Pinned to the organization so a branch id from another tenant resolves to no
 * group rather than to that tenant's group. Callers that already hold the
 * branch row should read `branches.groupId` from it instead of calling this.
 */
export async function resolveBranchGroupId(
  client: DbClient,
  scope: { branchId: number; organizationId: number },
): Promise<number | null> {
  const [row] = await client
    .select({ groupId: branches.groupId })
    .from(branches)
    .where(and(
      eq(branches.id, scope.branchId),
      eq(branches.organizationId, scope.organizationId),
    ))
    .limit(1)

  return row?.groupId ?? null
}
