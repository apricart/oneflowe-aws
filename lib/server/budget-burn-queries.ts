import "server-only"

import { and, desc, eq, sql } from "drizzle-orm"

import { orders, roles, users } from "@/db/schema"
import { BUDGET_BURN_QUERY_ROW_CAP, type CreatorMonth } from "@/lib/budget-burn-risk"
import { db } from "@/lib/db"
import { REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { orderConditions, type ExecutiveFilters } from "@/lib/server/executive-analytics-queries"
import type { ExecutiveScope } from "@/lib/server/executive-analytics-scope"
import { aggregatedRequesterRoleSql } from "@/lib/server/order-creator-role-sql"

/**
 * The aggregate behind the budget-burn watchlist: one row per creator per
 * branch for one window.
 *
 * Order grain, rooted at `orders` and never joined to `order_items`, so the
 * money is `total_cents − refund_amount_cents` — the same expression as the
 * Center's Procurement Value and the budget `heldCents` in `loadBranchBudgets`.
 * The two joins are 1:1 (a creator has one user row, a user one role) and
 * cannot multiply orders.
 *
 * The fence is `orderConditions(scope, …)` — byte-identical to every other
 * executive read — so this cannot name a branch the caller could not already
 * see in aggregate. Every creator's orders count; whether a row is *listed* is
 * decided later by role, in `summarizeCreators`, from the same rows.
 */

export type CreatorMonthRow = CreatorMonth & {
  requesterName: string
  employeeId: string | null
  accountStatus: "ACTIVE" | "INACTIVE" | "DELETED"
}

/** Net order value, floored at zero — the Center's order-grain money. */
const netOrderValue = sql`GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0))`

const pendingFilter = sql`UPPER(${orders.status}) = 'PENDING'`
/** Approver rejections only. A CANCELLED order is a withdrawal and says nothing. */
const rejectedFilter = sql`UPPER(${orders.status}) = 'REJECTED'`

function filtersFor(window: { start: Date; end: Date }): ExecutiveFilters {
  return {
    startDate: window.start,
    endDate: window.end,
    categoryIds: [],
    productIds: [],
    groupIds: [],
    userIds: [],
    unit: null,
  }
}

export async function loadCreatorMonth(
  scope: ExecutiveScope,
  window: { start: Date; end: Date },
  /** Start of the late window; `null` when the caller does not need the recent figure. */
  recentStart: Date | null,
): Promise<CreatorMonthRow[]> {
  const recentConsumed = recentStart
    ? sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${recentStart} AND (${REVENUE_ELIGIBLE_FILTER} OR ${pendingFilter}) THEN ${netOrderValue} ELSE 0 END), 0)`.mapWith(Number)
    : sql<number>`0`.mapWith(Number)

  const spendCents = sql<number>`COALESCE(SUM(CASE WHEN ${REVENUE_ELIGIBLE_FILTER} THEN ${netOrderValue} ELSE 0 END), 0)`.mapWith(Number)
  const pendingCents = sql<number>`COALESCE(SUM(CASE WHEN ${pendingFilter} THEN ${netOrderValue} ELSE 0 END), 0)`.mapWith(Number)

  const rows = await db
    .select({
      userId: orders.createdByUserId,
      branchId: orders.branchId,
      // One role per creator per branch, aggregated — never the per-row value.
      //
      // `isOrderCreatorRole` decides from this which rows are *listed*. Keyed on
      // the live role, a promoted requester would drop off the panel taking
      // their consumption history with them while the branch denominators kept
      // counting it. Keyed on the per-row recorded role, a person whose role
      // changed mid-window would split into two rows and `creatorKey`
      // (`userId:branchId`) would then either list them twice with their spend
      // divided or drop one row outright in `unionCreators`.
      role: aggregatedRequesterRoleSql,
      // Falls back through the identifiers a person may actually have, so a
      // row is never labelled with a bare UUID — and never with an email.
      requesterName: sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), ${users.employeeId}, ${users.username}, 'Unknown requester')`,
      employeeId: users.employeeId,
      accountStatus: sql<string>`CASE WHEN ${users.deletedAt} IS NOT NULL THEN 'DELETED' WHEN ${users.isActive} = TRUE THEN 'ACTIVE' ELSE 'INACTIVE' END`,
      spendCents,
      pendingCents,
      orderCount: sql<number>`COALESCE(COUNT(CASE WHEN ${REVENUE_ELIGIBLE_FILTER} THEN 1 END), 0)`.mapWith(Number),
      pendingOrderCount: sql<number>`COALESCE(COUNT(CASE WHEN ${pendingFilter} THEN 1 END), 0)`.mapWith(Number),
      rejectedOrderCount: sql<number>`COALESCE(COUNT(CASE WHEN ${rejectedFilter} THEN 1 END), 0)`.mapWith(Number),
      recentConsumedCents: recentConsumed,
    })
    .from(orders)
    .innerJoin(users, eq(orders.createdByUserId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(...orderConditions(scope, filtersFor(window), { revenueEligible: false })))
    .groupBy(
      orders.createdByUserId,
      orders.branchId,
      // Deliberately no role here: `aggregatedRequesterRoleSql` is an aggregate
      // over the group precisely so this stays one row per creator per branch.
      users.fullName,
      users.employeeId,
      users.username,
      users.isActive,
      users.deletedAt,
    )
    // Largest consumers first, so if the cap ever bites it drops the quietest.
    .orderBy(desc(sql`${spendCents} + ${pendingCents}`))
    .limit(BUDGET_BURN_QUERY_ROW_CAP)

  return rows.map((row) => ({
    userId: String(row.userId),
    branchId: Number(row.branchId),
    role: String(row.role ?? "").toUpperCase().replace(/\s+/g, "_"),
    requesterName: String(row.requesterName),
    employeeId: row.employeeId ?? null,
    accountStatus: row.accountStatus === "DELETED" || row.accountStatus === "INACTIVE" ? row.accountStatus : "ACTIVE",
    spendCents: Number(row.spendCents) || 0,
    pendingCents: Number(row.pendingCents) || 0,
    orderCount: Number(row.orderCount) || 0,
    pendingOrderCount: Number(row.pendingOrderCount) || 0,
    rejectedOrderCount: Number(row.rejectedOrderCount) || 0,
    recentConsumedCents: Number(row.recentConsumedCents) || 0,
  }))
}

/** The filters `loadBranchBudgets` needs for the same window, so both reads agree on the month. */
export function budgetFiltersFor(window: { start: Date; end: Date }): ExecutiveFilters {
  return filtersFor(window)
}
