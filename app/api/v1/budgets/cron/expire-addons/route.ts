import { NextRequest } from "next/server"

import { error, ok } from "@/lib/api"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { findBudgetsWithDueAddons, settleDueBudgetAddons } from "@/lib/server/budget-addon-expiry"
import { env } from "@/lib/server/env"

// Settled per call; the next call picks up the rest.
const BATCH_SIZE = 200

function isCronAuthorized(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`
}

/**
 * POST — scheduled sweep, or a manual preview with { "dry_run": true }.
 *
 * Every path that spends or shows a budget settles its own row first
 * (lib/server/budget-addon-expiry.ts), so this sweep exists for the rows
 * nobody has touched since their add-on's validity passed: it keeps
 * reports and exports honest, and it is never the control that stops an
 * expired add-on being spent.
 */
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) return error("Unauthorized", 401)

  const body = await req.json().catch(() => ({}))
  const dryRun = body?.dry_run === true
  const now = new Date()

  try {
    if (dryRun) {
      const budgetIds = await findBudgetsWithDueAddons(db, { all: true, limit: BATCH_SIZE }, now)
      return ok({ dryRun, due: budgetIds.length, budgetIds })
    }
    const settlements = await settleDueBudgetAddons(db, { all: true, limit: BATCH_SIZE }, now)
    return ok({
      dryRun,
      settled: settlements.length,
      withdrawnCents: settlements.reduce((sum, settlement) => sum + settlement.plan.withdrawnCents, 0),
      budgetIds: settlements.map((settlement) => settlement.budgetId),
    })
  } catch (caughtError) {
    logError(caughtError, "BUDGET_ADDON_EXPIRY_SWEEP")
    return error("Add-on expiry sweep failed", 500)
  }
}
