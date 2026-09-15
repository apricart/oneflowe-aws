/**
 * Reverse a committed `sync:ke --budgets=zero` run from its own report.
 *
 * WHAT THE ZERO RUN DID
 * ---------------------
 * `planZeroBudgets` in `./ke-budgets.ts` lowers every active branch's
 * allocation for one period to the `spent + held - credited` floor and clears
 * `branches.baseline_budget_cents`, and the commit report records the value
 * each row held before (`budgets.lowers[].currentCents`,
 * `budgets.baselineResets[].currentCents`). Those before-values are the only
 * faithful statement of "what it was", so the restore is planned from the
 * report rather than from the legacy platform, whose figures may have moved
 * since and differ from OneFlowe's on a handful of locations anyway.
 *
 * WHY THE BASELINE MATTERS
 * ------------------------
 * The application creates a month's `budgets` row from the branch baseline —
 * `loadSingleBranchBudget` and `syncCurrentMoneyBudgets` in
 * `app/api/v1/budgets/route.ts`, `getOrCreateCurrentBudget` in
 * `lib/server/group-order-creation.ts`. That is the "monthly allocation repeats
 * on the first of the month" behaviour. The zero run set the baseline to 0 so
 * a zeroed month would stay zero; restoring it is what switches the monthly
 * re-allocation back on. No code condition was changed.
 *
 * WHAT IS RESTORED, AND WHAT IS NOT
 * ---------------------------------
 * - A lowered allocation goes back to its before-value **only if the row is
 *   still at the value the zero run wrote**. A row that has moved since was
 *   changed by someone deliberately and is reported as `ALLOCATION_MOVED`.
 *   Raising an allocation can never break `budgets_values_valid_ck`
 *   (allocated + credited >= spent + held), so no invariant check is needed.
 * - A cleared baseline goes back **only if it is still 0**; anything else is
 *   `BASELINE_MOVED`.
 * - The rows the zero run *created* at 0 are left alone. None of those
 *   branches carried a baseline, so a 0 row is exactly what the application
 *   creates on demand; deleting it buys nothing and it would reappear.
 * - Already-restored rows count as `unchanged`, so a second run is a no-op.
 *
 * Pure, like the other planners here: the dry run and the commit necessarily
 * plan the same thing, and the plan lines are the digest the commit must
 * present.
 */

import { z } from "zod"

import type { CurrentBudget } from "./ke-budgets"

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const cents = z.number().int().nonnegative()
const branchId = z.number().int().positive()

/**
 * The parts of a `sync:ke` report this module reads. Everything else in the
 * file is ignored; a report that is not a committed zero run is refused.
 */
export const zeroRunReportSchema = z.object({
  mode: z.literal("COMMIT", { error: "the report must be from a committed run, not a dry run" }),
  generatedAt: z.string(),
  planDigest: z.string().min(1),
  organization: z.object({ id: z.number().int().positive(), code: z.string().min(1), name: z.string().min(1) }),
  options: z.object({
    budgetMode: z.literal("zero", { error: "the report must be from a --budgets=zero run" }),
    zeroPeriod: z.string().regex(PERIOD_PATTERN, "zeroPeriod must be YYYY-MM"),
  }),
  budgets: z.object({
    creates: z.array(z.object({
      branchId,
      branchName: z.string(),
      period: z.string().regex(PERIOD_PATTERN),
      amountAllocatedCents: cents,
    })),
    lowers: z.array(z.object({
      branchId,
      branchName: z.string(),
      period: z.string().regex(PERIOD_PATTERN),
      /** What the row held before the zero run — the value to restore. */
      currentCents: cents,
      /** What the zero run wrote — the value the row must still hold. */
      amountAllocatedCents: cents,
      source: z.literal("ZERO_PERIOD"),
    })),
    baselineResets: z.array(z.object({
      branchId,
      branchName: z.string(),
      /** The baseline before it was cleared — the value to restore. */
      currentCents: cents,
    })),
  }),
})

export type ZeroRunReport = z.infer<typeof zeroRunReportSchema>

/** Validate a parsed report file; throws a readable message on refusal. */
export function parseZeroRunReport(raw: unknown): ZeroRunReport {
  const result = zeroRunReportSchema.safeParse(raw)
  if (!result.success) throw new Error(`Not a committed zero-budget report:\n${z.prettifyError(result.error)}`)
  const report = result.data
  const foreignPeriod = [...report.budgets.lowers, ...report.budgets.creates]
    .find((entry) => entry.period !== report.options.zeroPeriod)
  if (foreignPeriod) {
    throw new Error(`report entry for branch ${foreignPeriod.branchId} is for ${foreignPeriod.period}, not the zeroed period ${report.options.zeroPeriod}`)
  }
  return report
}

/** A branch of the organization, as the restore needs it. */
export interface RestoreBranch {
  branchId: number
  name: string
  status: string
  baselineBudgetCents: number
}

/** `budgets.amount_allocated_cents` back to its before-value. */
export interface AllocationRestore {
  branchId: number
  branchName: string
  period: string
  /** The zeroed value the row holds now; the write is pinned to it. */
  currentCents: number
  amountAllocatedCents: number
}

/** `branches.baseline_budget_cents` back to its before-value. */
export interface BaselineRestore {
  branchId: number
  branchName: string
  baselineBudgetCents: number
  /**
   * The month row is at 0 with nothing spent or credited, so the budgets page
   * will reset it to this baseline on its next load (`syncCurrentMoneyBudgets`)
   * — as it would have before the zero run. Reported so nobody is surprised.
   */
  refundsOnNextLoad: boolean
}

export type RestoreSkipReason = "ROW_MISSING" | "ALLOCATION_MOVED" | "BRANCH_MISSING" | "BASELINE_MOVED"

export interface RestoreSkip {
  kind: "ALLOCATION" | "BASELINE"
  branchId: number
  branchName: string
  period?: string
  reason: RestoreSkipReason
  detail: string
}

export interface RestorePlan {
  period: string
  /** The report's own digest, folded into this plan's digest. */
  sourcePlanDigest: string
  allocationRestores: AllocationRestore[]
  baselineRestores: BaselineRestore[]
  skipped: RestoreSkip[]
  unchanged: { allocations: number; baselines: number }
  /** Rows the zero run created at 0; left as they are — see the header. */
  createdAtZero: number
}

/**
 * Decide what goes back, from the report's before-values and the rows as they
 * stand now. `currentBudgets` may hold every period of the organization; only
 * the report's period is consulted.
 */
export function planBudgetRestore(
  report: ZeroRunReport,
  currentBudgets: readonly CurrentBudget[],
  branches: readonly RestoreBranch[],
): RestorePlan {
  const period = report.options.zeroPeriod
  const budgetByBranch = new Map(
    currentBudgets.filter((row) => row.period === period).map((row) => [row.branchId, row]),
  )
  const branchById = new Map(branches.map((branch) => [branch.branchId, branch]))

  const allocationRestores: AllocationRestore[] = []
  const baselineRestores: BaselineRestore[] = []
  const skipped: RestoreSkip[] = []
  const unchanged = { allocations: 0, baselines: 0 }

  for (const lowered of report.budgets.lowers) {
    const current = budgetByBranch.get(lowered.branchId)
    if (!current) {
      skipped.push({
        kind: "ALLOCATION",
        branchId: lowered.branchId,
        branchName: lowered.branchName,
        period,
        reason: "ROW_MISSING",
        detail: `no ${period} budget row for this branch`,
      })
      continue
    }
    if (current.amountAllocatedCents === lowered.currentCents) {
      unchanged.allocations += 1
      continue
    }
    if (current.amountAllocatedCents !== lowered.amountAllocatedCents) {
      skipped.push({
        kind: "ALLOCATION",
        branchId: lowered.branchId,
        branchName: lowered.branchName,
        period,
        reason: "ALLOCATION_MOVED",
        detail: `row holds ${current.amountAllocatedCents}, not the ${lowered.amountAllocatedCents} the zero run wrote; left alone`,
      })
      continue
    }
    allocationRestores.push({
      branchId: lowered.branchId,
      branchName: lowered.branchName,
      period,
      currentCents: current.amountAllocatedCents,
      amountAllocatedCents: lowered.currentCents,
    })
  }

  // Allocation restores above are what the month row will hold afterwards;
  // the re-fund warning looks at the row as it will be, not as it is.
  const restoredAllocation = new Map(allocationRestores.map((entry) => [entry.branchId, entry.amountAllocatedCents]))

  for (const reset of report.budgets.baselineResets) {
    const branch = branchById.get(reset.branchId)
    if (!branch) {
      skipped.push({
        kind: "BASELINE",
        branchId: reset.branchId,
        branchName: reset.branchName,
        reason: "BRANCH_MISSING",
        detail: "no branch with this id in the organization",
      })
      continue
    }
    if (branch.baselineBudgetCents === reset.currentCents) {
      unchanged.baselines += 1
      continue
    }
    if (branch.baselineBudgetCents !== 0) {
      skipped.push({
        kind: "BASELINE",
        branchId: reset.branchId,
        branchName: reset.branchName,
        reason: "BASELINE_MOVED",
        detail: `baseline is ${branch.baselineBudgetCents}, not the 0 the zero run wrote; left alone`,
      })
      continue
    }
    const row = budgetByBranch.get(reset.branchId)
    const allocationAfter = restoredAllocation.get(reset.branchId) ?? row?.amountAllocatedCents ?? null
    baselineRestores.push({
      branchId: reset.branchId,
      branchName: branch.name,
      baselineBudgetCents: reset.currentCents,
      refundsOnNextLoad: row !== undefined && allocationAfter === 0
        && row.amountSpentCents === 0 && row.amountCreditedCents === 0,
    })
  }

  return {
    period,
    sourcePlanDigest: report.planDigest,
    allocationRestores,
    baselineRestores,
    skipped,
    unchanged,
    createdAtZero: report.budgets.creates.length,
  }
}

/**
 * One line per write, in a fixed order, plus the source report's digest. The
 * commit must present the SHA-256 of these lines, so a plan built from a
 * different report, or against rows that moved, never matches.
 */
export function restorePlanLines(plan: RestorePlan): string[] {
  return [
    `SOURCE ${plan.sourcePlanDigest}`,
    `PERIOD ${plan.period}`,
    ...plan.allocationRestores
      .map((entry) => `ALLOC ${entry.branchId} ${entry.period} ${entry.currentCents} -> ${entry.amountAllocatedCents}`)
      .sort(),
    ...plan.baselineRestores
      .map((entry) => `BASELINE ${entry.branchId} 0 -> ${entry.baselineBudgetCents}`)
      .sort(),
  ]
}

export interface RestoreCounts {
  period: string
  allocationsToRestore: number
  baselinesToRestore: number
  refundOnNextLoad: number
  unchangedAllocations: number
  unchangedBaselines: number
  skipped: number
  createdAtZeroLeftAlone: number
  /** Allocation put back across every restore, in cents. */
  totalRestoredCents: number
}

export function summarizeRestore(plan: RestorePlan): RestoreCounts {
  return {
    period: plan.period,
    allocationsToRestore: plan.allocationRestores.length,
    baselinesToRestore: plan.baselineRestores.length,
    refundOnNextLoad: plan.baselineRestores.filter((entry) => entry.refundsOnNextLoad).length,
    unchangedAllocations: plan.unchanged.allocations,
    unchangedBaselines: plan.unchanged.baselines,
    skipped: plan.skipped.length,
    createdAtZeroLeftAlone: plan.createdAtZero,
    totalRestoredCents: plan.allocationRestores
      .reduce((sum, entry) => sum + entry.amountAllocatedCents - entry.currentCents, 0),
  }
}
