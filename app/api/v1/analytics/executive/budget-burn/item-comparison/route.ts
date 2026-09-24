import { getServerSession } from "next-auth"
import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"

import { authOptions } from "@/lib/auth-options"
import {
  BUDGET_BURN_ITEM_ROW_CAP,
  buildItemComparison,
} from "@/lib/budget-burn-item-comparison"
import {
  MONTH_KEY_PATTERN,
  currentAppMonth,
  isBudgetBurnRole,
  isMonthWindowError,
  monthWindows,
} from "@/lib/budget-burn-risk"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadProductWindow } from "@/lib/server/budget-burn-item-queries"
import type { ExecutiveFilters } from "@/lib/server/executive-analytics-queries"
import { resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

const querySchema = z.object({
  userId: z.string().trim().min(1, "userId is required").max(64, "userId is too long"),
  month: z.string().regex(MONTH_KEY_PATTERN, "month must be YYYY-MM").optional(),
})

function windowFilters(window: { start: Date; end: Date }, userId: string): ExecutiveFilters {
  return {
    startDate: window.start,
    endDate: window.end,
    categoryIds: [],
    productIds: [],
    groupIds: [],
    userIds: [userId],
    unit: null,
    statusSet: "consumed",
  }
}

/**
 * Item-by-item detail behind one watchlist row's growth figure.
 *
 * It reads the *same two windows* the figure was computed from — the trend
 * windows, not the selected month — so the table's two totals reconcile with
 * the percentage that was clicked. See `plans/OF-BUDGET-BURN-three-month-trend.md`.
 */
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
    if (scope.branchIds?.length !== 1) {
      return NextResponse.json({ error: "Select exactly one branch", field: "branchIds" }, { status: 400 })
    }

    const parsedQuery = querySchema.safeParse({
      userId: url.searchParams.get("userId") ?? "",
      month: url.searchParams.get("month") ?? undefined,
    })
    if (!parsedQuery.success) {
      const issue = parsedQuery.error.issues[0]
      return NextResponse.json({
        error: issue?.message ?? "Invalid query",
        field: String(issue?.path[0] ?? ""),
      }, { status: 400 })
    }

    const now = new Date()
    const month = parsedQuery.data.month ?? currentAppMonth(now)
    const windows = monthWindows(month, now)
    if (isMonthWindowError(windows)) {
      return NextResponse.json({ error: windows.error, field: "month" }, { status: 400 })
    }

    const [currentRows, priorRows] = await Promise.all([
      loadProductWindow(scope, windowFilters(windows.trend.current, parsedQuery.data.userId)),
      loadProductWindow(scope, windowFilters(windows.trend.prior, parsedQuery.data.userId)),
    ])
    const items = buildItemComparison(currentRows, priorRows)

    return NextResponse.json({
      userId: parsedQuery.data.userId,
      branchId: scope.branchIds[0],
      month: windows.month,
      windows: {
        months: windows.trend.months,
        current: {
          startMonth: windows.trend.current.startMonth,
          endMonth: windows.trend.current.endMonth,
          startDate: windows.trend.current.start.toISOString(),
          endDate: windows.trend.current.end.toISOString(),
          complete: windows.current.complete,
        },
        prior: {
          startMonth: windows.trend.prior.startMonth,
          endMonth: windows.trend.prior.endMonth,
          startDate: windows.trend.prior.start.toISOString(),
          endDate: windows.trend.prior.end.toISOString(),
        },
      },
      items,
      currentTotalSpendCents: currentRows.reduce((sum, row) => sum + row.valueCents, 0),
      priorTotalSpendCents: priorRows.reduce((sum, row) => sum + row.valueCents, 0),
      truncated: currentRows.length >= BUDGET_BURN_ITEM_ROW_CAP || priorRows.length >= BUDGET_BURN_ITEM_ROW_CAP,
    })
  } catch (error) {
    const { status, ...errorBody } = handleError(error, "EXECUTIVE_BUDGET_BURN_ITEM_COMPARISON")
    return NextResponse.json(errorBody, { status })
  }
}
