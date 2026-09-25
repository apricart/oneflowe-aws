import "server-only"

import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm"

import { auditLogs, budgetAddons, budgets } from "@/db/schema"
import {
  openAddons,
  planAddonSettlement,
  type AddonSettlementPlan,
  type OpenBudgetAddon,
} from "@/lib/budget-addon-expiry"
import { db } from "@/lib/db"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const BUDGET_ADDON_EXPIRY_AUDIT_ACTION = "EXPIRE_BUDGET_ADDON"
export const BUDGET_ADDON_RESET_AUDIT_ACTION = "RESET_BUDGET_ADDONS"

export type BudgetAddonSettlement = {
  budgetId: number
  branchId: number
  organizationId: number
  period: string
  plan: AddonSettlementPlan
}

/**
 * What a budget read carries about each add-on in force: enough for the
 * Budgets page and the shop to show the figure and its date, and nothing an
 * ordering employee has no business seeing (the administrator's reason stays
 * on the ledger row).
 */
export type BudgetAddonView = {
  id: number
  amountCents: number
  validUntil: Date | null
}

/**
 * Settle the add-ons on one budget row that are due at `now`, on a
 * transaction that already holds — or is about to take — the row lock.
 *
 * This is the piece the ordering engine calls between locking the budget
 * row and taking its hold, so an expired add-on can never be spent, and the
 * piece every other path reuses. It re-reads the row under `FOR UPDATE`
 * itself, so a caller that already locked it pays one cheap re-read and a
 * concurrent settlement finds nothing left to do.
 *
 * Returns `null` when nothing was due; otherwise the settlement it wrote,
 * with the plan whose `creditedAfterCents` is now the row's figure.
 */
export async function settleDueAddonsOnBudget(
  tx: Tx,
  budgetId: number,
  now: Date,
  options: { actorUserId?: string | null; closeAll?: boolean } = {},
): Promise<BudgetAddonSettlement | null> {
  const [row] = await tx
    .select({
      id: budgets.id,
      branchId: budgets.branchId,
      organizationId: budgets.organizationId,
      period: budgets.period,
      amountAllocatedCents: budgets.amountAllocatedCents,
      amountSpentCents: budgets.amountSpentCents,
      amountHeldCents: budgets.amountHeldCents,
      amountCreditedCents: budgets.amountCreditedCents,
    })
    .from(budgets)
    .where(eq(budgets.id, budgetId))
    .for("update")
  if (!row) return null

  const open: OpenBudgetAddon[] = await tx
    .select({
      id: budgetAddons.id,
      amountCents: budgetAddons.amountCents,
      validUntil: budgetAddons.validUntil,
      expiredAt: budgetAddons.expiredAt,
    })
    .from(budgetAddons)
    .where(and(eq(budgetAddons.budgetId, budgetId), isNull(budgetAddons.expiredAt)))

  const plan = planAddonSettlement(row, open, now, { closeAll: options.closeAll })
  if (plan.forfeits.length === 0) return null

  for (const forfeit of plan.forfeits) {
    await tx
      .update(budgetAddons)
      .set({ expiredAt: now, forfeitedCents: forfeit.forfeitedCents })
      .where(and(eq(budgetAddons.id, forfeit.addonId), isNull(budgetAddons.expiredAt)))
  }

  if (plan.withdrawnCents > 0) {
    await tx
      .update(budgets)
      .set({
        amountCreditedCents: sql`${budgets.amountCreditedCents} - ${plan.withdrawnCents}`,
        updatedAt: now,
      })
      .where(eq(budgets.id, budgetId))
  }

  await tx.insert(auditLogs).values({
    userId: options.actorUserId ?? null,
    organizationId: row.organizationId,
    branchId: row.branchId,
    action: options.closeAll ? BUDGET_ADDON_RESET_AUDIT_ACTION : BUDGET_ADDON_EXPIRY_AUDIT_ACTION,
    entity: "BUDGET",
    entityId: String(row.branchId),
    metadata: {
      budgetId,
      period: row.period,
      settledAt: now.toISOString(),
      withdrawnCents: plan.withdrawnCents,
      creditedBeforeCents: plan.creditedBeforeCents,
      creditedAfterCents: plan.creditedAfterCents,
      remainingBeforeCents: plan.remainingBeforeCents,
      remainingAfterCents: plan.remainingAfterCents,
      addons: plan.forfeits,
    },
  })

  return {
    budgetId,
    branchId: row.branchId,
    organizationId: row.organizationId,
    period: row.period,
    plan,
  }
}

export type DueAddonFilter =
  | { budgetIds: number[] }
  | { branchIds: number[]; periods: string[] }
  | { all: true; limit?: number }

/**
 * Which budget rows have an add-on due at `now`. One indexed query; the
 * common answer is "none", and then nothing else runs.
 */
export async function findBudgetsWithDueAddons(client: DbClient, filter: DueAddonFilter, now: Date): Promise<number[]> {
  const due = and(isNull(budgetAddons.expiredAt), lte(budgetAddons.validUntil, now))

  if ("budgetIds" in filter) {
    if (filter.budgetIds.length === 0) return []
    const rows = await client
      .selectDistinct({ budgetId: budgetAddons.budgetId })
      .from(budgetAddons)
      .where(and(due, inArray(budgetAddons.budgetId, filter.budgetIds)))
    return rows.map((row) => row.budgetId)
  }

  if ("branchIds" in filter) {
    if (filter.branchIds.length === 0 || filter.periods.length === 0) return []
    const rows = await client
      .selectDistinct({ budgetId: budgetAddons.budgetId })
      .from(budgetAddons)
      .innerJoin(budgets, eq(budgets.id, budgetAddons.budgetId))
      .where(and(due, inArray(budgets.branchId, filter.branchIds), inArray(budgets.period, filter.periods)))
    return rows.map((row) => row.budgetId)
  }

  const rows = await client
    .selectDistinct({ budgetId: budgetAddons.budgetId })
    .from(budgetAddons)
    .where(due)
    .limit(filter.limit ?? 200)
  return rows.map((row) => row.budgetId)
}

/**
 * Settle every due add-on the filter reaches, one short transaction per
 * budget row so a single contended branch never holds the others up.
 *
 * The caller passes ids it has already scoped (the budgets list, a single
 * branch, an order's budget); the `all` filter is for the sweep behind
 * `CRON_SECRET` only. Returns the settlements that changed something, so a
 * read path can decide whether to re-load.
 */
export async function settleDueBudgetAddons(
  client: DbClient,
  filter: DueAddonFilter,
  now: Date = new Date(),
  options: { actorUserId?: string | null } = {},
): Promise<BudgetAddonSettlement[]> {
  const budgetIds = await findBudgetsWithDueAddons(client, filter, now)
  const settlements: BudgetAddonSettlement[] = []
  for (const budgetId of budgetIds) {
    const settlement = await client.transaction((tx) => settleDueAddonsOnBudget(tx, budgetId, now, options))
    if (settlement) settlements.push(settlement)
  }
  return settlements
}

/**
 * The add-ons still in force on each of the given budget rows — what the
 * Budgets page and the shop show next to the credited figure. Read-only;
 * the caller has already settled or does not need to.
 */
export async function loadOpenBudgetAddons(
  client: DbClient,
  budgetIds: number[],
  now: Date = new Date(),
): Promise<Map<number, BudgetAddonView[]>> {
  const byBudget = new Map<number, BudgetAddonView[]>()
  if (budgetIds.length === 0) return byBudget

  const rows = await client
    .select({
      id: budgetAddons.id,
      budgetId: budgetAddons.budgetId,
      amountCents: budgetAddons.amountCents,
      validUntil: budgetAddons.validUntil,
      expiredAt: budgetAddons.expiredAt,
    })
    .from(budgetAddons)
    .where(and(inArray(budgetAddons.budgetId, budgetIds), isNull(budgetAddons.expiredAt)))
    .orderBy(budgetAddons.validUntil, budgetAddons.id)

  for (const row of openAddons(rows, now)) {
    const list = byBudget.get(row.budgetId) ?? []
    list.push({ id: row.id, amountCents: row.amountCents, validUntil: row.validUntil })
    byBudget.set(row.budgetId, list)
  }
  return byBudget
}
