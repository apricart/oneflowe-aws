/**
 * The arithmetic behind one branch's money budget for one period.
 *
 * Kept free of the database and of React so the figure the Group Order Portal
 * shows is derived by the same function in a unit test as it is in the browser,
 * and so it can be checked against the rule the ordering engine actually
 * enforces in `lib/server/group-order-creation.ts`:
 *
 *   available = allocated + credited - spent - held
 *
 * A branch with no row for the period is not out of budget: the ordering engine
 * creates one from the branch baseline on first use, so the baseline is what a
 * requester will really have. It reports "not configured" only in the one case
 * the engine refuses outright — no row and no baseline to open one with.
 *
 * This module never widens anything. It is display-only: every order is still
 * priced, locked, and checked against the live budget row on the server.
 */

/** The columns of a `budgets` row this calculation needs. */
export type BranchBudgetRecord = {
  amountAllocatedCents: number | null
  amountSpentCents: number | null
  amountHeldCents: number | null
  amountCreditedCents: number | null
}

export type BranchBudgetSummary = {
  branchId: number
  /** The `YYYY-MM` period these figures belong to. */
  period: string
  /**
   * False only when an order for this branch would be refused for want of a
   * budget: no row for the period and no baseline to open one from.
   */
  configured: boolean
  /** Allocated plus credited add-ons: the "total" half of remaining/total. */
  totalCents: number
  spentCents: number
  heldCents: number
  /** Total minus spent and held. What the next order may draw on. */
  remainingCents: number
}

const toCents = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0

export function summarizeBranchBudget({
  branchId,
  period,
  baselineBudgetCents,
  budget,
}: {
  branchId: number
  period: string
  baselineBudgetCents: number | null
  budget: BranchBudgetRecord | null
}): BranchBudgetSummary {
  const baseline = toCents(baselineBudgetCents)

  if (!budget) {
    // Nothing has been spent against a period that has no row yet, so the
    // baseline is both the total and what remains.
    return {
      branchId,
      period,
      configured: baseline > 0,
      totalCents: baseline,
      spentCents: 0,
      heldCents: 0,
      remainingCents: baseline,
    }
  }

  const totalCents = toCents(budget.amountAllocatedCents) + toCents(budget.amountCreditedCents)
  const spentCents = toCents(budget.amountSpentCents)
  const heldCents = toCents(budget.amountHeldCents)

  return {
    branchId,
    period,
    // A row that exists is a configured budget even when it is exhausted, or
    // allocated at zero: the engine rejects those as "insufficient", which is a
    // different thing to say than "ask head office to set one up".
    configured: true,
    totalCents,
    spentCents,
    heldCents,
    remainingCents: totalCents - spentCents - heldCents,
  }
}

/**
 * How much of the budget is still available, as 0..1, for a progress bar.
 * A budget with no total has nothing to show a proportion of, and an
 * over-committed one is reported as empty rather than as a negative width.
 */
export function budgetRemainingRatio(summary: BranchBudgetSummary): number {
  if (summary.totalCents <= 0) return 0
  return Math.min(1, Math.max(0, summary.remainingCents / summary.totalCents))
}
