import "server-only"

import { and, eq, inArray, sql } from "drizzle-orm"

import { branches, orders, organizations } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * Server side of `lib/organization-budget-policy.ts`.
 *
 * Nothing here is cached. The setting is one boolean on the organization row,
 * read by primary key, and a stale "off" would let an order skip a budget the
 * tenant has just switched on.
 *
 * The setting is read through `to_jsonb`, as `lib/order-select.ts` reads the
 * newer order columns: production migrations are applied by hand, and an
 * application running ahead of this one must keep every tenant's budget
 * control — which is exactly what a missing column reading "on" does.
 */

type Reader = Pick<typeof db, "select">

const budgetsEnabledColumn = sql<boolean>`COALESCE((to_jsonb("organizations") ->> 'budgets_enabled')::boolean, true)`

/**
 * Whether an organization has budget allocation switched on.
 *
 * An id that names no organization answers `true`: the budget control stays in
 * place rather than being dropped because a lookup came back empty. Every
 * caller has already resolved the organization it passes.
 */
export async function isOrganizationBudgetEnabled(
  organizationId: number | null | undefined,
  reader: Reader = db,
): Promise<boolean> {
  if (!Number.isInteger(organizationId) || Number(organizationId) <= 0) return true
  const [row] = await reader
    .select({ budgetsEnabled: budgetsEnabledColumn })
    .from(organizations)
    .where(eq(organizations.id, Number(organizationId)))
    .limit(1)
  return row?.budgetsEnabled !== false
}

/**
 * Whether an order being created now takes a budget hold, read inside the
 * creation transaction under a shared lock on the organization row.
 *
 * The organization PATCH holds `FOR UPDATE` on that row, so an order commits
 * wholly under the old or the new setting. The answer is stored on the order
 * as `budget_tracked` and is what every later ledger move reads.
 */
export async function resolveOrderBudgetTracking(tx: any, organizationId: number): Promise<boolean> {
  const [row] = await tx
    .select({ budgetsEnabled: budgetsEnabledColumn })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("share")
    .limit(1)
  if (!row) throw new Error("ORGANIZATION_NOT_FOUND")
  return row.budgetsEnabled !== false
}

/** The organizations among `organizationIds` that have budgets switched off. */
export async function loadBudgetDisabledOrganizationIds(
  organizationIds: readonly number[],
): Promise<Set<number>> {
  const ids = Array.from(new Set(organizationIds.filter((id) => Number.isInteger(id) && id > 0)))
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(inArray(organizations.id, ids), eq(organizations.budgetsEnabled, false)))
  return new Set(rows.map((row) => row.id))
}

/**
 * The branches among `branchIds` whose organization tracks budgets. A budget
 * reader keys its ledger read on this so a disabled tenant's kept rows never
 * surface as a live budget.
 */
export async function loadBudgetTrackedBranchIds(branchIds: readonly number[]): Promise<Set<number>> {
  const ids = Array.from(new Set(branchIds.filter((id) => Number.isInteger(id) && id > 0)))
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .innerJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(and(inArray(branches.id, ids), eq(organizations.budgetsEnabled, true)))
  return new Set(rows.map((row) => row.id))
}

/** `branches` predicate: the branch's organization tracks budgets. */
export function budgetEnabledBranchSql() {
  return sql`${branches.organizationId} IN (SELECT ${organizations.id} FROM ${organizations} WHERE ${organizations.budgetsEnabled} = true)`
}

/**
 * `orders` predicate: the order took a budget hold. Every order-derived budget
 * figure carries it, so an order placed while budgets were off is never counted
 * against a budget the ledger never charged it to.
 */
export function budgetTrackedOrderSql() {
  return eq(orders.budgetTracked, true)
}
