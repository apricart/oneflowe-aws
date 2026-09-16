/**
 * Plan the restriction of one organization's catalogue to a hand-over item
 * list: every listed product active, every other product deactivated.
 *
 * WHAT "DEACTIVATED" MEANS HERE
 * -----------------------------
 * Exactly what the Organization Inventory page does when a Super Admin turns a
 * product off (`cascadeOrgStatusChange` in `lib/inventory-cascade.ts`): the
 * organization entry goes `is_active = false`, and every non-deleted branch
 * row of it goes `is_active = false, is_visible = false`. Nothing is deleted.
 * The product stays assigned, its price and its order history stay exactly as
 * they are, an order already placed can still be approved and delivered, and
 * turning it back on is one switch — or the reversal this module plans from
 * the before-states the run records.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never touches `global_products`, which is shared by every tenant, and it
 * never reaches another organization's rows: every entry it considers is one
 * of the target organization's own `organization_inventory` rows, and every
 * branch row it touches hangs off one of those. An entry that is already
 * inactive is left alone and counted. An entry the list names but that is
 * inactive is *activated* at the organization level only — its branch rows
 * are not woken, because which branches see it is a separate decision
 * (`ke-group-catalogue.ts`).
 *
 * Pure: reads no database and performs no I/O.
 */

import type { CurrentBranchAssignment } from "./ke-branch-catalogue"
import {
  resolveListProducts,
  type MappedProduct,
  type ProductWarning,
  type ResolvedProduct,
  type SkippedProduct,
  type WantedProduct,
} from "./ke-group-catalogue"

// ============================================================
// Shapes
// ============================================================

/** One non-deleted `organization_inventory` row of the organization. */
export interface OrganizationEntry {
  organizationInventoryId: number
  globalProductId: number
  productName: string
  isActive: boolean
}

/** A branch row of a deactivated entry, with the state it was in before the run. */
export interface BranchRowBefore {
  branchId: number
  isVisible: boolean
  isActive: boolean
}

export interface Deactivation {
  organizationInventoryId: number
  globalProductId: number
  productName: string
  /** Every non-deleted branch row, since the cascade touches them all. */
  branchRows: BranchRowBefore[]
}

export interface Activation {
  organizationInventoryId: number
  globalProductId: number
  productName: string
}

export interface CatalogueRestrictionPlan {
  /** The list, resolved. */
  kept: ResolvedProduct[]
  activations: Activation[]
  deactivations: Deactivation[]
  /** Entries outside the list that are already inactive; left alone. */
  alreadyInactive: OrganizationEntry[]
  skipped: SkippedProduct[]
  warnings: ProductWarning[]
}

// ============================================================
// Planning
// ============================================================

export function planCatalogueRestriction(
  wanted: readonly WantedProduct[],
  mapped: readonly MappedProduct[],
  entries: readonly OrganizationEntry[],
  branchRows: readonly CurrentBranchAssignment[],
): CatalogueRestrictionPlan {
  const { products, skipped, warnings } = resolveListProducts(wanted, mapped, { includeInactiveEntries: true })
  const keptIds = new Set(products.map((product) => product.organizationInventoryId))

  const rowsByEntry = new Map<number, BranchRowBefore[]>()
  for (const row of branchRows) {
    if (row.deleted) continue
    const list = rowsByEntry.get(row.organizationInventoryId) ?? []
    list.push({ branchId: row.branchId, isVisible: row.isVisible, isActive: row.isActive })
    rowsByEntry.set(row.organizationInventoryId, list)
  }

  const activations: Activation[] = products
    .filter((product) => !product.organizationInventoryActive)
    .map((product) => ({
      organizationInventoryId: product.organizationInventoryId,
      globalProductId: product.globalProductId,
      productName: product.productName,
    }))

  const deactivations: Deactivation[] = []
  const alreadyInactive: OrganizationEntry[] = []
  for (const entry of entries) {
    if (keptIds.has(entry.organizationInventoryId)) continue
    if (!entry.isActive) {
      alreadyInactive.push(entry)
      continue
    }
    deactivations.push({
      organizationInventoryId: entry.organizationInventoryId,
      globalProductId: entry.globalProductId,
      productName: entry.productName,
      branchRows: [...(rowsByEntry.get(entry.organizationInventoryId) ?? [])].sort((a, b) => a.branchId - b.branchId),
    })
  }

  return { kept: products, activations, deactivations, alreadyInactive, skipped, warnings }
}

function rowCode(row: { isVisible: boolean; isActive: boolean }): string {
  return `${row.isVisible ? "v" : "-"}${row.isActive ? "a" : "-"}`
}

/** The lines the digest is taken over: every write, and nothing that is not a write. */
export function catalogueRestrictionPlanLines(plan: CatalogueRestrictionPlan): string[] {
  return [
    ...plan.activations.map((entry) => `ACTIVATE ${entry.organizationInventoryId}`),
    ...plan.deactivations.map((entry) => `DEACTIVATE ${entry.organizationInventoryId}`),
    ...plan.deactivations.flatMap((entry) =>
      entry.branchRows.map((row) => `HIDE ${row.branchId} ${entry.organizationInventoryId} ${rowCode(row)}`)),
  ].sort()
}

export interface CatalogueRestrictionCounts {
  listLines: number
  kept: number
  activations: number
  deactivations: number
  branchRowsHidden: number
  branchRowsAlreadyHidden: number
  alreadyInactive: number
  skipped: number
  warnings: number
}

export function summarizeCatalogueRestriction(plan: CatalogueRestrictionPlan, listLines: number): CatalogueRestrictionCounts {
  const rows = plan.deactivations.flatMap((entry) => entry.branchRows)
  return {
    listLines,
    kept: plan.kept.length,
    activations: plan.activations.length,
    deactivations: plan.deactivations.length,
    branchRowsHidden: rows.filter((row) => row.isVisible || row.isActive).length,
    branchRowsAlreadyHidden: rows.filter((row) => !row.isVisible && !row.isActive).length,
    alreadyInactive: plan.alreadyInactive.length,
    skipped: plan.skipped.length,
    warnings: plan.warnings.length,
  }
}

// ============================================================
// Reversal
// ============================================================

export interface ReversalEntry {
  organizationInventoryId: number
  productName: string
  /** Rows to put back, each to the state the run recorded. */
  branchRows: BranchRowBefore[]
}

export interface ReversalSkip {
  organizationInventoryId: number
  productName: string
  branchId: number | null
  reason: "ALREADY_REVERSED" | "MOVED_SINCE"
  detail: string
}

export interface CatalogueRestrictionReversal {
  /** Entries to set active again, with their branch rows put back. */
  reactivations: ReversalEntry[]
  /** Entries the run activated, to set inactive again. */
  deactivations: Activation[]
  skipped: ReversalSkip[]
}

/**
 * Undo a committed run from what its report recorded. A deactivated entry is
 * set active again only while it is still inactive, and each of its branch
 * rows is put back only while it still holds what the cascade wrote (hidden
 * and inactive). Anything that moved since is reported, never overwritten.
 */
export function planCatalogueRestrictionReversal(
  committed: { activations: readonly Activation[]; deactivations: readonly Deactivation[] },
  entries: readonly OrganizationEntry[],
  branchRows: readonly CurrentBranchAssignment[],
): CatalogueRestrictionReversal {
  const entryById = new Map(entries.map((entry) => [entry.organizationInventoryId, entry]))
  const rowByKey = new Map(branchRows.map((row) => [`${row.branchId}:${row.organizationInventoryId}`, row]))
  const reversal: CatalogueRestrictionReversal = { reactivations: [], deactivations: [], skipped: [] }

  for (const entry of committed.deactivations) {
    const identity = { organizationInventoryId: entry.organizationInventoryId, productName: entry.productName }
    const current = entryById.get(entry.organizationInventoryId)
    if (!current) {
      reversal.skipped.push({ ...identity, branchId: null, reason: "MOVED_SINCE", detail: "the organization entry has been removed" })
      continue
    }
    if (current.isActive) {
      reversal.skipped.push({ ...identity, branchId: null, reason: "ALREADY_REVERSED", detail: "the organization entry is active again" })
      continue
    }
    const rows: BranchRowBefore[] = []
    for (const before of entry.branchRows) {
      // A row that was already hidden before the run has nothing to go back to.
      if (!before.isVisible && !before.isActive) continue
      const row = rowByKey.get(`${before.branchId}:${entry.organizationInventoryId}`)
      if (!row || row.deleted) {
        reversal.skipped.push({ ...identity, branchId: before.branchId, reason: "MOVED_SINCE", detail: "the branch row has been removed" })
        continue
      }
      if (row.isVisible || row.isActive) {
        reversal.skipped.push({ ...identity, branchId: before.branchId, reason: "MOVED_SINCE", detail: `the branch row is now ${rowCode(row)}, not the hidden, inactive row the run left` })
        continue
      }
      rows.push(before)
    }
    reversal.reactivations.push({ ...identity, branchRows: rows })
  }

  for (const entry of committed.activations) {
    const identity = { organizationInventoryId: entry.organizationInventoryId, productName: entry.productName }
    const current = entryById.get(entry.organizationInventoryId)
    if (!current) {
      reversal.skipped.push({ ...identity, branchId: null, reason: "MOVED_SINCE", detail: "the organization entry has been removed" })
    } else if (!current.isActive) {
      reversal.skipped.push({ ...identity, branchId: null, reason: "ALREADY_REVERSED", detail: "the organization entry is inactive again" })
    } else {
      reversal.deactivations.push(entry)
    }
  }

  return reversal
}

export function catalogueRestrictionReversalLines(reversal: CatalogueRestrictionReversal): string[] {
  return [
    ...reversal.reactivations.map((entry) => `REACTIVATE ${entry.organizationInventoryId}`),
    ...reversal.reactivations.flatMap((entry) =>
      entry.branchRows.map((row) => `UNHIDE ${row.branchId} ${entry.organizationInventoryId} -> ${rowCode(row)}`)),
    ...reversal.deactivations.map((entry) => `DEACTIVATE ${entry.organizationInventoryId}`),
  ].sort()
}
