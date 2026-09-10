/**
 * Set K-Electric's **organization** price tier from the legacy platform.
 *
 * The instruction this implements: production's global product prices stay
 * exactly as they are; what K-Electric is charged comes from legacy.
 *
 * That maps onto the price ladder in `lib/server/effective-price.ts` without
 * bending it. The ladder is
 *
 *     group override -> organization override -> global base price
 *
 * so writing `organization_inventory.custom_price_cents` for organization 10
 * sets what K-Electric pays and touches nothing else. This is not merely a
 * convenient place to put it — it is the only safe one. Thirty-one of
 * K-Electric's products are shared `global_products` rows: 25 with K-E-Demo, 16
 * with UBL, 3 with EFU. Writing legacy's prices into `base_price_cents` would
 * have repriced two other tenants' live catalogues as a side effect.
 *
 * K-Electric holds no rows in `group_inventory_prices`, so every branch
 * inherits the organization price directly and nothing below this tier has to
 * be disturbed.
 *
 * Two rules, both of which exist because of the data:
 *
 *  1. **A product legacy never priced is left alone.** Two products
 *     ("Green Tea Material (Spices)", "Toothbrush Colgate") carry zero on every
 *     legacy row. Zero is a plausible price and a catastrophic one; the planner
 *     refuses to write it and reports the product instead.
 *  2. **A row already holding the right price is not rewritten.** Most of the
 *     148 rows already agree, and an UPDATE that changes nothing still moves
 *     `updated_at` and still has to be rolled back.
 */

import type { ProductPlan } from "./ke-products"

/** An `organization_inventory` row as it currently stands. */
export interface CurrentOrgInventory {
  organizationInventoryId: number
  globalProductId: number
  productName: string
  /** NULL means the row inherits the global base price. */
  customPriceCents: number | null
  globalBasePriceCents: number
  isActive: boolean
}

export interface OrgPriceChange {
  organizationInventoryId: number
  globalProductId: number
  productName: string
  fromCents: number | null
  toCents: number
  /** What the branch would have paid before this change, ladder resolved. */
  effectiveBeforeCents: number
}

export type OrgPriceSkipReason =
  /** Legacy never priced this product; writing zero would be a real change. */
  | "LEGACY_HAS_NO_PRICE"
  /** No legacy mapping for this inventory row at all. */
  | "NOT_IN_LEGACY"
  /** Two legacy sources disagree on this row's price. */
  | "AMBIGUOUS_LEGACY_PRICE"

export interface OrgPriceSkip {
  organizationInventoryId: number
  globalProductId: number
  productName: string
  reason: OrgPriceSkipReason
  detail: string
}

export interface OrgPricePlan {
  changes: OrgPriceChange[]
  skipped: OrgPriceSkip[]
  /** Rows whose organization price already equals legacy's. */
  unchanged: number
}

/**
 * Legacy's price per `organization_inventory` row.
 *
 * `ProductPlan.existing` can name the same inventory row twice — a product
 * present both in the item list and in the price history is pushed from both
 * branches of `planProducts`. Agreeing duplicates collapse; disagreeing ones
 * are ambiguous and must not be guessed at, so they are returned separately.
 */
export function legacyPriceByInventoryId(plan: ProductPlan): {
  prices: Map<number, number>
  ambiguous: Map<number, number[]>
} {
  const seen = new Map<number, number[]>()
  for (const row of plan.existing) {
    const bucket = seen.get(row.organizationInventoryId)
    if (bucket) bucket.push(row.legacyModalCents)
    else seen.set(row.organizationInventoryId, [row.legacyModalCents])
  }
  const prices = new Map<number, number>()
  const ambiguous = new Map<number, number[]>()
  for (const [id, values] of seen) {
    const distinct = [...new Set(values)]
    if (distinct.length === 1) prices.set(id, distinct[0])
    else ambiguous.set(id, distinct.sort((a, b) => a - b))
  }
  return { prices, ambiguous }
}

export function planOrganizationPrices(
  current: readonly CurrentOrgInventory[],
  plan: ProductPlan,
): OrgPricePlan {
  const { prices, ambiguous } = legacyPriceByInventoryId(plan)
  const changes: OrgPriceChange[] = []
  const skipped: OrgPriceSkip[] = []
  let unchanged = 0

  for (const row of [...current].sort((a, b) => a.organizationInventoryId - b.organizationInventoryId)) {
    const skip = (reason: OrgPriceSkipReason, detail: string) => skipped.push({
      organizationInventoryId: row.organizationInventoryId,
      globalProductId: row.globalProductId,
      productName: row.productName,
      reason,
      detail,
    })

    if (ambiguous.has(row.organizationInventoryId)) {
      skip("AMBIGUOUS_LEGACY_PRICE",
        `legacy sources disagree: ${ambiguous.get(row.organizationInventoryId)!.join(", ")} cents`)
      continue
    }

    const legacyCents = prices.get(row.organizationInventoryId)
    if (legacyCents === undefined) {
      skip("NOT_IN_LEGACY", "no legacy product maps to this inventory row")
      continue
    }

    // Rule 1 — zero is what legacy states for an unpriced product, and it is
    // not a price. See `SkippedProduct` with reason NO_PRICE in ke-products.ts.
    if (legacyCents <= 0) {
      skip("LEGACY_HAS_NO_PRICE", "every legacy row for this product carries a zero or absent price")
      continue
    }

    // Rule 2 — already correct.
    if (row.customPriceCents === legacyCents) { unchanged += 1; continue }

    changes.push({
      organizationInventoryId: row.organizationInventoryId,
      globalProductId: row.globalProductId,
      productName: row.productName,
      fromCents: row.customPriceCents,
      toCents: legacyCents,
      effectiveBeforeCents: row.customPriceCents ?? row.globalBasePriceCents,
    })
  }

  return { changes, skipped, unchanged }
}

export interface OrgPriceCounts {
  rowsConsidered: number
  toChange: number
  unchanged: number
  skipped: number
  /** Rows that inherit today and will start carrying an explicit price. */
  fromInherited: number
  bySkipReason: Record<string, number>
  /** What the change does to what a branch actually pays. */
  effectiveIncreases: number
  effectiveDecreases: number
  effectiveUnchanged: number
}

export function summarizeOrganizationPrices(plan: OrgPricePlan): OrgPriceCounts {
  const bySkipReason: Record<string, number> = {}
  for (const skip of plan.skipped) bySkipReason[skip.reason] = (bySkipReason[skip.reason] ?? 0) + 1

  let effectiveIncreases = 0, effectiveDecreases = 0, effectiveUnchanged = 0
  for (const change of plan.changes) {
    if (change.toCents > change.effectiveBeforeCents) effectiveIncreases += 1
    else if (change.toCents < change.effectiveBeforeCents) effectiveDecreases += 1
    else effectiveUnchanged += 1
  }

  return {
    rowsConsidered: plan.changes.length + plan.skipped.length + plan.unchanged,
    toChange: plan.changes.length,
    unchanged: plan.unchanged,
    skipped: plan.skipped.length,
    fromInherited: plan.changes.filter((c) => c.fromCents === null).length,
    bySkipReason,
    effectiveIncreases,
    effectiveDecreases,
    effectiveUnchanged,
  }
}
