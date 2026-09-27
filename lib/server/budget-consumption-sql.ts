import "server-only"

import { sql } from "drizzle-orm"

import { orders } from "@/db/schema"
import { CONSUMED_HELD_STATUSES, CONSUMED_SPENT_STATUSES } from "@/lib/budget-consumption"

/**
 * The consumption rules of `lib/budget-consumption.ts`, as SQL.
 *
 * Every order-derived money aggregate in the application is built from these
 * three fragments. They exist so the database and the TypeScript cannot answer
 * the same question differently — the statuses come from the same constants,
 * the refund clamp is the same clamp, and the period is the same UTC month the
 * order lifecycle wrote its hold against.
 *
 * See `plans/OF-BUDGET-ledger-orders-parity.md`.
 */

/** `('A', 'B')` — a status list as a SQL tuple, parameterized. */
function statusTuple(statuses: readonly string[]) {
  return sql.join(statuses.map((status) => sql`${status}`), sql`, `)
}

/** `max(0, total - refund)` — the per-order net, matching `orderConsumptionCents`. */
const netOrderCents = sql`GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0))`

/**
 * Sum of net order value after the caller has selected an allowlisted status
 * population in its WHERE clause.
 */
export function netOrderCentsSql() {
  return sql<number>`COALESCE(SUM(${netOrderCents}), 0)`.mapWith(Number)
}

/** Sum of the orders that are money already spent, net of refunds. */
export function consumedSpentCentsSql() {
  return sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN (${statusTuple(CONSUMED_SPENT_STATUSES)}) THEN ${netOrderCents} ELSE 0 END), 0)`.mapWith(Number)
}

/** Sum of the orders that are money committed and not yet spent, net of refunds. */
export function consumedHeldCentsSql() {
  return sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN (${statusTuple(CONSUMED_HELD_STATUSES)}) THEN ${netOrderCents} ELSE 0 END), 0)`.mapWith(Number)
}

/**
 * The budget period an order belongs to, as `YYYY-MM`.
 *
 * `created_at` is `timestamptz`, so a bare `TO_CHAR` would render it in the
 * Postgres session's time zone — a value this application never sets and
 * therefore cannot rely on. `AT TIME ZONE 'UTC'` pins the bucket to the same
 * UTC month `budgetPeriodOf` names and the ledger row carries.
 */
export function orderBudgetPeriodSql() {
  return sql<string>`TO_CHAR(${orders.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM')`
}

/**
 * The calendar month and year an order's period falls in, for the callers that
 * filter by month or year rather than by period string. Same UTC basis as
 * `orderBudgetPeriodSql`, so a filtered set and its bucket labels agree.
 */
export function orderBudgetMonthSql() {
  return sql<number>`EXTRACT(MONTH FROM ${orders.createdAt} AT TIME ZONE 'UTC')`
}

export function orderBudgetYearSql() {
  return sql<number>`EXTRACT(YEAR FROM ${orders.createdAt} AT TIME ZONE 'UTC')`
}
