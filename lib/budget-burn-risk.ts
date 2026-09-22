import { growthPct, safeDivide } from "@/lib/executive-analytics"
import { isOrderCreatorRole } from "@/lib/group-order-visibility"

/**
 * Budget-burn risk — the "Users to review" watchlist.
 *
 * Every figure here is derived from orders that already exist; nothing is
 * enforced, blocked or charged differently because of a score. The module is
 * deliberately free of the database, the session and React so the calendar
 * rule, every signal and every guard can be unit-tested on its own, and so a
 * reader can find the exact number behind every chip rather than inferring it
 * from a colour. See `plans/OF-BUDGET-BURN-watchlist.md`.
 *
 * ── Business definitions this module encodes ───────────────────────────────
 *
 *   Spend        SUM(total_cents - refund_amount_cents) over revenue-eligible
 *                orders (FULFILLED, PARTIAL, PARTIALLY_FULFILLED, APPROVED) —
 *                the Center's "Procurement Value", and exactly what the
 *                existing drill-down lists.
 *   Pending      the same sum over PENDING orders: money the branch cannot
 *                spend elsewhere while the approval is open.
 *   Consumed     Spend + Pending — the budget ledger's own "spent + held".
 *   Share        a requester's Consumed over the branch's Consumed by *every*
 *                creator, because that is what the shared pot actually lost.
 *   MoM          Consumed this month against the prior month to the same day.
 *   Peers        **branches, not colleagues.** A branch's own budget
 *                utilization (Consumed over its total budget) compared
 *                against the *median* utilization of the other branches in
 *                scope, never the mean, because a mean is dragged up by the
 *                very outlier being scored. Every requester listed at the
 *                same branch shares this figure — it says the branch's own
 *                spend against its budget looks unusual next to other
 *                branches, not that this particular person does next to
 *                their colleagues.
 *   Late surge   the share of a requester's Consumed that landed in the last
 *                `lateSurgeDays` of the window.
 *
 * A "requester" is a person holding one of `ORDER_CREATOR_ROLES`. Any role may
 * create an order, and every creator's orders count toward the branch's
 * consumption; only requesters are *listed*, because the question is about
 * the people who order through the portals.
 */

// ── Who may read the list ──────────────────────────────────────────────────

/**
 * Deliberately narrower than `EXECUTIVE_ANALYTICS_ROLES`. The list names
 * employees with a score, so it starts with the two tenant-wide administrative
 * roles; the multi-branch approver is a later decision, and Branch Admin has
 * no executive analytics surface at all (its prices may be hidden by the
 * tenant, and the drill-down does not redact).
 */
export const BUDGET_BURN_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const
export type BudgetBurnRole = (typeof BUDGET_BURN_ROLES)[number]

export function isBudgetBurnRole(role: unknown): role is BudgetBurnRole {
  return typeof role === "string" && (BUDGET_BURN_ROLES as readonly string[]).includes(role)
}

// ── Thresholds ─────────────────────────────────────────────────────────────

/**
 * Presentation thresholds, not business rules. Money in integer cents.
 * Exported so the UI prints the exact figure behind every chip.
 */
export const BUDGET_BURN_THRESHOLDS = {
  /** Share of the branch's consumption at or above which one person is "high share". */
  highSharePct: 40,
  /** Below this branch consumption a share is noise: ₨20,000. */
  highShareMinBranchCents: 2_000_000,
  /** A share needs at least this many active requesters at the branch to mean anything. */
  highShareMinRequesters: 2,
  /** Month-over-month growth at or above which a requester "spiked". */
  momSpikePct: 15,
  /** Prior-month consumption below this is too small a baseline: ₨5,000. */
  momMinBaselineCents: 500_000,
  /** At or above this far past the peer branch median a branch is "above peers". */
  abovePeersPct: 50,
  /** Fewer other branches with a computable budget utilization than this and there is no peer figure. */
  branchPeersMinCount: 2,
  /** The window at the end of the month that counts as "late". */
  lateSurgeDays: 7,
  /** Share of the month's consumption inside that window at or above which it is a surge. */
  lateSurgePct: 50,
  /** Earlier than this in the month the late window is most of the month, so no surge is read. */
  lateSurgeMinElapsedDays: 14,
  /** A surge on less than this is not worth a look: ₨5,000. */
  lateSurgeMinConsumedCents: 500_000,
  /** Pending at or above this share of the branch's total budget is "high held". */
  highHeldPctOfBudget: 20,
  /** Used instead when the branch has no budget row: ₨25,000. */
  highHeldFloorCents: 2_500_000,
  /** Orders REJECTED by an approver this month at or above which the chip shows. */
  rejectedOrdersMin: 3,
  /** Score at or above which a requester is listed. */
  flagScore: 4,
} as const

export type BudgetBurnThresholds = typeof BUDGET_BURN_THRESHOLDS

export const BUDGET_BURN_POINTS = {
  high_share: 3,
  mom_spike: 2,
  above_peers: 2,
  late_surge: 2,
  high_held: 1,
  rejected_orders: 1,
} as const

export type BudgetBurnReason = keyof typeof BUDGET_BURN_POINTS

/** The order reasons are reported in — heaviest first, so a chip row reads as the score does. */
export const BUDGET_BURN_REASONS = Object.keys(BUDGET_BURN_POINTS) as BudgetBurnReason[]

export const BUDGET_BURN_REASON_LABELS: Record<BudgetBurnReason, string> = {
  high_share: "High share",
  mom_spike: "+MoM",
  above_peers: "Above peers",
  late_surge: "Late surge",
  high_held: "High held",
  rejected_orders: "Rejected orders",
}

// ── Bounds ─────────────────────────────────────────────────────────────────

export const BUDGET_BURN_DEFAULT_ROWS = 25
export const BUDGET_BURN_MAX_ROWS = 100
/** How far back a month may be asked for. */
export const BUDGET_BURN_MAX_MONTHS_BACK = 24
/** Safety cap on aggregate rows read from the database; never a page. */
export const BUDGET_BURN_QUERY_ROW_CAP = 2000

export function clampWatchlistLimit(value: unknown): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return BUDGET_BURN_DEFAULT_ROWS
  return Math.min(parsed, BUDGET_BURN_MAX_ROWS)
}

// ── The calendar ───────────────────────────────────────────────────────────

const APP_TIME_ZONE = "Asia/Karachi"
const APP_TIME_ZONE_OFFSET = "+05:00"
const DAY_MS = 24 * 60 * 60 * 1000

export const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY_PATTERN.test(value)
}

const appDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** The calendar date of an instant in the application timezone. */
export function appDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = appDateFormatter.formatToParts(date)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: read("year"), month: read("month"), day: read("day") }
}

const pad = (value: number) => String(value).padStart(2, "0")

export function monthKeyOf(year: number, month: number): string {
  return `${year}-${pad(month)}`
}

/** The current calendar month in the application timezone, as `YYYY-MM`. */
export function currentAppMonth(now: Date): string {
  const parts = appDateParts(now)
  return monthKeyOf(parts.year, parts.month)
}

function parseMonthKey(month: string): { year: number; month: number } {
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
}

function startOfAppDay(year: number, month: number, day: number): Date {
  return new Date(`${monthKeyOf(year, month)}-${pad(day)}T00:00:00.000${APP_TIME_ZONE_OFFSET}`)
}

function endOfAppDay(year: number, month: number, day: number): Date {
  return new Date(`${monthKeyOf(year, month)}-${pad(day)}T23:59:59.999${APP_TIME_ZONE_OFFSET}`)
}

/** Whole months between two `YYYY-MM` keys, positive when `later` is after `earlier`. */
export function monthsBetween(earlier: string, later: string): number {
  const a = parseMonthKey(earlier)
  const b = parseMonthKey(later)
  return (b.year - a.year) * 12 + (b.month - a.month)
}

export type MonthWindows = {
  month: string
  current: {
    start: Date
    /** The end of the month, or `now` while the month is still open. */
    end: Date
    complete: boolean
    /** Calendar days of the month that have begun, in the application timezone. */
    elapsedDays: number
    daysInMonth: number
  }
  /** The prior month to the same elapsed day, or the whole prior month once this one is complete. */
  prior: { month: string; start: Date; end: Date }
  /** The last `lateSurgeDays` of the current window, never before the month began. */
  recent: { start: Date; end: Date }
}

export type MonthWindowError = { ok: false; error: string }

/**
 * The windows a month's watchlist is computed over, in Asia/Karachi.
 *
 * The Center's `previousWindow` — the equal-length window immediately before
 * the selection — is the wrong comparison here: for 1–20 September it yields
 * 12–31 August, setting the prior month's end-of-month rush against a quiet
 * month start. The watchlist compares like with like: this month to date
 * against the prior month to the same day (clamped to a shorter month), or
 * whole month against whole month once the month is over. The prior window
 * runs to the *end* of that day, so it is always a whole number of days.
 */
export function monthWindows(
  month: string,
  now: Date,
  thresholds: Pick<BudgetBurnThresholds, "lateSurgeDays"> = BUDGET_BURN_THRESHOLDS,
): MonthWindows | MonthWindowError {
  if (!isMonthKey(month)) return { ok: false, error: "month must be YYYY-MM" }
  if (Number.isNaN(now.getTime())) return { ok: false, error: "Invalid clock" }

  const { year, month: monthNumber } = parseMonthKey(month)
  const days = daysInMonth(year, monthNumber)
  const monthStart = startOfAppDay(year, monthNumber, 1)
  const monthEnd = endOfAppDay(year, monthNumber, days)

  if (monthStart.getTime() > now.getTime()) return { ok: false, error: "month is in the future" }
  if (monthsBetween(month, currentAppMonth(now)) > BUDGET_BURN_MAX_MONTHS_BACK) {
    return { ok: false, error: `month is more than ${BUDGET_BURN_MAX_MONTHS_BACK} months back` }
  }

  const complete = now.getTime() > monthEnd.getTime()
  const elapsedDays = complete ? days : appDateParts(now).day
  const currentEnd = complete ? monthEnd : now

  const prior = previousMonth(year, monthNumber)
  const priorDays = daysInMonth(prior.year, prior.month)
  const priorEndDay = complete ? priorDays : Math.min(elapsedDays, priorDays)

  const recentStart = new Date(Math.max(
    monthStart.getTime(),
    currentEnd.getTime() - thresholds.lateSurgeDays * DAY_MS,
  ))

  return {
    month,
    current: { start: monthStart, end: currentEnd, complete, elapsedDays, daysInMonth: days },
    prior: {
      month: monthKeyOf(prior.year, prior.month),
      start: startOfAppDay(prior.year, prior.month, 1),
      end: endOfAppDay(prior.year, prior.month, priorEndDay),
    },
    recent: { start: recentStart, end: currentEnd },
  }
}

export function isMonthWindowError(value: MonthWindows | MonthWindowError): value is MonthWindowError {
  return "ok" in value && value.ok === false
}

/** `YYYY-MM-DD` in the application timezone, for the drill-down's date-only filters. */
export function appDayKey(date: Date): string {
  const parts = appDateParts(date)
  return `${monthKeyOf(parts.year, parts.month)}-${pad(parts.day)}`
}

// ── Inputs ─────────────────────────────────────────────────────────────────

/** One creator at one branch for one window. Money in integer cents. */
export type CreatorMonth = {
  userId: string
  branchId: number
  /** The creator's role name, e.g. ORDER_PORTAL. Decides listing, never counting. */
  role: string
  spendCents: number
  pendingCents: number
  orderCount: number
  pendingOrderCount: number
  /** Orders REJECTED by an approver. A self-cancel is not evidence of anything and is not counted. */
  rejectedOrderCount: number
  /** Consumed inside the recent window. */
  recentConsumedCents: number
}

export type BranchMonth = {
  branchId: number
  /** Consumed by every creator this month. */
  consumedCents: number
  /** The part of that from creators who are not requesters, so the shares can be audited. */
  otherCreatorsConsumedCents: number
  /** Requesters with any consumption this month. */
  activeRequesterCount: number
  totalBudgetCents: number
  remainingCents: number
}

export function consumedCents(row: Pick<CreatorMonth, "spendCents" | "pendingCents">): number {
  return Math.max(0, row.spendCents) + Math.max(0, row.pendingCents)
}

/** A branch's own consumption as a share of its budget, or null with no budget to divide by. */
export function branchUtilizationPct(branch: Pick<BranchMonth, "consumedCents" | "totalBudgetCents">): number | null {
  return branch.totalBudgetCents > 0 ? (branch.consumedCents / branch.totalBudgetCents) * 100 : null
}

export function creatorKey(row: Pick<CreatorMonth, "userId" | "branchId">): string {
  return `${row.userId}:${row.branchId}`
}

/**
 * Every creator's rows, split into the requesters to list and the per-branch
 * denominators they are measured against. One read, two uses, so the share a
 * row reports and the branch total beside it cannot disagree.
 */
export function summarizeCreators(
  rows: readonly CreatorMonth[],
  budgets: ReadonlyMap<number, { totalBudgetCents: number; remainingCents: number }> = new Map(),
): { requesters: CreatorMonth[]; branches: Map<number, BranchMonth> } {
  const branches = new Map<number, BranchMonth>()
  const requesters: CreatorMonth[] = []

  for (const row of rows) {
    const consumed = consumedCents(row)
    const listed = isOrderCreatorRole(row.role)
    const branch = branches.get(row.branchId) ?? {
      branchId: row.branchId,
      consumedCents: 0,
      otherCreatorsConsumedCents: 0,
      activeRequesterCount: 0,
      totalBudgetCents: budgets.get(row.branchId)?.totalBudgetCents ?? 0,
      remainingCents: budgets.get(row.branchId)?.remainingCents ?? 0,
    }
    branch.consumedCents += consumed
    if (listed) {
      requesters.push(row)
      if (consumed > 0) branch.activeRequesterCount += 1
    } else {
      branch.otherCreatorsConsumedCents += consumed
    }
    branches.set(row.branchId, branch)
  }

  // A budgeted branch with no orders this month is still a real peer at 0%
  // utilization. Without these rows, the branch comparison would quietly
  // drop exactly the quiet branches that give the median its meaning.
  for (const [branchId, budget] of budgets) {
    if (branches.has(branchId) || budget.totalBudgetCents <= 0) continue
    branches.set(branchId, {
      branchId,
      consumedCents: 0,
      otherCreatorsConsumedCents: 0,
      activeRequesterCount: 0,
      totalBudgetCents: budget.totalBudgetCents,
      remainingCents: budget.remainingCents,
    })
  }

  return { requesters, branches }
}

// ── Scoring ────────────────────────────────────────────────────────────────

export type WatchlistMetrics = {
  spendCents: number
  pendingCents: number
  consumedCents: number
  shareOfBranchPct: number
  /** null when the prior month had nothing to grow from. */
  momPct: number | null
  priorConsumedCents: number
  /** This branch's own consumption as a share of its budget; null with no budget. */
  branchUtilizationPct: number | null
  /** null when there are fewer than `branchPeersMinCount` other branches with a computable utilization. */
  vsPeerPct: number | null
  peerBranchMedianUtilizationPct: number | null
  /** null when the month is too young for a late window to mean anything. */
  recentSharePct: number | null
  orderCount: number
  pendingOrderCount: number
  rejectedOrderCount: number
}

export type WatchlistRow = {
  userId: string
  branchId: number
  score: number
  reasons: BudgetBurnReason[]
  metrics: WatchlistMetrics
}

/** The median budget utilization of the peer branches, or null when there are too few to call a median. */
export function peerBranchMedianUtilizationPct(
  peerBranches: readonly Pick<BranchMonth, "consumedCents" | "totalBudgetCents">[],
  thresholds: Pick<BudgetBurnThresholds, "branchPeersMinCount"> = BUDGET_BURN_THRESHOLDS,
): number | null {
  const values = peerBranches
    .map(branchUtilizationPct)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  if (values.length < thresholds.branchPeersMinCount) return null
  const middle = Math.floor(values.length / 2)
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle]
}

function highHeldFloor(branch: BranchMonth, thresholds: BudgetBurnThresholds): number {
  return branch.totalBudgetCents > 0
    ? (branch.totalBudgetCents * thresholds.highHeldPctOfBudget) / 100
    : thresholds.highHeldFloorCents
}

/**
 * One requester at one branch, scored against the branch, their peers and
 * their own prior month. Every guard that suppresses a signal is here, next to
 * the signal it guards.
 */
export function scoreRequester(input: {
  row: CreatorMonth
  branch: BranchMonth
  /** The other branches in scope this month — never including `branch`. */
  peerBranches: readonly BranchMonth[]
  priorConsumedCents: number
  elapsedDays: number
  thresholds?: BudgetBurnThresholds
}): WatchlistRow {
  const t = input.thresholds ?? BUDGET_BURN_THRESHOLDS
  const { row, branch, peerBranches } = input
  const consumed = consumedCents(row)
  const prior = Math.max(0, input.priorConsumedCents)

  const shareOfBranchPct = safeDivide(consumed, branch.consumedCents) * 100
  const momPct = growthPct(consumed, prior)
  const ownUtilizationPct = branchUtilizationPct(branch)
  const peerMedianUtilizationPct = peerBranchMedianUtilizationPct(peerBranches, t)
  const vsPeerPct = ownUtilizationPct === null || peerMedianUtilizationPct === null || peerMedianUtilizationPct <= 0
    ? null
    : ((ownUtilizationPct - peerMedianUtilizationPct) / peerMedianUtilizationPct) * 100
  const recentSharePct = input.elapsedDays >= t.lateSurgeMinElapsedDays && consumed > 0
    ? safeDivide(Math.max(0, row.recentConsumedCents), consumed) * 100
    : null

  const reasons: BudgetBurnReason[] = []

  // A sole requester using the whole pot is exactly what a sole requester does.
  if (
    branch.activeRequesterCount >= t.highShareMinRequesters
    && branch.consumedCents >= t.highShareMinBranchCents
    && shareOfBranchPct >= t.highSharePct
  ) reasons.push("high_share")

  // Doubling a tiny base is not a spike.
  if (prior >= t.momMinBaselineCents && momPct !== null && momPct >= t.momSpikePct) reasons.push("mom_spike")

  if (vsPeerPct !== null && vsPeerPct >= t.abovePeersPct) reasons.push("above_peers")

  if (
    recentSharePct !== null
    && consumed >= t.lateSurgeMinConsumedCents
    && recentSharePct >= t.lateSurgePct
  ) reasons.push("late_surge")

  if (row.pendingCents > 0 && row.pendingCents >= highHeldFloor(branch, t)) reasons.push("high_held")

  if (row.rejectedOrderCount >= t.rejectedOrdersMin) reasons.push("rejected_orders")

  const score = reasons.reduce((sum, reason) => sum + BUDGET_BURN_POINTS[reason], 0)

  return {
    userId: row.userId,
    branchId: row.branchId,
    score,
    reasons,
    metrics: {
      spendCents: Math.max(0, row.spendCents),
      pendingCents: Math.max(0, row.pendingCents),
      consumedCents: consumed,
      shareOfBranchPct,
      momPct,
      priorConsumedCents: prior,
      branchUtilizationPct: ownUtilizationPct,
      vsPeerPct,
      peerBranchMedianUtilizationPct: peerMedianUtilizationPct,
      recentSharePct,
      orderCount: row.orderCount,
      pendingOrderCount: row.pendingOrderCount,
      rejectedOrderCount: row.rejectedOrderCount,
    },
  }
}

/** Score desc, then consumed desc, then a stable key so equal rows keep one order. */
export function rankWatchlist(rows: readonly WatchlistRow[]): WatchlistRow[] {
  return [...rows].sort((left, right) => (
    right.score - left.score
    || right.metrics.consumedCents - left.metrics.consumedCents
    || creatorKey(left).localeCompare(creatorKey(right))
  ))
}

export function isFlagged(row: WatchlistRow, thresholds: Pick<BudgetBurnThresholds, "flagScore"> = BUDGET_BURN_THRESHOLDS): boolean {
  return row.score >= thresholds.flagScore
}

/**
 * Every requester scored and ranked. The caller decides how many flagged rows
 * to return; the unflagged remainder is counted so the panel can say how many
 * people sat below the line rather than implying the list is everyone.
 */
export function buildWatchlist(input: {
  requesters: readonly CreatorMonth[]
  branches: ReadonlyMap<number, BranchMonth>
  /** Prior-month consumption keyed by `creatorKey`. */
  priorByKey: ReadonlyMap<string, number>
  elapsedDays: number
  limit: number
  thresholds?: BudgetBurnThresholds
}): { rows: WatchlistRow[]; flaggedCount: number; unflaggedCount: number } {
  const t = input.thresholds ?? BUDGET_BURN_THRESHOLDS
  // Every branch's peers are "every other branch in scope" — the same list
  // for every requester at that branch, so it is built once rather than
  // refiltered per row.
  const allBranches = Array.from(input.branches.values())
  const peerBranchesByBranch = new Map<number, BranchMonth[]>()
  for (const branch of allBranches) {
    peerBranchesByBranch.set(branch.branchId, allBranches.filter((peer) => peer.branchId !== branch.branchId))
  }

  const scored = input.requesters.map((row) => {
    const branch = input.branches.get(row.branchId) ?? {
      branchId: row.branchId,
      consumedCents: consumedCents(row),
      otherCreatorsConsumedCents: 0,
      activeRequesterCount: consumedCents(row) > 0 ? 1 : 0,
      totalBudgetCents: 0,
      remainingCents: 0,
    }
    const peerBranches = peerBranchesByBranch.get(row.branchId)
      ?? allBranches.filter((peer) => peer.branchId !== row.branchId)
    return scoreRequester({
      row,
      branch,
      peerBranches,
      priorConsumedCents: input.priorByKey.get(creatorKey(row)) ?? 0,
      elapsedDays: input.elapsedDays,
      thresholds: t,
    })
  })

  const ranked = rankWatchlist(scored)
  const flagged = ranked.filter((row) => isFlagged(row, t))
  return {
    rows: flagged.slice(0, Math.max(0, input.limit)),
    flaggedCount: flagged.length,
    unflaggedCount: ranked.length - flagged.length,
  }
}
