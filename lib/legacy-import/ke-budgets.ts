/**
 * Plan K-Electric branch budgets from the legacy logistics platform.
 *
 * WHAT THE SOURCE ACTUALLY GIVES US
 * ---------------------------------
 * The budget lives on the location rows `sync-ke.ts` already fetches, so no
 * extra endpoint is needed. Each carries:
 *
 *   MonthlyBudget      the allocation for the tenure below
 *   TotalBudget        what is LEFT of it, not what was granted
 *   MinBudget          a low-balance threshold
 *   BudgetTenureFrom   start of the funded period
 *   BudgetTenureTo     end of it
 *
 * `TotalBudget` looks like an allocation and is not: KE HOUSE carries
 * MonthlyBudget 900,000 against TotalBudget 6. Writing it into
 * `amount_allocated_cents` would under-fund almost every branch.
 *
 * It is, however, exactly what OneFlowe computes as remaining — for every
 * location with a MonthlyBudget, `TotalBudget` equals our
 * `allocated + credited - spent - held` to the rupee — and that is what makes
 * it usable for the locations whose MonthlyBudget is 0 yet still have money
 * left (HSEQ & Quality control: MonthlyBudget 0, TotalBudget 5). For those
 * the allocation is what is left plus what our own ledger says was used.
 * That figure can never exceed legacy while our used is at most theirs, and
 * it converges as the order import does.
 *
 * THE LIMIT WORTH KNOWING
 * -----------------------
 * The API exposes one tenure — the current month. There is no budget history in
 * it, so this plans the current period only. Historical months come from the
 * legacy budget report via `scripts/import-ke-branch-budgets.ts`, which is why
 * that script reads a file rather than the API.
 *
 * LEGACY IS AUTHORITATIVE, WITHIN THE INVARIANT
 * ---------------------------------------------
 * A branch's allocation in OneFlowe is meant to be the legacy one. A row that
 * is below it is raised, which `budgets_values_valid_ck` (allocated +
 * credited >= spent + held) always permits. A row that is above it is lowered
 * only when the caller asks (`allowLower`) and the invariant still holds
 * afterwards; otherwise the difference is reported as drift with the reason.
 * Lowering is opt-in because it takes away budget a Head Office user may have
 * granted deliberately in OneFlowe.
 *
 * ZEROING A MONTH INSTEAD
 * -----------------------
 * `planZeroBudgets` is the other mode: every active branch's allocation for
 * one period goes to the lowest the invariant allows, `spent + held -
 * credited`, so nothing remains to order against — a branch that has used
 * nothing goes to 0 outright. It reaches every branch of the organization,
 * legacy counterpart or not, and it also clears `branches.baseline_budget_cents`
 * because two paths in `app/api/v1/budgets/route.ts` re-fund from it: a
 * missing month row is created at the baseline, and an existing zero row with
 * no spend is treated as stale and reset to it. A zero that the next page load
 * undoes is not a zero.
 */

/** The budget-bearing fields of a legacy location row. */
export interface LegacyLocationBudget {
  ID: number
  Name?: string | null
  MonthlyBudget?: number | null
  /** What is left of the allocation — see the header. */
  TotalBudget?: number | null
  BudgetTenureFrom?: string | null
  BudgetTenureTo?: string | null
}

/** A `budgets` row this organization already holds. */
export interface CurrentBudget {
  branchId: number
  period: string
  amountAllocatedCents: number
  amountCreditedCents: number
  amountSpentCents: number
  amountHeldCents: number
}

export interface BudgetCreate {
  branchId: number
  branchName: string
  legacyLocationId: number
  period: string
  amountAllocatedCents: number
}

/** An existing allocation moved to the legacy figure. */
export interface BudgetChange {
  branchId: number
  branchName: string
  legacyLocationId: number
  period: string
  currentCents: number
  amountAllocatedCents: number
  /** Where the legacy figure came from — see the header. */
  source: BudgetSource
}

export type BudgetSource = "MONTHLY_BUDGET" | "REMAINING_PLUS_USED" | "ZERO_PERIOD"

export type BudgetDriftReason = "LOWER_NOT_REQUESTED" | "LOWER_WOULD_BREAK_INVARIANT"

/** A difference that is reported, not applied. */
export interface BudgetDrift {
  branchId: number
  branchName: string
  period: string
  currentCents: number
  legacyCents: number
  reason: BudgetDriftReason
}

export type BudgetSkipReason = "NO_BUDGET" | "NO_TENURE" | "BRANCH_NOT_PINNED"

export interface SkippedBudget {
  legacyLocationId: number
  branchName: string
  reason: BudgetSkipReason
  detail: string
}

/** `branches.baseline_budget_cents` cleared so a zeroed month stays zero. */
export interface BaselineReset {
  branchId: number
  branchName: string
  currentCents: number
}

export interface BudgetPlan {
  creates: BudgetCreate[]
  raises: BudgetChange[]
  lowers: BudgetChange[]
  baselineResets: BaselineReset[]
  drift: BudgetDrift[]
  skipped: SkippedBudget[]
  unchanged: number
}

/** A branch of the organization, as `planZeroBudgets` needs it. */
export interface BudgetBranch {
  branchId: number
  name: string
  baselineBudgetCents: number
}

export interface BudgetPlanOptions {
  /** Lower an allocation to the legacy figure where the invariant allows it. */
  allowLower: boolean
}

/**
 * `YYYY-MM` for a legacy tenure start, matching `budgets.period`.
 *
 * Parsed off the string rather than through `new Date()`: the legacy values are
 * naive local timestamps ("2026-09-01T00:00:00") and letting the runtime read
 * them as UTC moves a month-start backwards into the previous month for anyone
 * running east of Greenwich.
 */
export function periodOf(tenureFrom: unknown): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(String(tenureFrom ?? "").trim())
  if (!match) return null
  const month = Number(match[2])
  if (month < 1 || month > 12) return null
  return `${match[1]}-${match[2]}`
}

/** Legacy states whole currency units; OneFlowe stores integer cents. */
export function budgetToCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = typeof value === "number" ? value : Number(String(value).trim())
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round((parsed + Number.EPSILON) * 100)
}

/**
 * Decide the budget row for each funded legacy location.
 *
 * Pure, so the dry run and the commit necessarily plan the same thing.
 * `branchByLegacyId` comes from the branch pins, which is the only trustworthy
 * link between the two systems — never the branch name.
 */
export function planBranchBudgets(
  locations: readonly LegacyLocationBudget[],
  branchByLegacyId: ReadonlyMap<number, { branchId: number; name: string }>,
  currentBudgets: readonly CurrentBudget[],
  options: BudgetPlanOptions = { allowLower: false },
): BudgetPlan {
  const existing = new Map(currentBudgets.map((row) => [`${row.branchId}:${row.period}`, row]))

  const creates: BudgetCreate[] = []
  const raises: BudgetChange[] = []
  const lowers: BudgetChange[] = []
  const drift: BudgetDrift[] = []
  const skipped: SkippedBudget[] = []
  let unchanged = 0

  for (const location of locations) {
    const branchName = String(location.Name ?? "").trim()
    const skip = (reason: BudgetSkipReason, detail: string) =>
      skipped.push({ legacyLocationId: location.ID, branchName, reason, detail })

    const monthlyCents = budgetToCents(location.MonthlyBudget) ?? 0
    const remainingCents = budgetToCents(location.TotalBudget) ?? 0
    const unfunded = monthlyCents === 0 && remainingCents === 0

    const period = periodOf(location.BudgetTenureFrom)
    if (!period) {
      if (unfunded) skip("NO_BUDGET", "legacy carries no monthly budget and nothing left for this location")
      else skip("NO_TENURE", `unreadable BudgetTenureFrom ${JSON.stringify(location.BudgetTenureFrom)}`)
      continue
    }

    const branch = branchByLegacyId.get(location.ID)
    if (!branch) {
      if (unfunded) skip("NO_BUDGET", "legacy carries no monthly budget and nothing left for this location")
      else skip("BRANCH_NOT_PINNED", "no OneFlowe branch is pinned to this legacy location yet")
      continue
    }

    const current = existing.get(`${branch.branchId}:${period}`)
    // An unfunded location gets no row of its own; the shop creates one at
    // zero on demand. But a row we already hold is compared like any other,
    // so an allocation legacy does not have is at least reported.
    if (unfunded && !current) {
      skip("NO_BUDGET", "legacy carries no monthly budget and nothing left for this location")
      continue
    }
    const usedCents = current ? current.amountSpentCents + current.amountHeldCents - current.amountCreditedCents : 0
    const source: BudgetSource = monthlyCents > 0 ? "MONTHLY_BUDGET" : "REMAINING_PLUS_USED"
    const legacyCents = monthlyCents > 0 ? monthlyCents : remainingCents + Math.max(0, usedCents)

    if (!current) {
      creates.push({
        branchId: branch.branchId,
        branchName: branch.name,
        legacyLocationId: location.ID,
        period,
        amountAllocatedCents: legacyCents,
      })
      continue
    }
    if (current.amountAllocatedCents === legacyCents) {
      unchanged += 1
      continue
    }
    const change: BudgetChange = {
      branchId: branch.branchId,
      branchName: branch.name,
      legacyLocationId: location.ID,
      period,
      currentCents: current.amountAllocatedCents,
      amountAllocatedCents: legacyCents,
      source,
    }
    if (legacyCents > current.amountAllocatedCents) {
      raises.push(change)
      continue
    }
    const report = (reason: BudgetDriftReason) => drift.push({
      branchId: branch.branchId,
      branchName: branch.name,
      period,
      currentCents: current.amountAllocatedCents,
      legacyCents,
      reason,
    })
    if (!options.allowLower) {
      report("LOWER_NOT_REQUESTED")
      continue
    }
    if (legacyCents + current.amountCreditedCents < current.amountSpentCents + current.amountHeldCents) {
      report("LOWER_WOULD_BREAK_INVARIANT")
      continue
    }
    lowers.push(change)
  }

  return { creates, raises, lowers, baselineResets: [], drift, skipped, unchanged }
}

/**
 * Leave every active branch nothing to order against for one period.
 *
 * Pure, like `planBranchBudgets`, and it produces the same plan shape so the
 * dry run, digest and commit treat it identically. Legacy plays no part here:
 * the caller chooses this mode instead of the legacy one for the period.
 */
export function planZeroBudgets(
  period: string,
  branches: readonly BudgetBranch[],
  currentBudgets: readonly CurrentBudget[],
): BudgetPlan {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`period must be YYYY-MM, got ${JSON.stringify(period)}`)
  const existing = new Map(
    currentBudgets.filter((row) => row.period === period).map((row) => [row.branchId, row]),
  )

  const creates: BudgetCreate[] = []
  const lowers: BudgetChange[] = []
  const baselineResets: BaselineReset[] = []
  let unchanged = 0

  for (const branch of branches) {
    if (branch.baselineBudgetCents > 0) {
      baselineResets.push({ branchId: branch.branchId, branchName: branch.name, currentCents: branch.baselineBudgetCents })
    }
    const current = existing.get(branch.branchId)
    if (!current) {
      creates.push({
        branchId: branch.branchId,
        branchName: branch.name,
        legacyLocationId: 0,
        period,
        amountAllocatedCents: 0,
      })
      continue
    }
    // The floor `budgets_values_valid_ck` allows; remaining is then exactly 0.
    const floor = Math.max(0, current.amountSpentCents + current.amountHeldCents - current.amountCreditedCents)
    if (current.amountAllocatedCents === floor) {
      unchanged += 1
      continue
    }
    lowers.push({
      branchId: branch.branchId,
      branchName: branch.name,
      legacyLocationId: 0,
      period,
      currentCents: current.amountAllocatedCents,
      amountAllocatedCents: floor,
      source: "ZERO_PERIOD",
    })
  }

  return { creates, raises: [], lowers, baselineResets, drift: [], skipped: [], unchanged }
}

export interface BudgetCounts {
  fundedLocations: number
  toCreate: number
  toRaise: number
  toLower: number
  baselineResets: number
  unchanged: number
  drift: number
  skipped: number
  /** Net change in allocation across creates, raises and lowers. */
  totalAllocatedCents: number
  periods: string[]
}

export function summarizeBudgets(plan: BudgetPlan): BudgetCounts {
  const touched = [...plan.creates, ...plan.raises, ...plan.lowers]
  return {
    fundedLocations: touched.length + plan.drift.length + plan.unchanged,
    toCreate: plan.creates.length,
    toRaise: plan.raises.length,
    toLower: plan.lowers.length,
    baselineResets: plan.baselineResets.length,
    unchanged: plan.unchanged,
    drift: plan.drift.length,
    skipped: plan.skipped.length,
    totalAllocatedCents: plan.creates.reduce((sum, entry) => sum + entry.amountAllocatedCents, 0)
      + plan.raises.reduce((sum, entry) => sum + entry.amountAllocatedCents - entry.currentCents, 0)
      + plan.lowers.reduce((sum, entry) => sum + entry.amountAllocatedCents - entry.currentCents, 0),
    periods: [...new Set(touched.map((entry) => entry.period))].sort(),
  }
}
