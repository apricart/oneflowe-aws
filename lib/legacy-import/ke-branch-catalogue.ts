/**
 * Plan which products each K-Electric branch can order, from the legacy
 * per-location item list.
 *
 * WHAT THE SOURCE SAYS
 * --------------------
 * Legacy keeps one item row per product per location, and the location is
 * reached through `Item.CategoryID -> Category.LocationID`. That list is the
 * legacy branch assignment: a Distribution-group location carries ~63 items, an
 * Enabling-group one ~120, and the person ordering sees exactly that list.
 * `ke-products.ts` collapses the rows into one catalogue entry per product and
 * stops there; this module does the other half and says which branch may see
 * which entry.
 *
 * WHAT "VISIBLE IN THE SHOP" TAKES
 * --------------------------------
 * `GET /api/v1/branch/inventory` lists a product only when its
 * `branch_inventory` row is visible and active, its `organization_inventory`
 * row is active and its `global_products` row is active — and
 * `POST /api/v1/orders` refuses a line that exceeds `stock_quantity`. So a
 * product can be assigned everywhere and still be unorderable. The plan
 * therefore covers all four: activate the global product, activate the
 * organization's catalogue entry, grant stock to a zero-stock product, and
 * assign it to the branch.
 *
 * The global step is the one with reach beyond this tenant, so it is taken
 * only for a product the K-Electric import itself created (`legacyOwned`):
 * the legacy order import parked those `inactive` so historical order lines
 * would resolve without the product appearing anywhere. A product some other
 * hand retired is left retired and reported as `PRODUCT_RETIRED`. Activating
 * a global product does not by itself surface it in another tenant — that
 * still needs their own organization and branch rows — and the sync never
 * touches another tenant's rows.
 *
 * Stock needs a word. Legacy does not track it (`isInventoryItem: false`,
 * `CurrentStockLevel: null`) but OneFlowe decrements it on every order, so
 * every product legacy sells is given `stockLevel` units. On an ordinary run
 * only a zero-stock product is set — a figure an administrator typed, or one
 * that orders have worn down, is left alone. `resetStock` is the deliberate
 * exception: every product legacy sells goes to the level, whatever it holds.
 *
 * WHAT THIS WILL NOT DO
 * ---------------------
 * It never hides, deactivates or deletes. A product visible at a branch that
 * legacy does not list there is reported as an `extra` for a person to settle.
 * A product legacy has retired (not in the item list at all) is simply never
 * assigned, and stays exactly as it is.
 */

import { normalizeProductName } from "./ke-electric"
import type { LegacyCategory, LegacyItem } from "./ke-products"

// ============================================================
// Source and target row shapes
// ============================================================

/** One legacy-mapped catalogue entry, with the state the shop listing checks. */
export interface CurrentCatalogueEntry {
  normalizedName: string
  globalProductId: number
  organizationInventoryId: number
  /** `organization_inventory.is_active`, and not soft-deleted. */
  organizationInventoryActive: boolean
  /** `global_products.status = 'active'`, and not soft-deleted. */
  productActive: boolean
  /** Created by the K-Electric import, so the sync may change its global status. */
  legacyOwned: boolean
  stockQuantity: number
}

/** One `branch_inventory` row of the organization. */
export interface CurrentBranchAssignment {
  branchId: number
  organizationInventoryId: number
  isVisible: boolean
  isActive: boolean
  deleted: boolean
}

export interface ProductActivation {
  normalizedName: string
  globalProductId: number
  organizationInventoryId: number
  /** How many legacy locations sell it — the evidence it is a live product. */
  locations: number
}

/** A K-Electric-created global product parked `inactive` that legacy still sells. */
export interface GlobalActivation {
  normalizedName: string
  globalProductId: number
  locations: number
}

export interface StockChange {
  normalizedName: string
  globalProductId: number
  currentStock: number
  stockQuantity: number
}

export type AssignmentAction = "CREATE" | "RESTORE"

export interface BranchAssignment {
  branchId: number
  branchName: string
  legacyLocationId: number
  organizationInventoryId: number
  normalizedName: string
  action: AssignmentAction
}

/** Visible in OneFlowe, not on the legacy list for that location. */
export interface ExtraAssignment {
  branchId: number
  branchName: string
  organizationInventoryId: number
  normalizedName: string | null
}

export type AssignmentSkipReason =
  | "NO_LOCATION"
  | "LOCATION_NOT_PINNED"
  | "PRODUCT_NOT_MAPPED"
  | "PRODUCT_RETIRED"

export interface SkippedAssignment {
  legacyLocationId: number | null
  normalizedName: string
  reason: AssignmentSkipReason
  detail: string
}

export interface BranchCataloguePlan {
  globalActivations: GlobalActivation[]
  activations: ProductActivation[]
  stockChanges: StockChange[]
  assignments: BranchAssignment[]
  extras: ExtraAssignment[]
  skipped: SkippedAssignment[]
  unchanged: number
  /** Legacy locations that list at least one product. */
  legacyLocations: number
  /** Legacy (location, product) pairs considered. */
  legacyPairs: number
}

export interface BranchCatalogueOptions {
  /** Units every product legacy sells should hold. */
  stockLevel: number
  /** Set every product legacy sells to the level, not just the zero-stock ones. */
  resetStock: boolean
}

const LEGACY_ACTIVE_STATUS = 1

// ============================================================
// Planning
// ============================================================

/**
 * Pure: reads no database and performs no I/O, so the dry run and the commit
 * necessarily plan the same thing, and the whole of it is unit testable.
 *
 * `branchByLegacyId` comes from the branch pins — the only trustworthy link
 * between the two systems, never the branch name.
 */
export function planBranchCatalogue(
  items: readonly LegacyItem[],
  categories: readonly LegacyCategory[],
  branchByLegacyId: ReadonlyMap<number, { branchId: number; name: string }>,
  catalogue: readonly CurrentCatalogueEntry[],
  assignments: readonly CurrentBranchAssignment[],
  options: BranchCatalogueOptions,
): BranchCataloguePlan {
  if (!Number.isInteger(options.stockLevel) || options.stockLevel <= 0) {
    throw new Error(`stockLevel must be a positive integer, got ${String(options.stockLevel)}`)
  }

  const locationOfCategory = new Map<number, number | null>(
    categories.map((category) => [category.ID, category.LocationID ?? null]),
  )
  const entryByName = new Map(catalogue.map((entry) => [entry.normalizedName, entry]))
  const entryByInventoryId = new Map(catalogue.map((entry) => [entry.organizationInventoryId, entry]))
  const assignmentByKey = new Map(
    assignments.map((row) => [`${row.branchId}:${row.organizationInventoryId}`, row]),
  )

  const skipped: SkippedAssignment[] = []

  // Legacy location -> the products it lists, keyed the way both systems join.
  // First-seen order is kept so a re-run plans in the same sequence and the
  // digest is stable.
  const soldAt = new Map<number, Set<string>>()
  const locationsPerProduct = new Map<string, number>()
  for (const item of items) {
    if ((item.StatusID ?? LEGACY_ACTIVE_STATUS) !== LEGACY_ACTIVE_STATUS) continue
    const normalized = normalizeProductName(item.Name)
    if (!normalized) continue
    const locationId = item.CategoryID == null ? null : locationOfCategory.get(item.CategoryID) ?? null
    if (typeof locationId !== "number") {
      skipped.push({
        legacyLocationId: null,
        normalizedName: normalized,
        reason: "NO_LOCATION",
        detail: `legacy item ${item.ID} belongs to no location`,
      })
      continue
    }
    let products = soldAt.get(locationId)
    if (!products) {
      products = new Set()
      soldAt.set(locationId, products)
    }
    if (!products.has(normalized)) {
      products.add(normalized)
      locationsPerProduct.set(normalized, (locationsPerProduct.get(normalized) ?? 0) + 1)
    }
  }

  // Catalogue-level work: one entry per product legacy sells anywhere. Two
  // legacy names can map to one product ("millac tea whitener 850gm" and
  // "milac instant tea whitener (850gm)" both resolve to product 238), so the
  // work is keyed by the row it writes, not by the name that led to it — a
  // second write to the same row would find it already changed and refuse the
  // whole commit.
  const sellable = (entry: CurrentCatalogueEntry) => entry.productActive || entry.legacyOwned
  const globalActivations = new Map<number, GlobalActivation>()
  const activations = new Map<number, ProductActivation>()
  const stockChanges = new Map<number, StockChange>()
  for (const [normalizedName, locations] of locationsPerProduct) {
    const entry = entryByName.get(normalizedName)
    if (!entry || !sellable(entry)) continue
    if (!entry.productActive) {
      const existing = globalActivations.get(entry.globalProductId)
      if (existing) existing.locations += locations
      else globalActivations.set(entry.globalProductId, { normalizedName, globalProductId: entry.globalProductId, locations })
    }
    if (!entry.organizationInventoryActive) {
      const existing = activations.get(entry.organizationInventoryId)
      if (existing) existing.locations += locations
      else activations.set(entry.organizationInventoryId, {
        normalizedName,
        globalProductId: entry.globalProductId,
        organizationInventoryId: entry.organizationInventoryId,
        locations,
      })
    }
    const needsStock = options.resetStock ? entry.stockQuantity !== options.stockLevel : entry.stockQuantity <= 0
    if (needsStock && !stockChanges.has(entry.globalProductId)) {
      stockChanges.set(entry.globalProductId, {
        normalizedName,
        globalProductId: entry.globalProductId,
        currentStock: entry.stockQuantity,
        stockQuantity: options.stockLevel,
      })
    }
  }

  // Branch-level work: one row per legacy (location, product) pair.
  const planned: BranchAssignment[] = []
  const wanted = new Set<string>()
  let unchanged = 0
  for (const [locationId, products] of soldAt) {
    const branch = branchByLegacyId.get(locationId)
    for (const normalizedName of products) {
      if (!branch) {
        skipped.push({
          legacyLocationId: locationId,
          normalizedName,
          reason: "LOCATION_NOT_PINNED",
          detail: "no OneFlowe branch is pinned to this legacy location yet",
        })
        continue
      }
      const entry = entryByName.get(normalizedName)
      if (!entry) {
        skipped.push({
          legacyLocationId: locationId,
          normalizedName,
          reason: "PRODUCT_NOT_MAPPED",
          detail: "no catalogue entry is mapped to this legacy name; run the catalogue sync first",
        })
        continue
      }
      if (!sellable(entry)) {
        skipped.push({
          legacyLocationId: locationId,
          normalizedName,
          reason: "PRODUCT_RETIRED",
          detail: `global product ${entry.globalProductId} was retired in OneFlowe by someone other than the import`,
        })
        continue
      }
      // Two legacy names at one location can resolve to the same row (see the
      // catalogue-level note above); the row is planned once, and the upsert
      // would refuse a chunk that touched it twice.
      const key = `${branch.branchId}:${entry.organizationInventoryId}`
      if (wanted.has(key)) continue
      wanted.add(key)
      const current = assignmentByKey.get(key)
      if (current && current.isVisible && current.isActive && !current.deleted) {
        unchanged += 1
        continue
      }
      planned.push({
        branchId: branch.branchId,
        branchName: branch.name,
        legacyLocationId: locationId,
        organizationInventoryId: entry.organizationInventoryId,
        normalizedName,
        action: current ? "RESTORE" : "CREATE",
      })
    }
  }

  // Reported only: what OneFlowe shows at a branch that legacy does not list
  // there. Only branches legacy knows are compared, so a branch that exists in
  // OneFlowe alone is not reported as one big anomaly.
  const pinnedBranchIds = new Set([...branchByLegacyId.values()].map((branch) => branch.branchId))
  const branchNameById = new Map([...branchByLegacyId.values()].map((branch) => [branch.branchId, branch.name]))
  const extras: ExtraAssignment[] = []
  for (const row of assignments) {
    if (!row.isVisible || !row.isActive || row.deleted) continue
    if (!pinnedBranchIds.has(row.branchId)) continue
    const key = `${row.branchId}:${row.organizationInventoryId}`
    if (wanted.has(key)) continue
    extras.push({
      branchId: row.branchId,
      branchName: branchNameById.get(row.branchId) ?? String(row.branchId),
      organizationInventoryId: row.organizationInventoryId,
      normalizedName: entryByInventoryId.get(row.organizationInventoryId)?.normalizedName ?? null,
    })
  }

  return {
    globalActivations: [...globalActivations.values()],
    activations: [...activations.values()],
    stockChanges: [...stockChanges.values()],
    assignments: planned,
    extras,
    skipped,
    unchanged,
    legacyLocations: soldAt.size,
    legacyPairs: planned.length + unchanged + skipped.length,
  }
}

// ============================================================
// Reporting
// ============================================================

export interface BranchCatalogueCounts {
  legacyLocations: number
  legacyPairs: number
  globalActivations: number
  activations: number
  stockChanges: number
  toCreate: number
  toRestore: number
  unchanged: number
  extras: number
  skipped: number
  branchesTouched: number
}

export function summarizeBranchCatalogue(plan: BranchCataloguePlan): BranchCatalogueCounts {
  return {
    legacyLocations: plan.legacyLocations,
    legacyPairs: plan.legacyPairs,
    globalActivations: plan.globalActivations.length,
    activations: plan.activations.length,
    stockChanges: plan.stockChanges.length,
    toCreate: plan.assignments.filter((entry) => entry.action === "CREATE").length,
    toRestore: plan.assignments.filter((entry) => entry.action === "RESTORE").length,
    unchanged: plan.unchanged,
    extras: plan.extras.length,
    skipped: plan.skipped.length,
    branchesTouched: new Set(plan.assignments.map((entry) => entry.branchId)).size,
  }
}
