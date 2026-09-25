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
 *   Pattern      Consumed in each of the `BUDGET_BURN_PATTERN_MONTHS` months
 *                ending with the selected one, newest last. Shown in full so
 *                the reader sees the shape rather than a single derived
 *                number, and so the one comparison that *is* derived can be
 *                checked against the cells beside it.
 *   MoM          the growth of the newest of those months over the one before
 *                it. This is the only figure that decides a highlight, and it
 *                is a ratio of two cells that are both on the row.
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
  /**
   * Growth of the selected month over the one before it at or above which the
   * row is highlighted. The only threshold the panel's red state depends on.
   */
  momSpikePct: 15,
  /**
   * A previous month below this is too small a baseline to read a spike from:
   * ₨5,000. One month against one month is the comparison this figure was
   * originally set for, so it is exactly as strict as it was designed to be.
   */
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
  /**
   * Score at or above which the retired multi-signal rule would have listed a
   * requester. The panel no longer lists by score — it lists every requester
   * and highlights on `momSpikePct` — but the score is still computed and
   * reported so the signals behind it stay available and testable.
   */
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
/**
 * How many consecutive months the panel shows, ending with the selected one.
 * The oldest is therefore `this - 1` months before the selection; that is a
 * read of older orders and nothing more, so `BUDGET_BURN_MAX_MONTHS_BACK`
 * still bounds only the month the caller may select.
 */
export const BUDGET_BURN_PATTERN_MONTHS = 3
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

/** The calendar month `delta` months away, carrying across year boundaries. */
function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
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

/** One month of the pattern, bounded to the elapsed day when the selection is open. */
export type PatternBucket = {
  /** The calendar month this bucket covers, `YYYY-MM`. */
  month: string
  start: Date
  end: Date
  /** False only where the bucket was cut short — the selected month while it is still open. */
  complete: boolean
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
  /**
   * The `BUDGET_BURN_PATTERN_MONTHS` months the panel shows, oldest first. The
   * last is always the selected month and covers exactly the same instants as
   * `current`, so one read serves both.
   */
  pattern: PatternBucket[]
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
 * month start. The watchlist compares like with like, and the same rule
 * governs the month window every other figure uses and every bucket of the
 * pattern: to the same elapsed day in each month (clamped where a month is
 * shorter), or whole months throughout once the selected month is over. An
 * older bucket runs to the *end* of that day, so every pair of buckets covers
 * the same whole number of days.
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

  const span = BUDGET_BURN_PATTERN_MONTHS
  // Oldest first, ending with the selected month. An older bucket is cut on
  // the same elapsed day as the selection so the columns are comparable; the
  // newest never reaches past `now`.
  const pattern: PatternBucket[] = []
  for (let back = span - 1; back >= 1; back -= 1) {
    const older = shiftMonth(year, monthNumber, -back)
    const olderDays = daysInMonth(older.year, older.month)
    const lastDay = complete ? olderDays : Math.min(elapsedDays, olderDays)
    pattern.push({
      month: monthKeyOf(older.year, older.month),
      start: startOfAppDay(older.year, older.month, 1),
      end: endOfAppDay(older.year, older.month, lastDay),
      complete: complete || lastDay === olderDays,
    })
  }
  pattern.push({ month, start: monthStart, end: currentEnd, complete })

  const recentStart = new Date(Math.max(
    monthStart.getTime(),
    currentEnd.getTime() - thresholds.lateSurgeDays * DAY_MS,
  ))

  return {
    month,
    current: { start: monthStart, end: currentEnd, complete, elapsedDays, daysInMonth: days },
    pattern,
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

/** One requester's consumption in one month of the pattern. Money in integer cents. */
export type MonthConsumption = {
  month: string
  spendCents: number
  pendingCents: number
  /** `spendCents + pendingCents` — carried rather than derived, so the client cannot disagree. */
  consumedCents: number
}

/** A month with nothing in it, so an absent bucket reads as zero and never as missing. */
export function emptyMonthConsumption(month: string): MonthConsumption {
  return { month, spendCents: 0, pendingCents: 0, consumedCents: 0 }
}

export function monthConsumptionOf(month: string, row: Pick<CreatorMonth, "spendCents" | "pendingCents">): MonthConsumption {
  return {
    month,
    spendCents: Math.max(0, row.spendCents),
    pendingCents: Math.max(0, row.pendingCents),
    consumedCents: consumedCents(row),
  }
}

/**
 * Every creator seen in any month of the pattern, as one row per
 * `userId:branchId` carrying the **selected month's** figures.
 *
 * The listed set is the union rather than the selected month alone, because a
 * panel whose purpose is a three-month shape must not silently drop the person
 * who spent heavily last month and nothing this month — the most interesting
 * shape there is. Where the newest bucket has no row for a creator, their
 * month figures are zero and their identity comes from the newest bucket that
 * does have them, so a name is never invented and never stale.
 *
 * Buckets are oldest first; `branches`, `Share` and every other selected-month
 * figure keep reading the newest bucket alone through `summarizeCreators`.
 */
export function unionCreators<T extends CreatorMonth>(buckets: readonly (readonly T[])[]): T[] {
  const byKey = new Map<string, T>()
  // Newest first, so the first row found for a key is the freshest identity
  // and, where it exists, the selected month's own figures.
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    for (const row of buckets[index] ?? []) {
      const key = creatorKey(row)
      if (byKey.has(key)) continue
      byKey.set(key, index === buckets.length - 1
        ? row
        : { ...row, spendCents: 0, pendingCents: 0, orderCount: 0, pendingOrderCount: 0, rejectedOrderCount: 0, recentConsumedCents: 0 })
    }
  }
  return Array.from(byKey.values())
}

/**
 * The pattern each creator is drawn with: one entry per bucket, oldest first,
 * zero-filled so every row has the same number of columns whatever months the
 * person actually ordered in.
 */
export function patternByCreator(
  months: readonly string[],
  buckets: readonly (readonly CreatorMonth[])[],
): Map<string, MonthConsumption[]> {
  const byKey = new Map<string, MonthConsumption[]>()
  const blank = () => months.map(emptyMonthConsumption)
  buckets.forEach((rows, index) => {
    const month = months[index]
    if (month === undefined) return
    for (const row of rows ?? []) {
      const key = creatorKey(row)
      const entry = byKey.get(key) ?? blank()
      entry[index] = monthConsumptionOf(month, row)
      byKey.set(key, entry)
    }
  })
  return byKey
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
  /**
   * The `BUDGET_BURN_PATTERN_MONTHS` months the panel draws, oldest first. The
   * last is the selected month and its `consumedCents` equals `consumedCents`
   * above; the whole column set is carried so the reader compares cells that
   * are on the row rather than a number they cannot check.
   */
  months: MonthConsumption[]
  /**
   * Growth of the newest month over the one before it; null when the previous
   * month had nothing to grow from. This is a ratio of the last two cells of
   * `months`, and of nothing else.
   */
  momPct: number | null
  /** `momPct` at or above `momSpikePct`, from a previous month worth measuring. */
  momFlagged: boolean
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
 * The month-over-month figure and whether it earns a highlight.
 *
 * Pure and exported on its own because it is the single rule the panel's red
 * state depends on: the newest month against the one before it, from a
 * previous month large enough that the ratio means something. A first month
 * has no previous month and is never highlighted — "no baseline", not "no
 * change".
 */
export function monthOverMonth(
  months: readonly MonthConsumption[],
  thresholds: Pick<BudgetBurnThresholds, "momSpikePct" | "momMinBaselineCents"> = BUDGET_BURN_THRESHOLDS,
): { momPct: number | null; momFlagged: boolean } {
  const current = Math.max(0, months.at(-1)?.consumedCents ?? 0)
  const previous = months.length >= 2 ? Math.max(0, months.at(-2)?.consumedCents ?? 0) : 0
  const momPct = growthPct(current, previous)
  return {
    momPct,
    momFlagged: previous >= thresholds.momMinBaselineCents && momPct !== null && momPct >= thresholds.momSpikePct,
  }
}

/**
 * One requester at one branch, scored against the branch, their peers and
 * their own previous month. Every guard that suppresses a signal is here, next
 * to the signal it guards.
 */
export function scoreRequester(input: {
  row: CreatorMonth
  branch: BranchMonth
  /** The other branches in scope this month — never including `branch`. */
  peerBranches: readonly BranchMonth[]
  /** This requester's consumption in each month of the pattern, oldest first. */
  months: readonly MonthConsumption[]
  elapsedDays: number
  thresholds?: BudgetBurnThresholds
}): WatchlistRow {
  const t = input.thresholds ?? BUDGET_BURN_THRESHOLDS
  const { row, branch, peerBranches } = input
  const consumed = consumedCents(row)
  const months = input.months.map((entry) => ({
    month: entry.month,
    spendCents: Math.max(0, entry.spendCents),
    pendingCents: Math.max(0, entry.pendingCents),
    consumedCents: Math.max(0, entry.consumedCents),
  }))

  const shareOfBranchPct = safeDivide(consumed, branch.consumedCents) * 100
  const { momPct, momFlagged } = monthOverMonth(months, t)
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

  // Doubling a tiny base is not a spike; the guard lives in `monthOverMonth`.
  if (momFlagged) reasons.push("mom_spike")

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
      months,
      momPct,
      momFlagged,
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

/** Highlighted rows sort among themselves by how far above the previous month they are. */
function highlightOrder(row: WatchlistRow): number {
  return row.metrics.momFlagged ? (row.metrics.momPct ?? 0) : 0
}

/**
 * Highlighted first and steepest first, then everyone else by what they
 * consumed this month, then a stable key so equal rows keep one order.
 *
 * The second term matters: ordering the whole list by growth would put a
 * requester who went from ₨6,000 to ₨7,000 above one who spent ₨400,000
 * steadily. Growth decides the top of the list; money decides the rest.
 */
export function rankWatchlist(rows: readonly WatchlistRow[]): WatchlistRow[] {
  return [...rows].sort((left, right) => (
    Number(right.metrics.momFlagged) - Number(left.metrics.momFlagged)
    || highlightOrder(right) - highlightOrder(left)
    || right.metrics.consumedCents - left.metrics.consumedCents
    || creatorKey(left).localeCompare(creatorKey(right))
  ))
}

/**
 * Whether the retired multi-signal rule would have listed this row.
 *
 * Nothing on the panel is decided by it any more — the list is every
 * requester and the highlight is `momFlagged` — but the count is still
 * reported so the signals stay observable and the change stays reversible.
 */
export function isScoreFlagged(row: WatchlistRow, thresholds: Pick<BudgetBurnThresholds, "flagScore"> = BUDGET_BURN_THRESHOLDS): boolean {
  return row.score >= thresholds.flagScore
}

/**
 * Every requester drawn with their pattern and ranked.
 *
 * The list is no longer a shortlist: the caller's `limit` takes the top of a
 * ranked whole, and `requesterCount` says how many there were, so the panel
 * states what it is showing rather than implying it is everyone.
 */
export function buildWatchlist(input: {
  requesters: readonly CreatorMonth[]
  branches: ReadonlyMap<number, BranchMonth>
  /** The months the pattern covers, oldest first. */
  patternMonths: readonly string[]
  /** Each creator's consumption per pattern month, keyed by `creatorKey`. */
  monthsByKey: ReadonlyMap<string, readonly MonthConsumption[]>
  elapsedDays: number
  limit: number
  thresholds?: BudgetBurnThresholds
}): { rows: WatchlistRow[]; highlightedCount: number; scoreFlaggedCount: number; requesterCount: number } {
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
    const key = creatorKey(row)
    return scoreRequester({
      row,
      branch,
      peerBranches,
      months: input.monthsByKey.get(key) ?? input.patternMonths.map(emptyMonthConsumption),
      elapsedDays: input.elapsedDays,
      thresholds: t,
    })
  })

  const ranked = rankWatchlist(scored)
  return {
    rows: ranked.slice(0, Math.max(0, input.limit)),
    highlightedCount: ranked.filter((row) => row.metrics.momFlagged).length,
    scoreFlaggedCount: ranked.filter((row) => isScoreFlagged(row, t)).length,
    requesterCount: ranked.length,
  }
}
