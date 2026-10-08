/**
 * Who placed an imported K-Electric order, and how to give an order the
 * importer parked on a placeholder back to the person it belongs to.
 *
 * When `import-ke-orders.ts` (and the earlier one-off importers) found no
 * account for a legacy order taker, it attributed the order to a synthetic,
 * inactive `legacy_ke_*@historical.invalid` account. `sync:ke` later created
 * the person's real account, but their history stayed on the placeholder —
 * and the Order Portal shows a user only the orders they created, at their own
 * branch, so to them the order "is not in OneFlowe".
 *
 * `planOrderCreatorRepair` is the pure half of
 * `scripts/repair-ke-order-creators.ts`. It moves an order only when the data
 * proves who it belongs to (see `plans/OF-KE-reattribute-placeholder-orders.md`)
 * and holds every other order with the rule it failed. In particular it never
 * moves an order off a retired *person*: the seven reissued login codes mean a
 * retired account's orders may have been placed by either holder, and the
 * recorded name cannot say which.
 */

import { compareCodeUnits } from "../code-unit-order"
import { normalizeLegacyText } from "./ke-post-cutoff"

export const PLACEHOLDER_USERNAME_PREFIX = "legacy_ke_"
export const PLACEHOLDER_EMAIL_SUFFIX = "@historical.invalid"
export const ORDERING_ROLE = "ORDER_PORTAL"

export interface ImportedOrder {
  orderId: number
  tid: string
  branchId: number
  createdByUserId: string | null
  legacyOrderId: number
  legacyTakerId: number | null
  legacyTakerName: string | null
  legacyLocationId: number | null
}

export interface OrganizationAccount {
  userId: string
  username: string
  email: string
  fullName: string | null
  firstName: string | null
  lastName: string | null
  role: string | null
  branchId: number | null
  isActive: boolean
  isDeleted: boolean
  externalSource: string | null
  externalId: string | null
}

export interface PinnedBranch {
  id: number
  name: string
  externalSource: string | null
  externalId: string | null
}

export interface TakerMapping {
  id: number
  legacyOrderTakerId: number
  branchId: number
  userId: string
  isSynthetic: boolean
}

export interface CreatorRepairInput {
  orders: readonly ImportedOrder[]
  accounts: readonly OrganizationAccount[]
  branches: readonly PinnedBranch[]
  mappings: readonly TakerMapping[]
  /** The `external_source` both branches and mirrored accounts carry. */
  source: string
}

export type CreatorHoldReason =
  | "CREATOR_UNKNOWN"
  | "CREATOR_IS_A_PERSON"
  | "NO_LEGACY_TAKER"
  | "NO_LEGACY_NAME"
  | "TAKER_NAME_CHANGED"
  | "PLACEHOLDER_NAME_DIFFERS"
  | "BRANCH_NOT_AT_LEGACY_LOCATION"
  | "NO_ACCOUNT_AT_BRANCH"
  | "AMBIGUOUS_ACCOUNT"

export interface CreatorMove {
  orderId: number
  tid: string
  legacyOrderId: number
  branchId: number
  branchName: string
  legacyTakerId: number
  legacyTakerName: string
  from: { userId: string; username: string }
  to: { userId: string; username: string; externalId: string | null }
}

export interface CreatorHold {
  orderId: number
  tid: string
  legacyOrderId: number
  creatorUsername: string | null
  reason: CreatorHoldReason
  detail: string
}

export interface MappingChange {
  mappingId: number
  legacyOrderTakerId: number
  branchId: number
  from: { userId: string; isSynthetic: boolean }
  to: { userId: string; isSynthetic: false }
}

export interface CreatorRepairPlan {
  moves: CreatorMove[]
  mappingChanges: MappingChange[]
  holds: CreatorHold[]
}

/** Case, punctuation and spacing only — `Muhammad Tahir .Shafi` is `muhammad tahir shafi`. */
export function personKey(value: string | null | undefined): string {
  return normalizeLegacyText(value ?? "")
}

function accountNames(account: OrganizationAccount): Set<string> {
  const first = account.firstName?.trim() ?? ""
  const last = account.lastName?.trim() ?? ""
  return new Set([personKey(account.fullName), personKey(`${first} ${last}`)].filter((name) => name !== ""))
}

/**
 * A synthetic account the importer made for a taker it could not place.
 * Every test must hold: a real person never has all three.
 */
export function isPlaceholderAccount(account: OrganizationAccount): boolean {
  return account.username.startsWith(PLACEHOLDER_USERNAME_PREFIX)
    && account.email.toLowerCase().endsWith(PLACEHOLDER_EMAIL_SUFFIX)
    && account.externalSource == null
}

function needsRepair(account: OrganizationAccount | undefined): boolean {
  return !account || !account.isActive || account.isDeleted
}

function describeAccounts(accounts: readonly OrganizationAccount[], branches: ReadonlyMap<number, PinnedBranch>): string {
  return accounts
    .map((account) => {
      const branch = account.branchId == null ? null : branches.get(account.branchId)
      return `${account.username} at ${branch ? `"${branch.name}" (${branch.id})` : "no branch"}`
    })
    .join(", ")
}

export function planOrderCreatorRepair(input: CreatorRepairInput): CreatorRepairPlan {
  const accountById = new Map(input.accounts.map((account) => [account.userId, account]))
  const branchById = new Map(input.branches.map((branch) => [branch.id, branch]))

  // Every name each legacy login was recorded under, across all imported
  // orders, whoever they are attributed to now.
  const namesByTaker = new Map<number, Set<string>>()
  for (const order of input.orders) {
    const recorded = personKey(order.legacyTakerName)
    if (order.legacyTakerId == null || recorded === "") continue
    const names = namesByTaker.get(order.legacyTakerId) ?? new Set<string>()
    names.add(recorded)
    namesByTaker.set(order.legacyTakerId, names)
  }

  const orderingAccounts = input.accounts.filter((account) =>
    account.isActive && !account.isDeleted
    && account.role === ORDERING_ROLE
    && account.externalSource === input.source)

  const moves: CreatorMove[] = []
  const holds: CreatorHold[] = []

  for (const order of [...input.orders].sort((a, b) => a.orderId - b.orderId)) {
    const creator = order.createdByUserId == null ? undefined : accountById.get(order.createdByUserId)
    if (!needsRepair(creator)) continue

    const hold = (reason: CreatorHoldReason, detail: string) => {
      holds.push({
        orderId: order.orderId, tid: order.tid, legacyOrderId: order.legacyOrderId,
        creatorUsername: creator?.username ?? null, reason, detail,
      })
    }

    if (!creator) {
      hold("CREATOR_UNKNOWN", "the order names no creator, or one that is not in this organization")
      continue
    }
    if (!isPlaceholderAccount(creator)) {
      hold("CREATOR_IS_A_PERSON",
        `${creator.username} is a real account (${creator.externalSource ?? "no source"} ${creator.externalId ?? ""}`.trim()
        + "); a retired person's orders are history, and who placed them cannot be established from the import")
      continue
    }
    if (order.legacyTakerId == null) {
      hold("NO_LEGACY_TAKER", "the import recorded no legacy OrderTakerID")
      continue
    }
    const name = personKey(order.legacyTakerName)
    if (name === "") {
      hold("NO_LEGACY_NAME", "the import recorded no legacy order-taker name")
      continue
    }
    const takerNames = namesByTaker.get(order.legacyTakerId) ?? new Set<string>()
    if (takerNames.size !== 1) {
      hold("TAKER_NAME_CHANGED",
        `legacy login ${order.legacyTakerId} is recorded under ${takerNames.size} names `
        + `(${[...takerNames].sort(compareCodeUnits).join(" / ")}); it changed hands`)
      continue
    }
    if (!accountNames(creator).has(name)) {
      hold("PLACEHOLDER_NAME_DIFFERS",
        `${creator.username} is "${creator.fullName ?? ""}", the legacy order says "${order.legacyTakerName ?? ""}"`)
      continue
    }

    const branch = branchById.get(order.branchId)
    if (!branch || branch.externalSource !== input.source || order.legacyLocationId == null
      || String(branch.externalId ?? "").trim() !== String(order.legacyLocationId)) {
      hold("BRANCH_NOT_AT_LEGACY_LOCATION",
        `order is at branch ${order.branchId}${branch ? ` "${branch.name}" (legacy ${branch.externalId ?? "unpinned"})` : ""}, `
        + `legacy names location ${order.legacyLocationId ?? "none"}`)
      continue
    }

    const sameName = orderingAccounts.filter((account) => accountNames(account).has(name))
    const atBranch = sameName.filter((account) => account.branchId === order.branchId)
    if (atBranch.length === 0) {
      hold("NO_ACCOUNT_AT_BRANCH",
        `no active ${ORDERING_ROLE} account named "${order.legacyTakerName ?? ""}" at "${branch.name}" (${branch.id})`
        + (sameName.length > 0 ? `; the name exists elsewhere: ${describeAccounts(sameName, branchById)}` : ""))
      continue
    }
    if (atBranch.length > 1) {
      hold("AMBIGUOUS_ACCOUNT",
        `${atBranch.length} active ${ORDERING_ROLE} accounts named "${order.legacyTakerName ?? ""}" at "${branch.name}": `
        + describeAccounts(atBranch, branchById))
      continue
    }

    const target = atBranch[0]
    moves.push({
      orderId: order.orderId,
      tid: order.tid,
      legacyOrderId: order.legacyOrderId,
      branchId: order.branchId,
      branchName: branch.name,
      legacyTakerId: order.legacyTakerId,
      legacyTakerName: order.legacyTakerName ?? "",
      from: { userId: creator.userId, username: creator.username },
      to: { userId: target.userId, username: target.username, externalId: target.externalId },
    })
  }

  return { moves, mappingChanges: planMappingChanges(input, moves), holds }
}

/**
 * Point a placeholder's taker mapping at the person only when the whole
 * placeholder goes: every order it holds moves, all to one account, from one
 * taker at one branch. A placeholder that keeps any order keeps its mapping.
 */
function planMappingChanges(input: CreatorRepairInput, moves: readonly CreatorMove[]): MappingChange[] {
  const movesByPlaceholder = new Map<string, CreatorMove[]>()
  for (const move of moves) {
    const bucket = movesByPlaceholder.get(move.from.userId) ?? []
    bucket.push(move)
    movesByPlaceholder.set(move.from.userId, bucket)
  }

  const changes: MappingChange[] = []
  for (const [placeholderId, placeholderMoves] of movesByPlaceholder) {
    const held = input.orders.filter((order) => order.createdByUserId === placeholderId)
    if (held.length !== placeholderMoves.length) continue
    const targets = new Set(placeholderMoves.map((move) => move.to.userId))
    const pairs = new Set(placeholderMoves.map((move) => `${move.legacyTakerId}:${move.branchId}`))
    if (targets.size !== 1 || pairs.size !== 1) continue
    const [{ legacyTakerId, branchId, to }] = placeholderMoves

    for (const mapping of input.mappings) {
      if (mapping.userId !== placeholderId) continue
      if (mapping.legacyOrderTakerId !== legacyTakerId || mapping.branchId !== branchId) continue
      changes.push({
        mappingId: mapping.id,
        legacyOrderTakerId: mapping.legacyOrderTakerId,
        branchId: mapping.branchId,
        from: { userId: mapping.userId, isSynthetic: mapping.isSynthetic },
        to: { userId: to.userId, isSynthetic: false },
      })
    }
  }
  return changes.sort((a, b) => a.mappingId - b.mappingId)
}

export interface CreatorRepairSummary {
  moves: number
  people: number
  mappingChanges: number
  holds: number
  holdsByReason: Partial<Record<CreatorHoldReason, number>>
}

export function summarizeOrderCreatorRepair(plan: CreatorRepairPlan): CreatorRepairSummary {
  const holdsByReason: Partial<Record<CreatorHoldReason, number>> = {}
  for (const hold of plan.holds) holdsByReason[hold.reason] = (holdsByReason[hold.reason] ?? 0) + 1
  return {
    moves: plan.moves.length,
    people: new Set(plan.moves.map((move) => move.to.userId)).size,
    mappingChanges: plan.mappingChanges.length,
    holds: plan.holds.length,
    holdsByReason,
  }
}
