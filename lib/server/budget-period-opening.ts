import "server-only"

import { and, eq, gt, inArray } from "drizzle-orm"

import { branches, budgets } from "@/db/schema"
import { budgetRowsToOpen, openableBudgetPeriod } from "@/lib/budget-period-opening"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { db } from "@/lib/db"
import { budgetEnabledBranchSql } from "@/lib/server/organization-budget-policy"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Rows per INSERT, far below Postgres' bind-parameter ceiling. */
const INSERT_CHUNK = 500

/**
 * Open the engine's current month for every listed branch that has no row
 * for it yet, at the branch's baseline — the row the next order would open
 * anyway. Returns the branch ids it opened.
 *
 * `branchIds` must already be the caller's scope; the read below still
 * re-asserts the rest of the rule from the database rather than from what the
 * caller selected: only active branches of a tenant with budget allocation on,
 * and only a positive baseline read at this moment. A row that appears
 * between the read and the insert (an order, a second viewer) wins through
 * the `(branch_id, period)` unique index and is left exactly as it is.
 *
 * Writes no audit row, as the order path's lazy opening writes none: the
 * figure is the branch's existing baseline, not a decision.
 */
export async function openCurrentBudgetPeriodRows(
  client: DbClient,
  { branchIds, requestedPeriods, now = new Date() }: {
    branchIds: readonly number[]
    requestedPeriods: readonly string[]
    now?: Date
  },
): Promise<number[]> {
  const period = openableBudgetPeriod(now, requestedPeriods)
  if (!period || branchIds.length === 0) return []
  // The pure rule already pins this; restated so the period written here can
  // only ever be the engine's own month.
  if (period !== budgetPeriodOf(now)) return []

  const candidates = await client
    .select({
      branchId: branches.id,
      organizationId: branches.organizationId,
      baselineBudgetCents: branches.baselineBudgetCents,
      existingBudgetId: budgets.id,
    })
    .from(branches)
    .leftJoin(budgets, and(eq(budgets.branchId, branches.id), eq(budgets.period, period)))
    .where(and(
      inArray(branches.id, [...branchIds]),
      eq(branches.status, "active"),
      gt(branches.baselineBudgetCents, 0),
      budgetEnabledBranchSql(),
    ))

  const rows = budgetRowsToOpen({
    period,
    candidates,
    existingBranchIds: candidates
      .filter((candidate) => candidate.existingBudgetId !== null)
      .map((candidate) => candidate.branchId),
  })

  const opened: number[] = []
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const inserted = await client
      .insert(budgets)
      .values(rows.slice(start, start + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ branchId: budgets.branchId })
    opened.push(...inserted.map((row) => row.branchId))
  }
  return opened
}
