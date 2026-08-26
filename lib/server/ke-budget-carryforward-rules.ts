/**
 * Eligibility and arithmetic for the K-Electric monthly budget carry-forward.
 *
 * Background: K-Electric's historical budgets arrived through a per-period legacy
 * import that wrote `budgets` rows directly. Only the import's final period was
 * propagated into `branches.baseline_budget_cents`, and the application seeds every
 * new month's allocation from that baseline (see `syncCurrentMoneyBudgets` in
 * `app/api/v1/budgets/route.ts` and `getOrCreateCurrentBudget` on the order paths).
 * Branches whose legacy tenure for the import month carried a zero monthly budget
 * therefore fell to Rs 0 and stay there every following month.
 *
 * Restoring the baseline to the branch's last funded allocation repairs the current
 * month and makes every future month reuse the same figure until a Head Office or
 * Super Admin user changes it through Allocate → Monthly, which rewrites the baseline.
 *
 * This module is deliberately free of database and `server-only` imports so the rules
 * are directly testable.
 */

/** A branch considered for carry-forward, joined to its current and last funded period. */
export interface CarryForwardCandidate {
  branchId: number
  branchName: string
  branchCode: string | null
  /** `branches.baseline_budget_cents`; a positive value means the branch is already funded. */
  baselineBudgetCents: number
  /** `budgets.id` for the current period, or null when the row has not been created yet. */
  currentBudgetId: number | null
  currentAllocatedCents: number
  currentSpentCents: number
  currentHeldCents: number
  currentCreditedCents: number
  /** Most recent period before the current one with a positive allocation. */
  sourcePeriod: string | null
  sourceAllocatedCents: number | null
  /**
   * The same period's allocation as it stood before `KE_BUDGET_SPEND_BACKFILL`, when a
   * pre-change snapshot is available. That backfill only ever raised an allocation to
   * cover recorded consumption, so a lower snapshot value is the real legacy budget.
   */
  preBackfillAllocatedCents?: number | null
}

export type CarryForwardSkipReason =
  | "baseline-already-funded"
  | "no-prior-funded-period"
  | "current-period-already-allocated"
  | "current-period-has-activity"

export interface CarryForwardSkip {
  branchId: number
  branchName: string
  reason: CarryForwardSkipReason
}

export interface CarryForwardPlanRow {
  branchId: number
  branchCode: string | null
  branchName: string
  period: string
  currentBudgetId: number | null
  operation: "update" | "insert"
  sourcePeriod: string
  /** Allocation currently stored on the source period row. */
  sourceAllocatedCents: number
  /** Allocation restored to the baseline and the current period. */
  carryForwardCents: number
  /** True when the spend backfill had inflated the source row and the snapshot was used. */
  reconciliationAdjusted: boolean
  previousBaselineCents: number
}

export interface CarryForwardPlan {
  rows: CarryForwardPlanRow[]
  skipped: CarryForwardSkip[]
}

const isMoney = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

/**
 * The allocation to carry forward. The spend backfill only ever raised allocations, so
 * a strictly lower pre-change value is the branch's genuine legacy monthly budget and
 * wins; anything else keeps the stored allocation.
 */
export function resolveCarryForwardCents(
  sourceAllocatedCents: number,
  preBackfillAllocatedCents: number | null | undefined,
): { carryForwardCents: number; reconciliationAdjusted: boolean } {
  if (
    typeof preBackfillAllocatedCents === "number"
    && isMoney(preBackfillAllocatedCents)
    && preBackfillAllocatedCents > 0
    && preBackfillAllocatedCents < sourceAllocatedCents
  ) {
    return { carryForwardCents: preBackfillAllocatedCents, reconciliationAdjusted: true }
  }
  return { carryForwardCents: sourceAllocatedCents, reconciliationAdjusted: false }
}

/**
 * Why a branch is left alone, or null when it qualifies. Order matters: the first
 * matching reason is the one reported.
 */
export function skipReasonFor(candidate: CarryForwardCandidate): CarryForwardSkipReason | null {
  if (candidate.baselineBudgetCents > 0) return "baseline-already-funded"
  if (candidate.sourcePeriod === null || candidate.sourceAllocatedCents === null) return "no-prior-funded-period"
  if (candidate.currentAllocatedCents > 0) return "current-period-already-allocated"
  if (candidate.currentSpentCents > 0 || candidate.currentHeldCents > 0 || candidate.currentCreditedCents > 0) {
    return "current-period-has-activity"
  }
  return null
}

/**
 * Splits candidates into the rows to write and the branches deliberately left untouched.
 * `period` is the current `YYYY-MM` budget period.
 */
export function buildCarryForwardPlan(
  candidates: CarryForwardCandidate[],
  period: string,
): CarryForwardPlan {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`Invalid period: ${period}`)

  const rows: CarryForwardPlanRow[] = []
  const skipped: CarryForwardSkip[] = []

  for (const candidate of candidates) {
    const reason = skipReasonFor(candidate)
    if (reason) {
      skipped.push({ branchId: candidate.branchId, branchName: candidate.branchName, reason })
      continue
    }

    const sourcePeriod = candidate.sourcePeriod as string
    const sourceAllocatedCents = candidate.sourceAllocatedCents as number
    if (!isMoney(sourceAllocatedCents) || sourceAllocatedCents <= 0) {
      throw new Error(`Unusable source allocation for branch ${candidate.branchId}`)
    }
    if (sourcePeriod >= period) {
      throw new Error(`Source period ${sourcePeriod} is not before ${period} for branch ${candidate.branchId}`)
    }

    const { carryForwardCents, reconciliationAdjusted } = resolveCarryForwardCents(
      sourceAllocatedCents,
      candidate.preBackfillAllocatedCents,
    )
    if (!isMoney(carryForwardCents) || carryForwardCents <= 0) {
      throw new Error(`Unusable carry-forward amount for branch ${candidate.branchId}`)
    }
    // Protects `budgets_values_valid_ck`: allocated + credited >= spent + held.
    const committed = candidate.currentSpentCents + candidate.currentHeldCents
    if (carryForwardCents + candidate.currentCreditedCents < committed) {
      throw new Error(`Carry-forward below committed spend for branch ${candidate.branchId}`)
    }

    rows.push({
      branchId: candidate.branchId,
      branchCode: candidate.branchCode,
      branchName: candidate.branchName,
      period,
      currentBudgetId: candidate.currentBudgetId,
      operation: candidate.currentBudgetId === null ? "insert" : "update",
      sourcePeriod,
      sourceAllocatedCents,
      carryForwardCents,
      reconciliationAdjusted,
      previousBaselineCents: candidate.baselineBudgetCents,
    })
  }

  return { rows, skipped }
}

/** Stable, order-independent fingerprint of a plan, used to pin a preflight to a commit. */
export function carryForwardPlanLines(rows: CarryForwardPlanRow[]): string[] {
  return [...rows]
    .sort((left, right) => left.branchId - right.branchId)
    .map((row) => [
      row.branchId,
      row.period,
      row.operation,
      row.currentBudgetId ?? "none",
      row.sourcePeriod,
      row.sourceAllocatedCents,
      row.carryForwardCents,
      row.previousBaselineCents,
    ].join(":"))
}
