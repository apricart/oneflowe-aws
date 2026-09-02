/**
 * The price ladder, with no database in sight.
 *
 * A product's price is layered, and the layers are resolved in exactly this
 * order:
 *
 *   1. the group override      `group_inventory_prices.custom_price_cents`
 *   2. the organization override `organization_inventory.custom_price_cents`
 *   3. the global base price     `global_products.base_price_cents`
 *
 * The rule lives here, free of `server-only` and of `@/lib/db`, so it can be
 * unit-tested directly. `lib/server/effective-price.ts` re-exports it alongside
 * the SQL and loader helpers that read the tiers out of the database, and every
 * caller imports it from there.
 *
 * One rule matters more than the rest: **nullish, never falsy**. A deliberate
 * price of 0 is a price and must not fall through to the tier below it. The SQL
 * side of this ladder is a COALESCE, which behaves the same way, so the two
 * cannot disagree.
 */

/**
 * Ceiling for any price, in cents.
 *
 * Every price column in the schema is a Postgres `integer`, so a value above
 * its range would be rejected by the database rather than by a message the user
 * can act on. Kept here, with no imports of its own, so the browser form and
 * the server schema enforce the same bound.
 */
export const MAX_PRICE_CENTS = 2_000_000_000

export type PriceTiers = {
  /** Group override, when the read had a group scope. */
  groupPriceCents?: number | null
  /** Organization override — `organization_inventory.custom_price_cents`. */
  organizationPriceCents?: number | null
  /** Global base price — `global_products.base_price_cents`. */
  basePriceCents?: number | null
}

function firstDefined(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return null
}

/**
 * The price a buyer at this scope actually pays, in cents.
 *
 * Returns null when no tier carries a price at all; callers keep their own
 * "pricing is unavailable" guard rather than having one imposed here, so the
 * message a user sees does not change.
 */
export function resolveEffectivePriceCents(tiers: PriceTiers): number | null {
  return firstDefined(tiers.groupPriceCents, tiers.organizationPriceCents, tiers.basePriceCents)
}

/**
 * The override in force at this scope, or null when the product falls all the
 * way through to the global base price.
 *
 * Branch-scoped list endpoints expose this as `customPrice`, which is what
 * their existing consumers already read as "the tenant's price for this
 * product, if it set one". Layering the group tier into that single field is
 * what keeps every display that renders `customPrice ?? basePrice` correct
 * without each of them having to learn about groups.
 */
export function resolveScopedOverrideCents(tiers: PriceTiers): number | null {
  return firstDefined(tiers.groupPriceCents, tiers.organizationPriceCents)
}
