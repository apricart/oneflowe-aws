/**
 * Which OneFlowe branch a legacy K-Electric order belongs to, and how to move
 * one that was filed at the wrong branch.
 *
 * The order importer used to key branches by normalised name. Legacy has
 * pairs of locations whose names differ only in punctuation or case —
 * `Johar |` / `Johar ||`, `society cluster` / `Society Cluster` — and both
 * halves of each pair normalise to the same string, so a `Map` keyed that way
 * keeps one twin and silently files the other twin's orders at it. Two
 * production orders sat at the wrong branch for that reason.
 *
 * Every legacy order names its location by id (`LocationID`), and every branch
 * `sync-ke.ts` created or pinned carries that id in `external_id`. So the id
 * is the join key; the name is only a fallback for a branch nobody has pinned
 * yet, and it is never allowed to match a branch that *is* pinned to a
 * different id — that is exactly the collision.
 *
 * `planOrderBranchRepair` is the pure half of `scripts/repair-ke-order-branches.ts`:
 * given the rows, it decides which orders move, who they are attributed to
 * afterwards, and what the affected branch/month budget rows must read.
 */

import { normalizeLegacyText } from "./ke-post-cutoff"

// ---------------------------------------------------------------------------
// Branch resolution
// ---------------------------------------------------------------------------

export interface CatalogueBranch {
  id: number
  name: string
  address: string | null
  externalSource: string | null
  externalId: string | null
}

export interface LegacyOrderLocation {
  legacyLocationId: number | null
  branchName: string
}

export type BranchResolution =
  | { kind: "PINNED"; branch: CatalogueBranch }
  | { kind: "BY_NAME"; branch: CatalogueBranch }
  | { kind: "NOT_FOUND"; detail: string }
  | { kind: "AMBIGUOUS"; detail: string }

export interface BranchIndex {
  readonly source: string
  readonly pinnedById: ReadonlyMap<string, CatalogueBranch[]>
  readonly unpinnedByName: ReadonlyMap<string, CatalogueBranch[]>
  readonly pinnedByName: ReadonlyMap<string, CatalogueBranch[]>
}

function isPinnedTo(branch: CatalogueBranch, source: string): boolean {
  return branch.externalSource === source && branch.externalId != null && branch.externalId !== ""
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key) ?? []
  bucket.push(value)
  map.set(key, bucket)
}

export function indexBranches(branches: readonly CatalogueBranch[], source: string): BranchIndex {
  const pinnedById = new Map<string, CatalogueBranch[]>()
  const unpinnedByName = new Map<string, CatalogueBranch[]>()
  const pinnedByName = new Map<string, CatalogueBranch[]>()
  for (const branch of branches) {
    const name = normalizeLegacyText(branch.name)
    if (isPinnedTo(branch, source)) {
      push(pinnedById, String(branch.externalId).trim(), branch)
      push(pinnedByName, name, branch)
    } else {
      push(unpinnedByName, name, branch)
    }
  }
  return { source, pinnedById, unpinnedByName, pinnedByName }
}

function describe(branches: readonly CatalogueBranch[]): string {
  return branches.map((branch) => `"${branch.name}" (${branch.id}, legacy ${branch.externalId ?? "unpinned"})`).join(", ")
}

/**
 * The pinned branch wins outright. Only when legacy names a location nobody
 * has pinned does the name count, and then only against unpinned branches: a
 * name that matches a branch pinned to a *different* id is the collision this
 * module exists to refuse.
 */
export function resolveLegacyBranch(index: BranchIndex, order: LegacyOrderLocation): BranchResolution {
  const locationId = order.legacyLocationId
  if (locationId != null && Number.isFinite(locationId)) {
    const pinned = index.pinnedById.get(String(locationId)) ?? []
    if (pinned.length === 1) return { kind: "PINNED", branch: pinned[0] }
    if (pinned.length > 1) {
      return { kind: "AMBIGUOUS", detail: `${pinned.length} branches are pinned to legacy location ${locationId}: ${describe(pinned)}` }
    }
  }

  const name = normalizeLegacyText(order.branchName)
  const unpinned = index.unpinnedByName.get(name) ?? []
  if (unpinned.length === 1) return { kind: "BY_NAME", branch: unpinned[0] }
  if (unpinned.length > 1) {
    return { kind: "AMBIGUOUS", detail: `${unpinned.length} unpinned branches are named "${order.branchName}": ${describe(unpinned)}` }
  }

  const collision = index.pinnedByName.get(name) ?? []
  const where = locationId == null ? "with no legacy location id" : `legacy location ${locationId}`
  if (collision.length > 0) {
    return {
      kind: "NOT_FOUND",
      detail: `no branch is pinned to ${where}; "${order.branchName}" matches only ${describe(collision)}, `
        + "which legacy says is a different location — run sync:ke to create and pin it",
    }
  }
  return { kind: "NOT_FOUND", detail: `no branch is pinned to ${where} and none is named "${order.branchName}"` }
}

// ---------------------------------------------------------------------------
// Repair planning
// ---------------------------------------------------------------------------

/**
 * Consumption rules shared with `scripts/backfill-ke-budget-spend.ts`; the two
 * must agree or a moved order is charged differently from its neighbours.
 */
export const SPENT_STATUSES: readonly string[] = ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"]
export const HELD_STATUSES: readonly string[] = ["PENDING", "APPROVED"]

/** An order as OneFlowe holds it, with what its import recorded about its origin. */
export interface PlacedOrder {
  orderId: number
  tid: string
  branchId: number
  status: string
  totalCents: number
  refundAmountCents: number | null
  /** `YYYY-MM` in Asia/Karachi — the budget month. */
  period: string
  createdByUserId: string | null
  /** Null for an order that was not imported, or whose payload predates `sourceHeader`. */
  legacyOrderId: number | null
  legacyLocationId: number | null
  legacyLocationName: string | null
}

/** An ORDER_PORTAL account at a K-Electric branch. */
export interface BranchAccount {
  userId: string
  username: string
  branchId: number
  isActive: boolean
  externalSource: string | null
  externalId: string | null
}

export interface BudgetLedgerRow {
  id: number
  branchId: number
  period: string
  amountAllocatedCents: number
  amountSpentCents: number
  amountHeldCents: number
  amountCreditedCents: number
}

export type CreatorRule = "SAME_PERSON_AT_BRANCH" | "KEPT_PERSONAL_ACCOUNT" | "BRANCH_ACCOUNT"

export interface OrderBranchMove {
  orderId: number
  tid: string
  legacyOrderId: number
  status: string
  period: string
  from: { branchId: number; branchName: string }
  to: { branchId: number; branchName: string; branchAddress: string | null }
  creator: { from: string | null; to: string; rule: CreatorRule }
  consumption: { kind: "SPENT" | "HELD" | "NONE"; cents: number }
}

export interface OrderBranchHold {
  orderId: number
  tid: string
  legacyOrderId: number
  reason: "TARGET_BRANCH_NOT_PINNED" | "TARGET_BRANCH_AMBIGUOUS" | "NO_ACCOUNT_AT_TARGET"
  detail: string
}

export interface BudgetLedgerChange {
  operation: "UPDATE" | "INSERT"
  budgetId: number | null
  branchId: number
  branchName: string
  period: string
  previous: { allocated: number; spent: number; held: number; credited: number }
  target: { allocated: number; spent: number; held: number; credited: number }
}

export interface OrderBranchRepairPlan {
  moves: OrderBranchMove[]
  holds: OrderBranchHold[]
  /** Imported orders whose payload carries no legacy location, so nothing can be checked. */
  unverifiableLegacyOrderIds: number[]
  budgetChanges: BudgetLedgerChange[]
}

export interface RepairInput {
  /** Every order of the organization — budget rows are recomputed from the whole set. */
  orders: readonly PlacedOrder[]
  branches: readonly CatalogueBranch[]
  accounts: readonly BranchAccount[]
  budgets: readonly BudgetLedgerRow[]
  source: string
}

function consumptionOf(order: Pick<PlacedOrder, "status" | "totalCents" | "refundAmountCents">) {
  const status = order.status.toUpperCase()
  const cents = Math.max(0, order.totalCents - (order.refundAmountCents ?? 0))
  if (SPENT_STATUSES.includes(status)) return { kind: "SPENT" as const, cents }
  if (HELD_STATUSES.includes(status)) return { kind: "HELD" as const, cents }
  return { kind: "NONE" as const, cents: 0 }
}

/**
 * Who the moved order is attributed to. Mirrors the importer: the same legacy
 * person at the new branch if they hold an account there; otherwise their
 * account elsewhere is kept, because the importer accepted that too. A creator
 * with no legacy identity was the *old* branch's fallback account — the order
 * was attributed to the branch, not to a person — so it follows the branch.
 */
function reattribute(
  creator: BranchAccount | undefined,
  target: CatalogueBranch,
  accountsByBranch: ReadonlyMap<number, BranchAccount[]>,
  accountsByIdentity: ReadonlyMap<string, BranchAccount[]>,
  source: string,
): { to: string; rule: CreatorRule } | { hold: string } {
  const preferActive = (candidates: BranchAccount[]) => {
    const active = candidates.filter((account) => account.isActive)
    const pool = active.length > 0 ? active : candidates
    return pool.slice().sort((a, b) => a.username.localeCompare(b.username))[0]
  }

  if (creator && creator.externalSource === source && creator.externalId) {
    const identity = creator.externalId.toLowerCase()
    const atTarget = (accountsByIdentity.get(identity) ?? []).filter((account) => account.branchId === target.id)
    if (atTarget.length > 0) return { to: preferActive(atTarget).userId, rule: "SAME_PERSON_AT_BRANCH" }
    return { to: creator.userId, rule: "KEPT_PERSONAL_ACCOUNT" }
  }

  const atTarget = accountsByBranch.get(target.id) ?? []
  if (atTarget.length === 0) {
    return { hold: `"${target.name}" (${target.id}) has no order-portal account to attribute the order to` }
  }
  return { to: preferActive(atTarget).userId, rule: "BRANCH_ACCOUNT" }
}

export function planOrderBranchRepair(input: RepairInput): OrderBranchRepairPlan {
  const index = indexBranches(input.branches, input.source)
  const branchById = new Map(input.branches.map((branch) => [branch.id, branch]))
  const accountById = new Map(input.accounts.map((account) => [account.userId, account]))
  const accountsByBranch = new Map<number, BranchAccount[]>()
  const accountsByIdentity = new Map<string, BranchAccount[]>()
  for (const account of input.accounts) {
    push(accountsByBranch, account.branchId, account)
    if (account.externalSource === input.source && account.externalId) {
      push(accountsByIdentity, account.externalId.toLowerCase(), account)
    }
  }

  const moves: OrderBranchMove[] = []
  const holds: OrderBranchHold[] = []
  const unverifiableLegacyOrderIds: number[] = []

  for (const order of [...input.orders].sort((a, b) => a.orderId - b.orderId)) {
    if (order.legacyOrderId == null) continue
    if (order.legacyLocationId == null) { unverifiableLegacyOrderIds.push(order.legacyOrderId); continue }

    const current = branchById.get(order.branchId)
    if (current && isPinnedTo(current, input.source) && String(current.externalId).trim() === String(order.legacyLocationId)) continue

    const base = { orderId: order.orderId, tid: order.tid, legacyOrderId: order.legacyOrderId }
    // Only the id may move an order. The name fallback exists for a first
    // import against an unpinned branch, not for second-guessing a placement.
    const pinned = index.pinnedById.get(String(order.legacyLocationId)) ?? []
    if (pinned.length === 0) {
      holds.push({ ...base, reason: "TARGET_BRANCH_NOT_PINNED",
        detail: `no branch is pinned to legacy location ${order.legacyLocationId} ("${order.legacyLocationName ?? ""}"); run sync:ke first` })
      continue
    }
    if (pinned.length > 1) {
      holds.push({ ...base, reason: "TARGET_BRANCH_AMBIGUOUS",
        detail: `${pinned.length} branches are pinned to legacy location ${order.legacyLocationId}: ${describe(pinned)}` })
      continue
    }
    const target = pinned[0]
    if (target.id === order.branchId) continue

    const creator = order.createdByUserId ? accountById.get(order.createdByUserId) : undefined
    const attribution = reattribute(creator, target, accountsByBranch, accountsByIdentity, input.source)
    if ("hold" in attribution) {
      holds.push({ ...base, reason: "NO_ACCOUNT_AT_TARGET", detail: attribution.hold })
      continue
    }

    moves.push({
      ...base,
      status: order.status,
      period: order.period,
      from: { branchId: order.branchId, branchName: current?.name ?? String(order.branchId) },
      to: { branchId: target.id, branchName: target.name, branchAddress: target.address },
      creator: { from: order.createdByUserId, to: attribution.to, rule: attribution.rule },
      consumption: consumptionOf(order),
    })
  }

  return { moves, holds, unverifiableLegacyOrderIds, budgetChanges: planBudgetChanges(input, moves, branchById) }
}

/**
 * Recompute every branch/month a move touches from the post-move order set,
 * exactly as the backfill computes it. Whole-key recomputation, not a delta:
 * it is what lets a source month whose only order left go back to zero, and
 * it is right whether or not the backfill had already charged the order.
 * Allocation is raised to keep `budgets_values_valid_ck` satisfied and never
 * lowered — the backfill's rule, kept so the two never fight.
 */
function planBudgetChanges(
  input: RepairInput,
  moves: readonly OrderBranchMove[],
  branchById: ReadonlyMap<number, CatalogueBranch>,
): BudgetLedgerChange[] {
  const targetBranchOf = new Map(moves.map((move) => [move.orderId, move.to.branchId]))
  const touched = new Set<string>()
  for (const move of moves) {
    touched.add(`${move.from.branchId}:${move.period}`)
    touched.add(`${move.to.branchId}:${move.period}`)
  }
  if (touched.size === 0) return []

  const consumption = new Map<string, { spent: number; held: number }>()
  for (const key of touched) consumption.set(key, { spent: 0, held: 0 })
  for (const order of input.orders) {
    const branchId = targetBranchOf.get(order.orderId) ?? order.branchId
    const bucket = consumption.get(`${branchId}:${order.period}`)
    if (!bucket) continue
    const { kind, cents } = consumptionOf(order)
    if (kind === "SPENT") bucket.spent += cents
    else if (kind === "HELD") bucket.held += cents
  }

  const budgetByKey = new Map(input.budgets.map((row) => [`${row.branchId}:${row.period}`, row]))
  const changes: BudgetLedgerChange[] = []
  for (const key of [...touched].sort()) {
    const [branchId, period] = key.split(":")
    const budget = budgetByKey.get(key)
    const { spent, held } = consumption.get(key)!
    const previous = {
      allocated: budget?.amountAllocatedCents ?? 0,
      spent: budget?.amountSpentCents ?? 0,
      held: budget?.amountHeldCents ?? 0,
      credited: budget?.amountCreditedCents ?? 0,
    }
    const allocated = Math.max(previous.allocated, spent + held - previous.credited, 0)
    const target = { allocated, spent, held, credited: previous.credited }
    if (budget && previous.allocated === target.allocated && previous.spent === target.spent && previous.held === target.held) continue
    changes.push({
      operation: budget ? "UPDATE" : "INSERT",
      budgetId: budget?.id ?? null,
      branchId: Number(branchId),
      branchName: branchById.get(Number(branchId))?.name ?? branchId,
      period,
      previous,
      target,
    })
  }
  return changes
}

export function summarizeOrderBranchRepair(plan: OrderBranchRepairPlan) {
  const byRule: Record<string, number> = {}
  for (const move of plan.moves) byRule[move.creator.rule] = (byRule[move.creator.rule] ?? 0) + 1
  const byReason: Record<string, number> = {}
  for (const hold of plan.holds) byReason[hold.reason] = (byReason[hold.reason] ?? 0) + 1
  return {
    moves: plan.moves.length,
    movedCents: plan.moves.reduce((sum, move) => sum + move.consumption.cents, 0),
    creatorRules: byRule,
    holds: plan.holds.length,
    holdReasons: byReason,
    unverifiable: plan.unverifiableLegacyOrderIds.length,
    budgetUpdates: plan.budgetChanges.filter((change) => change.operation === "UPDATE").length,
    budgetInserts: plan.budgetChanges.filter((change) => change.operation === "INSERT").length,
    allocationRaisedCents: plan.budgetChanges.reduce(
      (sum, change) => sum + (change.target.allocated - change.previous.allocated), 0),
  }
}
