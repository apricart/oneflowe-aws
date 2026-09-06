/**
 * Plan the K-Electric catalogue from the legacy logistics platform.
 *
 * WHY THIS EXISTS
 * ---------------
 * `import-ke-orders.ts` resolves every order line through
 * `legacy_product_mappings.normalized_name` -> `global_products`, and rejects
 * the whole order with `PRODUCT_NOT_FOUND` when there is no match. So on a
 * database with an empty catalogue no K-Electric order can be imported at all.
 * This module turns the legacy item list into the catalogue those orders need.
 *
 * THE SHAPE OF THE SOURCE
 * -----------------------
 * Legacy stores one item row **per product per location**: 11,412 rows are 142
 * distinct products across 135 locations. The branch a row belongs to is not on
 * the row — it is reached through `Item.CategoryID` -> `Category.LocationID`.
 * Collapsing those rows to one product per name is therefore the main job here.
 *
 * PRICE, AND THE ONE THING THIS CANNOT MIRROR
 * -------------------------------------------
 * Because legacy prices per location, a product can carry different prices at
 * different branches. OneFlowe has no per-branch price tier — prices resolve
 * group -> organization -> global (`lib/server/effective-price.ts`) — so a
 * price that varies *within* a group cannot be represented.
 *
 * In practice this is a rounding error rather than a policy: 64 of 11,412 rows
 * (0.56%) deviate, across 31 products, never more than 4 branches each, and the
 * deviations look like stale prices rather than intent. So the modal price
 * becomes the global base price and every deviation is reported as a
 * `PriceOutlier` for a person to settle. Nothing is silently flattened.
 *
 * WHAT THIS WILL NOT DO
 * ---------------------
 * It never changes the price of a product that already exists. A price already
 * in OneFlowe may have been set deliberately by a Super Admin, and the pricing
 * rules in CLAUDE.md are explicit that a change never reaches past a tier that
 * set its own. A legacy price that disagrees is reported as `priceDrift`, not
 * applied.
 */

import { normalizeProductName } from "./ke-electric"

/**
 * The join key between the two systems, re-exported rather than reimplemented.
 *
 * `import-ke-orders.ts` resolves every order line through this exact function
 * and the two must agree character for character: a normaliser that merely
 * looks equivalent splits one product in two, and the order line then matches
 * both — which the importer reports as PRODUCT_AMBIGUOUS and refuses.
 *
 * Not hypothetical. An earlier version here collapsed whitespace but left it
 * around brackets, so "Lipton Tea Bags ( 100 PCS )" and "Lipton Tea Bags
 * (100 PCS)" became two catalogue entries and nine orders would not import.
 */
export { normalizeProductName }

/** Legacy `GET /api/Item/0/null/{accountId}`. Only the fields we consume. */
export interface LegacyItem {
  ID: number
  CategoryID?: number | null
  CategoryName?: string | null
  SubCategoryName?: string | null
  Name?: string | null
  Description?: string | null
  Barcode?: string | null
  SKU?: string | null
  Price?: number | string | null
  Unit?: string | null
  StatusID?: number | null
}

/** Legacy `GET /api/Category/0/{accountId}`. Carries the location link. */
export interface LegacyCategory {
  ID: number
  LocationID?: number | null
  Name?: string | null
}

/**
 * One row of legacy `POST /api/ProductSummary/GetSummaryItemHistory`.
 *
 * This is a second, wider source of products than the item list. The item list
 * is what K-Electric sells *today* (142 names); the history is what they have
 * ever sold (160), and the difference is retired products that historical
 * orders still reference. Without them those orders cannot be imported at all —
 * `import-ke-orders.ts` refuses the whole order as PRODUCT_NOT_FOUND.
 */
export interface LegacyPriceHistoryRow {
  Date?: string | null
  ItemName?: string | null
  Location?: string | null
  LocationGroup?: string | null
  Price?: number | string | null
}

/** A row already in `legacy_product_mappings` for this organization. */
export interface CurrentProductMapping {
  normalizedName: string
  globalProductId: number
  organizationInventoryId: number
  /** Current OneFlowe base price, in cents, for drift reporting. */
  basePriceCents: number
}

export interface PriceOutlier {
  legacyLocationId: number | null
  priceCents: number
  /** How many legacy rows carry this price. */
  rows: number
}

export type ProductSkipReason = "NO_NAME" | "NO_PRICE"

export interface SkippedProduct {
  normalizedName: string
  sourceName: string
  reason: ProductSkipReason
  detail: string
}

export interface ProductCreate {
  normalizedName: string
  /** The legacy spelling, kept verbatim for `legacy_product_mappings.source_name`. */
  sourceName: string
  /** Legacy item ids, so a row can be traced back to its source. */
  sourceCodes: string[]
  basePriceCents: number
  unit: string
  categoryName: string | null
  description: string | null
  /** Distinct legacy locations stocking this product. */
  branchCount: number
  priceOutliers: PriceOutlier[]
  /**
   * Where the product came from. "item-list" is a product K-Electric still
   * sells; "price-history" is one they have retired but whose historical orders
   * we still need to import.
   */
  source: "item-list" | "price-history"
}

export interface ExistingProduct {
  normalizedName: string
  globalProductId: number
  organizationInventoryId: number
}

export interface PriceDrift {
  normalizedName: string
  globalProductId: number
  currentCents: number
  legacyModalCents: number
}

export interface ProductPlan {
  creates: ProductCreate[]
  existing: ExistingProduct[]
  priceDrift: PriceDrift[]
  skipped: SkippedProduct[]
  /** Distinct category names to ensure exist, in first-seen order. */
  categories: string[]
}

/**
 * Legacy prices are whole currency units; OneFlowe stores integer cents.
 *
 * `Math.round` over an epsilon-nudged product, identical to `centsFrom` in
 * `ke-orders-api.ts`, so a price imported here and a price on an imported order
 * line can never disagree by a cent through float drift.
 */
export function priceToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = typeof value === "number" ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round((parsed + Number.EPSILON) * 100)
}

/** The unit legacy states, or the schema default. */
function unitOf(items: readonly LegacyItem[]): string {
  for (const item of items) {
    const unit = String(item.Unit ?? "").trim()
    if (unit) return unit.slice(0, 64)
  }
  return "unit"
}

function firstNonEmpty(items: readonly LegacyItem[], pick: (item: LegacyItem) => unknown): string | null {
  for (const item of items) {
    const value = String(pick(item) ?? "").trim()
    if (value) return value
  }
  return null
}

/**
 * The price the most legacy rows agree on.
 *
 * Ties break toward the lower price: where legacy is genuinely ambiguous,
 * undercharging a branch is recoverable and overcharging one is not.
 */
function modalPriceCents(prices: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const price of prices) counts.set(price, (counts.get(price) ?? 0) + 1)
  let best = prices[0]
  let bestCount = -1
  for (const [price, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = price
      bestCount = count
    }
  }
  return best
}

/**
 * Group the per-location legacy rows into one product each, and say what would
 * be created, what already exists, and what disagrees.
 *
 * Pure: it reads no database and performs no I/O, so the whole of it is unit
 * testable and the dry run and the commit necessarily plan the same thing.
 */
export function planProducts(
  items: readonly LegacyItem[],
  categories: readonly LegacyCategory[],
  currentMappings: readonly CurrentProductMapping[],
  priceHistory: readonly LegacyPriceHistoryRow[] = [],
): ProductPlan {
  const locationOfCategory = new Map<number, number | null>(
    categories.map((category) => [category.ID, category.LocationID ?? null]),
  )
  const mappingByName = new Map(currentMappings.map((row) => [row.normalizedName, row]))

  // Group rows by the key both systems join on, keeping first-seen order so a
  // re-run plans in the same sequence and the digest is stable.
  const grouped = new Map<string, LegacyItem[]>()
  const skipped: SkippedProduct[] = []
  for (const item of items) {
    const normalized = normalizeProductName(item.Name)
    if (!normalized) {
      skipped.push({
        normalizedName: "",
        sourceName: String(item.Name ?? ""),
        reason: "NO_NAME",
        detail: `legacy item ${item.ID} has no name to join on`,
      })
      continue
    }
    const bucket = grouped.get(normalized)
    if (bucket) bucket.push(item)
    else grouped.set(normalized, [item])
  }

  const creates: ProductCreate[] = []
  const existing: ExistingProduct[] = []
  const priceDrift: PriceDrift[] = []
  const categoryNames: string[] = []
  const seenCategories = new Set<string>()

  for (const [normalizedName, rows] of grouped) {
    const priced = rows
      .map((row) => ({ row, cents: priceToCents(row.Price) }))
      .filter((entry): entry is { row: LegacyItem; cents: number } => entry.cents !== null && entry.cents > 0)

    const sourceName = String(rows[0].Name ?? "").trim()

    // A product legacy carries but never prices — "Toothbrush Colgate",
    // "Green Tea Material (Spices)". It is still created, at zero, because
    // historical orders reference it and without a catalogue entry the whole
    // order is refused as PRODUCT_NOT_FOUND. Zero is what legacy states, and it
    // costs nothing: an imported order line carries its own price, so the base
    // price here is never what the order was charged.
    const modal = priced.length === 0 ? 0 : modalPriceCents(priced.map((entry) => entry.cents))
    if (priced.length === 0) {
      skipped.push({
        normalizedName,
        sourceName,
        reason: "NO_PRICE",
        detail: `all ${rows.length} legacy rows carry a zero or absent price; created at zero`,
      })
    }

    const mapped = mappingByName.get(normalizedName)
    if (mapped) {
      existing.push({
        normalizedName,
        globalProductId: mapped.globalProductId,
        organizationInventoryId: mapped.organizationInventoryId,
      })
      // Reported, never applied: see the header note on the pricing rules.
      if (mapped.basePriceCents !== modal) {
        priceDrift.push({
          normalizedName,
          globalProductId: mapped.globalProductId,
          currentCents: mapped.basePriceCents,
          legacyModalCents: modal,
        })
      }
      continue
    }

    // Every price that is not the modal one, with the branch it belongs to.
    const outlierBuckets = new Map<string, PriceOutlier>()
    for (const entry of priced) {
      if (entry.cents === modal) continue
      const locationId = entry.row.CategoryID == null
        ? null
        : locationOfCategory.get(entry.row.CategoryID) ?? null
      const key = `${locationId}:${entry.cents}`
      const bucket = outlierBuckets.get(key)
      if (bucket) bucket.rows += 1
      else outlierBuckets.set(key, { legacyLocationId: locationId, priceCents: entry.cents, rows: 1 })
    }

    const branches = new Set<number>()
    for (const row of rows) {
      if (row.CategoryID == null) continue
      const locationId = locationOfCategory.get(row.CategoryID)
      if (typeof locationId === "number") branches.add(locationId)
    }

    const categoryName = firstNonEmpty(rows, (row) => row.CategoryName)
    if (categoryName && !seenCategories.has(categoryName)) {
      seenCategories.add(categoryName)
      categoryNames.push(categoryName)
    }

    creates.push({
      normalizedName,
      sourceName,
      sourceCodes: rows.map((row) => String(row.ID)),
      basePriceCents: modal,
      unit: unitOf(rows),
      categoryName,
      description: firstNonEmpty(rows, (row) => row.Description),
      branchCount: branches.size,
      priceOutliers: [...outlierBuckets.values()].sort((a, b) => b.rows - a.rows),
      source: "item-list",
    })
  }

  // Second pass: products the item list no longer carries but that the price
  // history — and therefore the order history — still references. Priced at the
  // most recent price the history records, because that is the only price we
  // have and a retired product has no current one to compare against.
  const planned = new Set([...creates.map((c) => c.normalizedName), ...existing.map((e) => e.normalizedName)])
  const historyByName = new Map<string, { date: string; cents: number }[]>()
  for (const row of priceHistory) {
    const normalized = normalizeProductName(row.ItemName)
    if (!normalized || planned.has(normalized)) continue
    const cents = priceToCents(row.Price)
    if (cents === null || cents === 0) continue
    const bucket = historyByName.get(normalized)
    const entry = { date: String(row.Date ?? ""), cents }
    if (bucket) bucket.push(entry)
    else historyByName.set(normalized, [entry])
  }

  for (const [normalizedName, entries] of historyByName) {
    if (mappingByName.has(normalizedName)) {
      const mapped = mappingByName.get(normalizedName)!
      existing.push({
        normalizedName,
        globalProductId: mapped.globalProductId,
        organizationInventoryId: mapped.organizationInventoryId,
      })
      continue
    }
    entries.sort((a, b) => a.date.localeCompare(b.date))
    const latest = entries[entries.length - 1]
    const sourceName = String(
      priceHistory.find((row) => normalizeProductName(row.ItemName) === normalizedName)?.ItemName ?? normalizedName,
    ).trim()
    creates.push({
      normalizedName,
      sourceName,
      sourceCodes: [`history:${normalizedName}`],
      basePriceCents: latest.cents,
      unit: "unit",
      categoryName: null,
      description: null,
      branchCount: 0,
      priceOutliers: [],
      source: "price-history",
    })
  }

  return { creates, existing, priceDrift, skipped, categories: categoryNames }
}

export interface ProductCounts {
  legacyRows: number
  distinctProducts: number
  toCreate: number
  alreadyMapped: number
  priceDrift: number
  skipped: number
  productsWithPriceOutliers: number
  outlierRows: number
}

export function summarizeProducts(plan: ProductPlan, legacyRowCount: number): ProductCounts {
  return {
    legacyRows: legacyRowCount,
    distinctProducts: plan.creates.length + plan.existing.length,
    toCreate: plan.creates.length,
    alreadyMapped: plan.existing.length,
    priceDrift: plan.priceDrift.length,
    skipped: plan.skipped.length,
    productsWithPriceOutliers: plan.creates.filter((entry) => entry.priceOutliers.length > 0).length,
    outlierRows: plan.creates.reduce(
      (sum, entry) => sum + entry.priceOutliers.reduce((n, outlier) => n + outlier.rows, 0),
      0,
    ),
  }
}
