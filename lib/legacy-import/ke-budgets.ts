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
 * `TotalBudget` is deliberately ignored. It looks like an allocation and is
 * not: KE HOUSE carries MonthlyBudget 900,000 against TotalBudget 6. Writing it
 * into `amount_allocated_cents` would under-fund almost every branch, and
 * writing it into `amount_spent_cents` would fight the spend that
 * `backfill-ke-budget-spend.ts` computes from the orders themselves.
 *
 * THE LIMIT WORTH KNOWING
 * -----------------------
 * The API exposes one tenure — the current month. There is no budget history in
 * it, so this plans the current period only. Historical months come from the
 * legacy budget report via `scripts/import-ke-branch-budgets.ts`, which is why
 * that script reads a file rather than the API.
 *
 * WHY IT NEVER OVERWRITES
 * -----------------------
 * An existing allocation may have been set in OneFlowe by a person, and
 * `budgets_values_valid_ck` requires allocated + credited >= spent + held — so
 * lowering an allocation to match legacy can fail outright once spend exists.
 * A row that disagrees is therefore reported as drift, never rewritten.
 */

/** The budget-bearing fields of a legacy location row. */
export interface LegacyLocationBudget {
  ID: number
  Name?: string | null
  MonthlyBudget?: number | null
  BudgetTenureFrom?: string | null
  BudgetTenureTo?: string | null
}

/** A `budgets` row this organization already holds. */
export interface CurrentBudget {
  branchId: number
  period: string
  amountAllocatedCents: number
}

export interface BudgetCreate {
  branchId: number
  branchName: string
  legacyLocationId: number
  period: string
  amountAllocatedCents: number
}

export interface BudgetDrift {
  branchId: number
  branchName: string
  period: string
  currentCents: number
  legacyCents: number
}

export type BudgetSkipReason = "NO_BUDGET" | "NO_TENURE" | "BRANCH_NOT_PINNED"

export interface SkippedBudget {
  legacyLocationId: number
  branchName: string
  reason: BudgetSkipReason
  detail: string
}

export interface BudgetPlan {
  creates: BudgetCreate[]
  drift: BudgetDrift[]
  skipped: SkippedBudget[]
  unchanged: number
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
): BudgetPlan {
  const existing = new Map(
    currentBudgets.map((row) => [`${row.branchId}:${row.period}`, row.amountAllocatedCents]),
  )

  const creates: BudgetCreate[] = []
  const drift: BudgetDrift[] = []
  const skipped: SkippedBudget[] = []
  let unchanged = 0

  for (const location of locations) {
    const branchName = String(location.Name ?? "").trim()
    const skip = (reason: BudgetSkipReason, detail: string) =>
      skipped.push({ legacyLocationId: location.ID, branchName, reason, detail })

    const cents = budgetToCents(location.MonthlyBudget)
    if (cents === null || cents === 0) {
      skip("NO_BUDGET", "legacy carries no monthly budget for this location")
      continue
    }

    const period = periodOf(location.BudgetTenureFrom)
    if (!period) {
      skip("NO_TENURE", `unreadable BudgetTenureFrom ${JSON.stringify(location.BudgetTenureFrom)}`)
      continue
    }

    const branch = branchByLegacyId.get(location.ID)
    if (!branch) {
      skip("BRANCH_NOT_PINNED", "no OneFlowe branch is pinned to this legacy location yet")
      continue
    }

    const current = existing.get(`${branch.branchId}:${period}`)
    if (current === undefined) {
      creates.push({
        branchId: branch.branchId,
        branchName: branch.name,
        legacyLocationId: location.ID,
        period,
        amountAllocatedCents: cents,
      })
      continue
    }
    if (current === cents) {
      unchanged += 1
      continue
    }
    drift.push({
      branchId: branch.branchId,
      branchName: branch.name,
      period,
      currentCents: current,
      legacyCents: cents,
    })
  }

  return { creates, drift, skipped, unchanged }
}

export interface BudgetCounts {
  fundedLocations: number
  toCreate: number
  unchanged: number
  drift: number
  skipped: number
  totalAllocatedCents: number
  periods: string[]
}

export function summarizeBudgets(plan: BudgetPlan): BudgetCounts {
  return {
    fundedLocations: plan.creates.length + plan.drift.length + plan.unchanged,
    toCreate: plan.creates.length,
    unchanged: plan.unchanged,
    drift: plan.drift.length,
    skipped: plan.skipped.length,
    totalAllocatedCents: plan.creates.reduce((sum, entry) => sum + entry.amountAllocatedCents, 0),
    periods: [...new Set(plan.creates.map((entry) => entry.period))].sort(),
  }
}
