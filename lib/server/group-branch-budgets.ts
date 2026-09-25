import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { branches, budgets } from "@/db/schema"
import {
  summarizeBranchBudget,
  type BranchBudgetSummary,
} from "@/lib/branch-budget-summary"
import { db } from "@/lib/db"
import { budgetPeriodOf } from "@/lib/budget-consumption"

/**
 * Read-only money-budget figures for a set of branches the caller has already
 * been authorized for.
 *
 * Two deliberate properties:
 *
 *  * It writes nothing. `/api/v1/budgets` and the ordering engine open a period
 *    row from the branch baseline when one is missing; this only reports what
 *    such a row would hold, so displaying a budget can never create ledger rows
 *    or race the transaction that takes the holds.
 *  * It re-asserts the tenant on the read itself. The branch ids arrive already
 *    scoped, and pinning the organization again means a stale or crafted id
 *    still cannot surface another tenant's figures.
 */

/**
 * The period the ordering engine bills against.
 *
 * Deliberately the same UTC `YYYY-MM` slice used by
 * `lib/server/group-order-creation.ts`, `app/api/v1/budgets`, and the shop, and
 * deliberately *not* the Asia/Karachi month used by the analytics range
 * helpers: the number shown here has to be the one the next order is checked
 * against, not the one a report would total.
 */
export function currentBudgetPeriod(now: Date = new Date()): string {
  return budgetPeriodOf(now)
}

export async function loadBranchBudgetSummaries({
  organizationId,
  branchIds,
  period,
}: {
  organizationId: number
  branchIds: number[]
  period: string
}): Promise<BranchBudgetSummary[]> {
  if (!organizationId || branchIds.length === 0) return []

  const rows = await db
    .select({
      branchId: branches.id,
      baselineBudgetCents: branches.baselineBudgetCents,
      amountAllocatedCents: budgets.amountAllocatedCents,
      amountSpentCents: budgets.amountSpentCents,
      amountHeldCents: budgets.amountHeldCents,
      amountCreditedCents: budgets.amountCreditedCents,
      budgetId: budgets.id,
    })
    .from(branches)
    .leftJoin(
      budgets,
      and(
        eq(budgets.branchId, branches.id),
        eq(budgets.period, period),
        // The period row carries its own tenant column; matching it here keeps
        // a mismatched row from being read as this branch's budget.
        eq(budgets.organizationId, organizationId),
      ),
    )
    .where(and(
      inArray(branches.id, branchIds),
      eq(branches.organizationId, organizationId),
    ))

  return rows.map((row) => summarizeBranchBudget({
    branchId: row.branchId,
    period,
    baselineBudgetCents: row.baselineBudgetCents,
    budget: row.budgetId === null ? null : {
      amountAllocatedCents: row.amountAllocatedCents,
      amountSpentCents: row.amountSpentCents,
      amountHeldCents: row.amountHeldCents,
      amountCreditedCents: row.amountCreditedCents,
    },
  }))
}
