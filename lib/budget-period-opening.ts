import { budgetPeriodOf } from "@/lib/budget-consumption"

/**
 * Opening a branch's budget row for the month, as the Budgets list does it.
 *
 * A month's row is not written by any schedule: the first thing that needs it
 * inserts it at `branches.baseline_budget_cents` — an order's budget
 * pre-flight, the shop's own budget read, an allocation. The Budgets list read
 * none of those paths, so a branch nobody had ordered for yet showed Rs 0 for
 * the month to Head Office although its baseline was intact and the next order
 * would open the row at the full figure. These rules let the list open the row
 * the same way first (`plans/OF-BUDGET-open-current-month-on-budget-list.md`).
 *
 * Free of the database so the rules are directly testable; the writer is
 * `lib/server/budget-period-opening.ts`.
 */

/**
 * The one budget month a read may open: the UTC month the ordering engine
 * holds against (`budgetPeriodOf`), and only when the read covers it. Never a
 * past month — a row that did not exist then is a month with no budget — and
 * never the Asia/Karachi month while it is still ahead of the engine (00:00–
 * 05:00 Karachi on the 1st): a monthly allocation made in those hours writes
 * the engine's month and the baseline together, so a next-month row opened
 * early would keep the superseded baseline.
 */
export function openableBudgetPeriod(now: Date, requestedPeriods: readonly string[]): string | null {
  const period = budgetPeriodOf(now)
  return requestedPeriods.includes(period) ? period : null
}

export type BudgetOpeningCandidate = {
  branchId: number
  organizationId: number | null
  baselineBudgetCents: number | null
}

export type BudgetRowOpening = {
  organizationId: number
  branchId: number
  period: string
  amountAllocatedCents: number
  amountSpentCents: 0
  amountHeldCents: 0
  amountCreditedCents: 0
}

/**
 * The rows to insert for `period`: one per branch that has no row yet and a
 * positive baseline, at that baseline and nothing spent, held or credited —
 * exactly the row the order pre-flight would open. A branch without a baseline
 * is left without a row, as the order path leaves it, because a row at 0 shows
 * the same figure and only adds a write. A branch with no tenant is never
 * given one.
 */
export function budgetRowsToOpen({
  period,
  candidates,
  existingBranchIds,
}: {
  period: string
  candidates: readonly BudgetOpeningCandidate[]
  existingBranchIds: Iterable<number>
}): BudgetRowOpening[] {
  const taken = new Set(existingBranchIds)
  const rows: BudgetRowOpening[] = []
  for (const candidate of candidates) {
    const baseline = candidate.baselineBudgetCents
    if (taken.has(candidate.branchId)) continue
    if (!Number.isSafeInteger(candidate.branchId) || candidate.branchId <= 0) continue
    if (typeof candidate.organizationId !== "number" || !Number.isSafeInteger(candidate.organizationId)) continue
    if (typeof baseline !== "number" || !Number.isSafeInteger(baseline) || baseline <= 0) continue
    taken.add(candidate.branchId)
    rows.push({
      organizationId: candidate.organizationId,
      branchId: candidate.branchId,
      period,
      amountAllocatedCents: baseline,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    })
  }
  return rows
}
