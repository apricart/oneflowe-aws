import { after, NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { PRICE_CONTRACT_REMINDER_DAYS } from "@/lib/price-contract-validity"
import { withRateLimit } from "@/lib/rate-limiter"
import { attemptImmediateEmailDelivery } from "@/lib/server/order-notifications"
import { loadPriceContractAlerts, queueDuePriceContractReminders } from "@/lib/server/price-contract-reminders"

export const dynamic = "force-dynamic"

/**
 * The price contracts expiring within the reminder window or already expired,
 * for the embedded alert on the Super Admin dashboard and the executive
 * workspace. Super Admin reads every organization; an Apricart Executive only
 * those it is assigned. Names, codes and dates only — no prices.
 * See plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md.
 *
 * Reading it also runs the reminder sweep after the response, so a reminder
 * goes out the first time anyone opens a dashboard in the window even where
 * the daily schedule is not deployed. The sweep is idempotent.
 */
export async function GET() {
  // PRICE_CONTRACT_ALERT_ROLES, spelt out so the executive allowlist test can read it.
  const roleError = await requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])
  if (roleError) return roleError

  const scope = await getRequestScope()
  if (!scope?.userId) return error("Unauthorized", 401)

  const rateLimited = await withRateLimit("search", scope.userId)
  if (rateLimited) return rateLimited

  try {
    const now = new Date()
    const items = await loadPriceContractAlerts(db, { role: scope.role, userId: scope.userId }, now)
    if (items === null) return error("Forbidden", 403)

    after(async () => {
      try {
        const queued = await queueDuePriceContractReminders(db, now)
        await attemptImmediateEmailDelivery(queued.eventKeys)
      } catch (sweepError) {
        logError(sweepError, "PRICE_CONTRACT_REMINDER_SWEEP_ON_READ")
      }
    })

    return NextResponse.json(
      { reminderDays: PRICE_CONTRACT_REMINDER_DAYS, items },
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (loadError) {
    const handled = handleError(loadError, "GET /api/v1/price-contracts/alerts")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
