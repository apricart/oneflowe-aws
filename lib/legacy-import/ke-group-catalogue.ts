/**
 * Plan which branch rows make one hand-over item list orderable at every
 * branch of chosen K-Electric groups.
 *
 * WHY THIS IS NOT THE SYNC
 * ------------------------
 * `ke-branch-catalogue.ts` mirrors the legacy per-location item list, and by
 * design assigns a product to a branch only where legacy lists it there. This
 * module goes past that on purpose: a person handed over a list and named the
 * groups, and every product on the list is to be orderable at every active
 * branch of those groups whatever legacy says. It therefore takes the list
 * and the groups as its input, never the legacy platform.
 *
 * WHAT IT WRITES, AND WHAT IT WILL NOT
 * ------------------------------------
 * The shop lists a product when its `branch_inventory` row is visible and
 * active, its organization entry is active, its global product is active and
 * it has stock. This plan creates the missing branch rows, restores the rows
 * some earlier hand left hidden, inactive or soft-deleted, and switches a
 * listed product's organization entry back on if it is off (that entry only —
 * which branches see it is exactly what the branch rows decide). With
 * `hideOthers`, it also hides, row by row at the named groups' branches,
 * every product that is live there but not on the list, so those branches
 * see the list and nothing else while every other branch keeps what it has.
 * Every row's before-state is recorded so the run can be reversed. It never
 * creates a product or an organization entry, never deletes, never changes a
 * price or a stock figure, and never touches a branch outside the named
 * groups. A product that would still not be orderable after the run —
 * retired, not assigned to the organization, out of stock — is reported, not
 * fixed.
 *
 * Names resolve the way the sync resolves them: through
 * `legacy_product_mappings` on `normalizeProductName`. A list name that maps
 * to nothing is refused, not guessed; two list names that map to the same
 * product (a spelling variant, a merged duplicate) plan that product once.
 *
 * Pure: reads no database and performs no I/O, so the dry run and the commit
 * necessarily plan the same thing, and the whole of it is unit testable.
 */

import { z } from "zod"

import { normalizeProductName } from "./ke-electric"
import type { CurrentBranchAssignment } from "./ke-branch-catalogue"

// ============================================================
// Source and target row shapes
// ============================================================

/** One line of the hand-over list, as typed. */
export interface WantedProduct {
  sourceName: string
}

/** One `legacy_product_mappings` row of the organization, with the state the shop checks. */
export interface MappedProduct {
  normalizedName: string
  globalProductId: number
  productName: string
  organizationInventoryId: number
  /** `organization_inventory.is_active`, and not soft-deleted. */
  organizationInventoryActive: boolean
  /** `global_products.status = 'active'`, and not soft-deleted. */
  productActive: boolean
  stockQuantity: number
}

/** One branch of a chosen group. */
export interface GroupBranch {
  groupId: number
  groupName: string
  branchId: number
  branchName: string
  active: boolean
}

/** The state a branch row was in before the run, kept so the run can be reversed. */
export interface BranchRowState {
  isVisible: boolean
  isActive: boolean
  deleted: boolean
}

export type GroupAssignmentAction = "CREATE" | "RESTORE"

export interface GroupAssignment {
  groupId: number
  groupName: string
  branchId: number
  branchName: string
  organizationInventoryId: number
  globalProductId: number
  normalizedName: string
  action: GroupAssignmentAction
  /** `null` for a CREATE: there was no row. */
  before: BranchRowState | null
}

/** One product the list resolved to, with every list line that led to it. */
export interface ResolvedProduct {
  normalizedName: string
  globalProductId: number
  productName: string
  organizationInventoryId: number
  /** Always true unless the caller asked for inactive entries to resolve too. */
  organizationInventoryActive: boolean
  sourceNames: string[]
}

export type ProductSkipReason =
  | "PRODUCT_NOT_MAPPED"
  | "PRODUCT_AMBIGUOUS"
  | "PRODUCT_RETIRED"
  | "ORGANIZATION_ENTRY_INACTIVE"

export interface SkippedProduct {
  sourceNames: string[]
  normalizedName: string
  reason: ProductSkipReason
  detail: string
}

export interface ProductWarning {
  normalizedName: string
  globalProductId: number
  reason: "ZERO_STOCK"
  detail: string
}

export interface GroupSummary {
  groupId: number
  groupName: string
  activeBranches: number
}

/** A listed product whose organization entry is off and is switched back on. */
export interface GroupActivation {
  organizationInventoryId: number
  globalProductId: number
  normalizedName: string
}

/** A live row at one of the named groups' branches for a product not on the list. */
export interface GroupHide {
  groupId: number
  groupName: string
  branchId: number
  branchName: string
  organizationInventoryId: number
  /** From the legacy mapping when there is one; the row may be a product legacy never named. */
  normalizedName: string | null
}

export interface GroupCatalogueOptions {
  /** Hide every live row at the named groups' branches whose product is not on the list. */
  hideOthers: boolean
}

export interface GroupCataloguePlan {
  products: ResolvedProduct[]
  groups: GroupSummary[]
  activations: GroupActivation[]
  assignments: GroupAssignment[]
  hides: GroupHide[]
  unchanged: number
  skipped: SkippedProduct[]
  warnings: ProductWarning[]
  inactiveBranches: GroupBranch[]
}

// ============================================================
// Planning
// ============================================================

function assignmentKey(branchId: number, organizationInventoryId: number): string {
  return `${branchId}:${organizationInventoryId}`
}

/** Visible, active and not soft-deleted — what the shop listing requires of a row. */
function isLive(row: CurrentBranchAssignment | undefined): boolean {
  return Boolean(row && row.isVisible && row.isActive && !row.deleted)
}

/**
 * Resolve every list line to a product, or a reason it cannot be. Shared with
 * the catalogue restriction, so both read one list the same way.
 */
export function resolveListProducts(
  wanted: readonly WantedProduct[],
  mapped: readonly MappedProduct[],
  options: { includeInactiveEntries: boolean } = { includeInactiveEntries: false },
): { products: ResolvedProduct[]; skipped: SkippedProduct[]; warnings: ProductWarning[] } {
  const mappingsByName = new Map<string, MappedProduct[]>()
  for (const mapping of mapped) {
    const list = mappingsByName.get(mapping.normalizedName) ?? []
    list.push(mapping)
    mappingsByName.set(mapping.normalizedName, list)
  }

  // List lines by their join key, in first-seen order so a re-run plans in
  // the same sequence and the digest is stable.
  const linesByName = new Map<string, string[]>()
  for (const line of wanted) {
    const normalized = normalizeProductName(line.sourceName)
    if (!normalized) continue
    const lines = linesByName.get(normalized) ?? []
    if (!lines.includes(line.sourceName)) lines.push(line.sourceName)
    linesByName.set(normalized, lines)
  }

  const products = new Map<number, ResolvedProduct>()
  const skipped: SkippedProduct[] = []
  const warned = new Set<number>()
  const warnings: ProductWarning[] = []

  for (const [normalizedName, sourceNames] of linesByName) {
    const mappings = mappingsByName.get(normalizedName) ?? []
    const targets = new Set(mappings.map((mapping) => mapping.globalProductId))
    if (targets.size === 0) {
      skipped.push({ sourceNames, normalizedName, reason: "PRODUCT_NOT_MAPPED", detail: "no legacy mapping resolves this name; it is not a K-Electric catalogue entry" })
      continue
    }
    if (targets.size > 1) {
      skipped.push({ sourceNames, normalizedName, reason: "PRODUCT_AMBIGUOUS", detail: `resolves to products ${[...targets].sort((a, b) => a - b).join(", ")}` })
      continue
    }
    const mapping = mappings[0]
    if (!mapping.productActive) {
      skipped.push({ sourceNames, normalizedName, reason: "PRODUCT_RETIRED", detail: `global product ${mapping.globalProductId} is not active` })
      continue
    }
    if (!mapping.organizationInventoryActive && !options.includeInactiveEntries) {
      skipped.push({ sourceNames, normalizedName, reason: "ORGANIZATION_ENTRY_INACTIVE", detail: `organization entry ${mapping.organizationInventoryId} of product ${mapping.globalProductId} is not active` })
      continue
    }

    // Two list names resolving to one product plan it once, under the name
    // that led there first, with every line recorded.
    const existing = products.get(mapping.organizationInventoryId)
    if (existing) {
      for (const name of sourceNames) if (!existing.sourceNames.includes(name)) existing.sourceNames.push(name)
    } else {
      products.set(mapping.organizationInventoryId, {
        normalizedName,
        globalProductId: mapping.globalProductId,
        productName: mapping.productName,
        organizationInventoryId: mapping.organizationInventoryId,
        organizationInventoryActive: mapping.organizationInventoryActive,
        sourceNames: [...sourceNames],
      })
    }
    if (mapping.stockQuantity <= 0 && !warned.has(mapping.globalProductId)) {
      warned.add(mapping.globalProductId)
      warnings.push({
        normalizedName,
        globalProductId: mapping.globalProductId,
        reason: "ZERO_STOCK",
        detail: "the row will exist but an order line is refused until the product is given stock (sync:ke --stock)",
      })
    }
  }

  return { products: [...products.values()], skipped, warnings }
}

/**
 * The plan: every resolved product at every active branch of the chosen
 * groups. `branches` is the chosen groups' branches only — the caller filters
 * by group, and this function never reaches past what it is given.
 */
export function planGroupCatalogue(
  wanted: readonly WantedProduct[],
  mapped: readonly MappedProduct[],
  branches: readonly GroupBranch[],
  assignments: readonly CurrentBranchAssignment[],
  options: GroupCatalogueOptions = { hideOthers: false },
): GroupCataloguePlan {
  const { products, skipped, warnings } = resolveListProducts(wanted, mapped, { includeInactiveEntries: true })
  const activations: GroupActivation[] = products
    .filter((product) => !product.organizationInventoryActive)
    .map((product) => ({
      organizationInventoryId: product.organizationInventoryId,
      globalProductId: product.globalProductId,
      normalizedName: product.normalizedName,
    }))

  const assignmentByKey = new Map(
    assignments.map((row) => [assignmentKey(row.branchId, row.organizationInventoryId), row]),
  )

  const groups = new Map<number, GroupSummary>()
  const inactiveBranches: GroupBranch[] = []
  const activeBranches: GroupBranch[] = []
  for (const branch of branches) {
    const group = groups.get(branch.groupId) ?? { groupId: branch.groupId, groupName: branch.groupName, activeBranches: 0 }
    groups.set(branch.groupId, group)
    if (!branch.active) {
      inactiveBranches.push(branch)
      continue
    }
    group.activeBranches += 1
    activeBranches.push(branch)
  }

  const planned: GroupAssignment[] = []
  let unchanged = 0
  for (const branch of activeBranches) {
    for (const product of products) {
      const current = assignmentByKey.get(assignmentKey(branch.branchId, product.organizationInventoryId))
      if (isLive(current)) {
        unchanged += 1
        continue
      }
      planned.push({
        groupId: branch.groupId,
        groupName: branch.groupName,
        branchId: branch.branchId,
        branchName: branch.branchName,
        organizationInventoryId: product.organizationInventoryId,
        globalProductId: product.globalProductId,
        normalizedName: product.normalizedName,
        action: current ? "RESTORE" : "CREATE",
        before: current ? { isVisible: current.isVisible, isActive: current.isActive, deleted: current.deleted } : null,
      })
    }
  }

  // Everything live at the named groups' active branches that the list does
  // not name. Only a fully live row is hidden: a row already hidden or
  // inactive is not on sale and is left as it is.
  const hides: GroupHide[] = []
  if (options.hideOthers) {
    const listed = new Set(products.map((product) => product.organizationInventoryId))
    const branchById = new Map(activeBranches.map((branch) => [branch.branchId, branch]))
    const nameByInventoryId = new Map(mapped.map((mapping) => [mapping.organizationInventoryId, mapping.normalizedName]))
    for (const row of assignments) {
      const branch = branchById.get(row.branchId)
      if (!branch || listed.has(row.organizationInventoryId) || !isLive(row)) continue
      hides.push({
        groupId: branch.groupId,
        groupName: branch.groupName,
        branchId: branch.branchId,
        branchName: branch.branchName,
        organizationInventoryId: row.organizationInventoryId,
        normalizedName: nameByInventoryId.get(row.organizationInventoryId) ?? null,
      })
    }
  }

  return {
    products,
    groups: [...groups.values()],
    activations,
    assignments: planned,
    hides,
    unchanged,
    skipped,
    warnings,
    inactiveBranches,
  }
}

function stateCode(state: BranchRowState): string {
  return `${state.isVisible ? "v" : "-"}${state.isActive ? "a" : "-"}${state.deleted ? "d" : "-"}`
}

/** The lines the plan digest is taken over: every write, and nothing that is not a write. */
export function groupCataloguePlanLines(plan: GroupCataloguePlan): string[] {
  return [
    ...plan.activations.map((entry) => `ACTIVATE ${entry.organizationInventoryId}`),
    ...plan.assignments.map((entry) => entry.action === "CREATE"
      ? `CREATE ${entry.branchId} ${entry.organizationInventoryId}`
      : `RESTORE ${entry.branchId} ${entry.organizationInventoryId} ${stateCode(entry.before as BranchRowState)}`),
    ...plan.hides.map((entry) => `HIDE ${entry.branchId} ${entry.organizationInventoryId}`),
  ].sort()
}

export interface GroupCatalogueCounts {
  listLines: number
  products: number
  groups: number
  activeBranches: number
  inactiveBranches: number
  activations: number
  toCreate: number
  toRestore: number
  toHide: number
  unchanged: number
  skipped: number
  warnings: number
  branchesTouched: number
}

export function summarizeGroupCatalogue(plan: GroupCataloguePlan, listLines: number): GroupCatalogueCounts {
  return {
    listLines,
    products: plan.products.length,
    groups: plan.groups.length,
    activeBranches: plan.groups.reduce((sum, group) => sum + group.activeBranches, 0),
    inactiveBranches: plan.inactiveBranches.length,
    activations: plan.activations.length,
    toCreate: plan.assignments.filter((entry) => entry.action === "CREATE").length,
    toRestore: plan.assignments.filter((entry) => entry.action === "RESTORE").length,
    toHide: plan.hides.length,
    unchanged: plan.unchanged,
    skipped: plan.skipped.length,
    warnings: plan.warnings.length,
    branchesTouched: new Set([...plan.assignments, ...plan.hides].map((entry) => entry.branchId)).size,
  }
}

// ============================================================
// Reversal
// ============================================================

const positiveId = z.number().int().positive()
const rowState = z.object({ isVisible: z.boolean(), isActive: z.boolean(), deleted: z.boolean() })

/**
 * The commit report a run writes, validated at the boundary before a reversal
 * plans anything from it: a dry-run report, or one from another script, is
 * refused with the reason.
 */
export const groupCatalogueCommitReportSchema = z.object({
  importer: z.literal("assign-ke-group-catalogue", { error: "the report must be from assign-ke-group-catalogue" }),
  mode: z.literal("COMMIT", { error: "the report must be from a committed run, not a dry run" }),
  generatedAt: z.string(),
  planDigest: z.string().min(1),
  organization: z.object({ id: positiveId, code: z.string().min(1), name: z.string().min(1) }),
  plan: z.object({
    // Absent from reports written before activations and hides existed.
    activations: z.array(z.object({
      organizationInventoryId: positiveId,
      globalProductId: positiveId,
      normalizedName: z.string(),
    })).default([]),
    assignments: z.array(z.object({
      groupId: positiveId,
      groupName: z.string(),
      branchId: positiveId,
      branchName: z.string(),
      organizationInventoryId: positiveId,
      globalProductId: positiveId,
      normalizedName: z.string(),
      action: z.enum(["CREATE", "RESTORE"]),
      before: rowState.nullable(),
    }).refine((entry) => (entry.action === "CREATE") === (entry.before === null), {
      message: "a CREATE carries no before-state and a RESTORE carries one",
    })),
    hides: z.array(z.object({
      groupId: positiveId,
      groupName: z.string(),
      branchId: positiveId,
      branchName: z.string(),
      organizationInventoryId: positiveId,
      normalizedName: z.string().nullable(),
    })).default([]),
  }),
})

export type GroupCatalogueCommitReport = z.infer<typeof groupCatalogueCommitReportSchema>

export function parseGroupCatalogueCommitReport(raw: unknown): GroupCatalogueCommitReport {
  const result = groupCatalogueCommitReportSchema.safeParse(raw)
  if (!result.success) throw new Error(`Not a committed group-catalogue report:\n${z.prettifyError(result.error)}`)
  return result.data
}

export interface ReversalDelete {
  branchId: number
  branchName: string
  organizationInventoryId: number
  normalizedName: string
}

export interface ReversalRestore {
  branchId: number
  branchName: string
  organizationInventoryId: number
  normalizedName: string
  /** The state the row is put back to. */
  to: BranchRowState
}

/** A row the run hid, to be shown again. */
export interface ReversalUnhide {
  branchId: number
  branchName: string
  organizationInventoryId: number
  normalizedName: string | null
}

export interface ReversalSkip {
  /** `null` for an organization entry rather than a branch row. */
  branchId: number | null
  branchName: string | null
  organizationInventoryId: number
  normalizedName: string | null
  reason: "ALREADY_REVERSED" | "MOVED_SINCE"
  detail: string
}

export interface GroupCatalogueReversal {
  deletes: ReversalDelete[]
  restores: ReversalRestore[]
  unhides: ReversalUnhide[]
  /** Organization entries the run switched on, to be switched off again. */
  deactivations: GroupActivation[]
  skipped: ReversalSkip[]
}

/** The current state of an organization entry, for reversing an activation. */
export interface CurrentOrganizationEntry {
  organizationInventoryId: number
  isActive: boolean
}

/**
 * Undo a committed run from the rows its report recorded. A created row is
 * deleted and a restored row put back to its before-state — in each case only
 * while the row still holds what the run wrote (visible, active, not
 * deleted). A row that no longer does was changed by someone since, and is
 * reported rather than overwritten.
 */
export function planGroupCatalogueReversal(
  committed: {
    activations: readonly GroupActivation[]
    assignments: readonly GroupAssignment[]
    hides: readonly GroupHide[]
  },
  assignments: readonly CurrentBranchAssignment[],
  entries: readonly CurrentOrganizationEntry[] = [],
): GroupCatalogueReversal {
  const assignmentByKey = new Map(
    assignments.map((row) => [assignmentKey(row.branchId, row.organizationInventoryId), row]),
  )
  const entryById = new Map(entries.map((entry) => [entry.organizationInventoryId, entry]))
  const reversal: GroupCatalogueReversal = { deletes: [], restores: [], unhides: [], deactivations: [], skipped: [] }
  const seen = new Set<string>()

  for (const entry of committed.hides) {
    const key = assignmentKey(entry.branchId, entry.organizationInventoryId)
    if (seen.has(key)) continue
    seen.add(key)
    const identity = {
      branchId: entry.branchId,
      branchName: entry.branchName,
      organizationInventoryId: entry.organizationInventoryId,
      normalizedName: entry.normalizedName,
    }
    const current = assignmentByKey.get(key)
    if (!current || current.deleted) {
      reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: "the row the run hid has been removed" })
    } else if (isLive(current)) {
      reversal.skipped.push({ ...identity, reason: "ALREADY_REVERSED", detail: "the row is visible and active again" })
    } else if (current.isVisible || current.isActive) {
      reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: `the row is now ${stateCode(current)}, not the hidden, inactive row the run left` })
    } else {
      reversal.unhides.push(identity)
    }
  }

  for (const entry of committed.activations) {
    const identity = { branchId: null, branchName: null, organizationInventoryId: entry.organizationInventoryId, normalizedName: entry.normalizedName }
    const current = entryById.get(entry.organizationInventoryId)
    if (!current) {
      reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: "the organization entry has been removed" })
    } else if (!current.isActive) {
      reversal.skipped.push({ ...identity, reason: "ALREADY_REVERSED", detail: "the organization entry is off again" })
    } else {
      reversal.deactivations.push(entry)
    }
  }

  for (const entry of committed.assignments) {
    const key = assignmentKey(entry.branchId, entry.organizationInventoryId)
    if (seen.has(key)) continue
    seen.add(key)
    const identity = {
      branchId: entry.branchId,
      branchName: entry.branchName,
      organizationInventoryId: entry.organizationInventoryId,
      normalizedName: entry.normalizedName,
    }
    const current = assignmentByKey.get(key)

    if (entry.action === "CREATE") {
      if (!current) {
        reversal.skipped.push({ ...identity, reason: "ALREADY_REVERSED", detail: "the row the run created no longer exists" })
      } else if (!isLive(current)) {
        reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: `the row is now ${stateCode(current)}, not the visible, active row the run created` })
      } else {
        reversal.deletes.push(identity)
      }
      continue
    }

    const before = entry.before as BranchRowState
    if (!current) {
      reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: "the row the run restored has been removed" })
    } else if (current.isVisible === before.isVisible && current.isActive === before.isActive && current.deleted === before.deleted) {
      reversal.skipped.push({ ...identity, reason: "ALREADY_REVERSED", detail: `the row is already back to ${stateCode(before)}` })
    } else if (!isLive(current)) {
      reversal.skipped.push({ ...identity, reason: "MOVED_SINCE", detail: `the row is now ${stateCode(current)}, not the visible, active row the run left` })
    } else {
      reversal.restores.push({ ...identity, to: before })
    }
  }

  return reversal
}

export function groupCatalogueReversalLines(reversal: GroupCatalogueReversal): string[] {
  return [
    ...reversal.deletes.map((entry) => `DELETE ${entry.branchId} ${entry.organizationInventoryId}`),
    ...reversal.restores.map((entry) => `RESTORE ${entry.branchId} ${entry.organizationInventoryId} -> ${stateCode(entry.to)}`),
    ...reversal.unhides.map((entry) => `UNHIDE ${entry.branchId} ${entry.organizationInventoryId}`),
    ...reversal.deactivations.map((entry) => `DEACTIVATE ${entry.organizationInventoryId}`),
  ].sort()
}
