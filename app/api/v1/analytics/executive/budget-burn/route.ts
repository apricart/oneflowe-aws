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
  creatorKey,
  currentAppMonth,
  isBudgetBurnRole,
  isMonthWindowError,
  monthWindows,
  patternByCreator,
  summarizeCreators,
  unionCreators,
} from "@/lib/budget-burn-risk"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { budgetFiltersFor, loadCreatorMonth } from "@/lib/server/budget-burn-queries"
import { loadBranchBudgets } from "@/lib/server/executive-analytics-queries"
import { loadScopedBranches, resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * "Users to review": each requester's consumption in the
 * `BUDGET_BURN_PATTERN_MONTHS` months ending with the selected one, with the
 * newest month highlighted where it is at least `momSpikePct` above the one
 * before it.
 *
 * Read-only, and presentation only — nothing is approved, blocked or charged
 * differently because a person appears here or is highlighted. The list names
 * employees, so it is narrower than the rest of the Center:
 * `resolveExecutiveScope` decides which rows exist for the caller exactly as
 * it does for every executive route, and `isBudgetBurnRole` then admits only
 * the two tenant-wide administrative roles. Scope parameters
 * (`organizationId`, `branchIds`, `groupIds`) can only ever narrow; the month
 * and the row limit are the only inputs of this route's own, and both are
 * validated and bounded.
 *
 * Every creator's orders count toward a branch's consumption; only requesters
 * (`ORDER_CREATOR_ROLES`) are listed, and they are listed if they consumed in
 * *any* month of the pattern, not only the selected one — dropping the person
 * who spent heavily last month and nothing this month would hide the most
 * telling shape the panel exists to show. Spend is the Center's Procurement
 * Value — exactly what the drill-down lists — and Pending is carried beside
 * it in every month cell, so a click on a cell reconciles with the figure
 * that was clicked. See `plans/OF-BUDGET-BURN-watchlist.md` and
 * `plans/OF-BUDGET-BURN-three-month-pattern-mom-flag.md`.
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

    // One aggregate per month of the pattern, oldest first. The newest bucket
    // covers exactly the selected month, so it also feeds Spend, Share, the
    // late window and the branch denominators — no month is read twice.
    const lastBucket = windows.pattern.length - 1
    const [patternRows, budgetRows, branchList] = await Promise.all([
      Promise.all(windows.pattern.map((bucket, index) => loadCreatorMonth(
        scope,
        bucket,
        index === lastBucket ? windows.recent.start : null,
      ))),
      loadBranchBudgets(scope, budgetFiltersFor(windows.current)),
      loadScopedBranches(scope),
    ])
    const currentRows = patternRows[lastBucket] ?? []

    const budgetByBranch = new Map(budgetRows.map((row) => [
      row.branchId,
      { totalBudgetCents: row.totalBudgetCents, remainingCents: row.remainingCents },
    ]))
    // Denominators stay on the selected month — Share, peers and high-held are
    // all about the pot as it stands now — while the listed set is the union
    // across every month of the pattern, carrying the selected month's figures.
    const { branches } = summarizeCreators(currentRows, budgetByBranch)
    const everyCreator = unionCreators(patternRows)
    const { requesters } = summarizeCreators(everyCreator)
    const patternMonths = windows.pattern.map((bucket) => bucket.month)
    const monthsByKey = patternByCreator(patternMonths, patternRows)

    const watchlist = buildWatchlist({
      requesters,
      branches,
      patternMonths,
      monthsByKey,
      elapsedDays: windows.current.elapsedDays,
      limit,
    })

    // `unionCreators` resolves newest-first, so a person absent from the
    // selected month is still named from the most recent month holding them.
    const identity = new Map(everyCreator.map((row) => [creatorKey(row), row]))
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
        pattern: windows.pattern.map((bucket) => ({
          month: bucket.month,
          startDate: bucket.start.toISOString(),
          endDate: bucket.end.toISOString(),
          complete: bucket.complete,
        })),
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
      /** Requesters whose newest month is at least `momSpikePct` above the one before it. */
      highlightedCount: watchlist.highlightedCount,
      /** How many the retired multi-signal score would have listed; nothing on the panel uses it. */
      scoreFlaggedCount: watchlist.scoreFlaggedCount,
      /** Every requester in scope across the pattern, of which `rows` is the top `limit`. */
      requesterCount: watchlist.requesterCount,
      limit,
      truncated: patternRows.some((rows) => rows.length >= BUDGET_BURN_QUERY_ROW_CAP),
      thresholds: BUDGET_BURN_THRESHOLDS,
      points: BUDGET_BURN_POINTS,
      reasonLabels: BUDGET_BURN_REASON_LABELS,
    })
  } catch (error) {
    const { status, ...errorBody } = handleError(error, "EXECUTIVE_BUDGET_BURN")
    return NextResponse.json(errorBody, { status })
  }
}
