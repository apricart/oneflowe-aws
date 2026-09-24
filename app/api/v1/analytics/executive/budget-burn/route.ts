import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"
import { z } from "zod"

import { authOptions } from "@/lib/auth-options"
import {
  BUDGET_BURN_POINTS,
  BUDGET_BURN_QUERY_ROW_CAP,
  BUDGET_BURN_REASON_LABELS,
  BUDGET_BURN_THRESHOLDS,
  MONTH_KEY_PATTERN,
  buildWatchlist,
  clampWatchlistLimit,
  consumedCents,
  creatorKey,
  currentAppMonth,
  isBudgetBurnRole,
  isMonthWindowError,
  monthWindows,
  summarizeCreators,
} from "@/lib/budget-burn-risk"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { budgetFiltersFor, loadCreatorMonth } from "@/lib/server/budget-burn-queries"
import { loadBranchBudgets } from "@/lib/server/executive-analytics-queries"
import { loadScopedBranches, resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * "Users to review": requesters whose consumption of a shared branch budget
 * looks unusual this month, ranked by a documented score.
 *
 * Read-only, and presentation only — nothing is approved, blocked or charged
 * differently because a person appears here. The list names employees, so it
 * is narrower than the rest of the Center: `resolveExecutiveScope` decides
 * which rows exist for the caller exactly as it does for every executive
 * route, and `isBudgetBurnRole` then admits only the two tenant-wide
 * administrative roles. Scope parameters (`organizationId`, `branchIds`,
 * `groupIds`) can only ever narrow; the month and the row limit are the only
 * inputs of this route's own, and both are validated and bounded.
 *
 * Every creator's orders count toward a branch's consumption; only requesters
 * (`ORDER_CREATOR_ROLES`) are listed. Spend is the Center's Procurement Value
 * — exactly what the drill-down lists — and Pending is reported beside it
 * rather than folded in, so a click on a row reconciles with the figure that
 * was clicked. The growth figure is the one exception to "this month": it
 * spans `BUDGET_BURN_TREND_MONTHS` months against the same number before
 * them, so the response carries both ranges for the panel to print. See
 * `plans/OF-BUDGET-BURN-watchlist.md` and
 * `plans/OF-BUDGET-BURN-three-month-trend.md`.
 */

const querySchema = z.object({
  month: z.string().regex(MONTH_KEY_PATTERN, "month must be YYYY-MM").optional(),
  limit: z.string().regex(/^\d{1,4}$/, "limit must be a whole number").optional(),
})

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const sessionUserId = (session?.user as { id?: string } | undefined)?.id
    const limited = await withRateLimit("search", sessionUserId)
    if (limited) return limited

    const url = new URL(req.url)

    const scope = await resolveExecutiveScope(session, url.searchParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })
    if (!isBudgetBurnRole(scope.role)) {
      return NextResponse.json({ error: "Forbidden: Insufficient permissions" }, { status: 403 })
    }

    const parsedQuery = querySchema.safeParse({
      month: url.searchParams.get("month") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    })
    if (!parsedQuery.success) {
      const issue = parsedQuery.error.issues[0]
      return NextResponse.json({ error: issue?.message ?? "Invalid query", field: String(issue?.path[0] ?? "") }, { status: 400 })
    }

    const now = new Date()
    const month = parsedQuery.data.month ?? currentAppMonth(now)
    const windows = monthWindows(month, now)
    if (isMonthWindowError(windows)) {
      return NextResponse.json({ error: windows.error, field: "month" }, { status: 400 })
    }
    const limit = clampWatchlistLimit(parsedQuery.data.limit)

    // Three aggregates, not two: the month feeds Spend, Share and the late
    // window, and neither side of the growth comparison can be derived from
    // it — the trend windows span months the month window does not cover.
    const [currentRows, trendRows, priorTrendRows, budgetRows, branchList] = await Promise.all([
      loadCreatorMonth(scope, windows.current, windows.recent.start),
      loadCreatorMonth(scope, windows.trend.current, null),
      loadCreatorMonth(scope, windows.trend.prior, null),
      loadBranchBudgets(scope, budgetFiltersFor(windows.current)),
      loadScopedBranches(scope),
    ])

    const budgetByBranch = new Map(budgetRows.map((row) => [
      row.branchId,
      { totalBudgetCents: row.totalBudgetCents, remainingCents: row.remainingCents },
    ]))
    const { requesters, branches } = summarizeCreators(currentRows, budgetByBranch)
    const trendConsumedByKey = new Map(trendRows.map((row) => [creatorKey(row), consumedCents(row)]))
    const priorTrendConsumedByKey = new Map(priorTrendRows.map((row) => [creatorKey(row), consumedCents(row)]))

    const watchlist = buildWatchlist({
      requesters,
      branches,
      trendConsumedByKey,
      priorTrendConsumedByKey,
      elapsedDays: windows.current.elapsedDays,
      limit,
    })

    const identity = new Map(currentRows.map((row) => [creatorKey(row), row]))
    const branchName = new Map(branchList.map((branch) => [branch.id, branch.name]))

    return NextResponse.json({
      scope: {
        role: scope.role,
        organizationIds: scope.organizationIds,
        branchCount: branchList.length,
      },
      month: windows.month,
      windows: {
        current: {
          startDate: windows.current.start.toISOString(),
          endDate: windows.current.end.toISOString(),
          complete: windows.current.complete,
          elapsedDays: windows.current.elapsedDays,
          daysInMonth: windows.current.daysInMonth,
        },
        trend: {
          months: windows.trend.months,
          current: {
            startMonth: windows.trend.current.startMonth,
            endMonth: windows.trend.current.endMonth,
            startDate: windows.trend.current.start.toISOString(),
            endDate: windows.trend.current.end.toISOString(),
          },
          prior: {
            startMonth: windows.trend.prior.startMonth,
            endMonth: windows.trend.prior.endMonth,
            startDate: windows.trend.prior.start.toISOString(),
            endDate: windows.trend.prior.end.toISOString(),
          },
        },
        recent: {
          startDate: windows.recent.start.toISOString(),
          endDate: windows.recent.end.toISOString(),
        },
      },
      rows: watchlist.rows.map((row) => {
        const who = identity.get(creatorKey(row))
        return {
          userId: row.userId,
          requesterName: who?.requesterName ?? "Unknown requester",
          employeeId: who?.employeeId ?? null,
          role: who?.role ?? "",
          accountStatus: who?.accountStatus ?? "ACTIVE",
          branchId: row.branchId,
          branchName: branchName.get(row.branchId) ?? "Unassigned",
          score: row.score,
          reasons: row.reasons,
          metrics: row.metrics,
        }
      }),
      branches: Array.from(branches.values())
        .map((branch) => ({
          branchId: branch.branchId,
          branchName: branchName.get(branch.branchId) ?? "Unassigned",
          consumedCents: branch.consumedCents,
          otherCreatorsConsumedCents: branch.otherCreatorsConsumedCents,
          activeRequesterCount: branch.activeRequesterCount,
          totalBudgetCents: branch.totalBudgetCents,
          remainingCents: branch.remainingCents,
        }))
        .sort((left, right) => right.consumedCents - left.consumedCents),
      flaggedCount: watchlist.flaggedCount,
      unflaggedCount: watchlist.unflaggedCount,
      limit,
      truncated: [currentRows, trendRows, priorTrendRows].some((rows) => rows.length >= BUDGET_BURN_QUERY_ROW_CAP),
      thresholds: BUDGET_BURN_THRESHOLDS,
      points: BUDGET_BURN_POINTS,
      reasonLabels: BUDGET_BURN_REASON_LABELS,
    })
  } catch (error) {
    const { status, ...errorBody } = handleError(error, "EXECUTIVE_BUDGET_BURN")
    return NextResponse.json(errorBody, { status })
  }
}
