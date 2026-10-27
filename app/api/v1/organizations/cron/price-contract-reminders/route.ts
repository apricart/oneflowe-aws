import { NextRequest } from "next/server"

import { error, ok } from "@/lib/api"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { env } from "@/lib/server/env"
import { attemptImmediateEmailDelivery } from "@/lib/server/order-notifications"
import {
  findDuePriceContractOrganizations,
  queueDuePriceContractReminders,
} from "@/lib/server/price-contract-reminders"

function isCronAuthorized(req: NextRequest): boolean {
  return req.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`
}

/**
 * POST — the daily price contract reminder sweep, or a manual preview with
 * { "dry_run": true }. Queues a reminder for every active organization whose
 * contract ends within the reminder window, once per organization, date and
 * recipient, and sends the new emails at once; the outbox scheduler retries
 * any that fail. Never blocks ordering.
 * See plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md.
 */
export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) return error("Unauthorized", 401)

  const body = await req.json().catch(() => ({}))
  const dryRun = body?.dry_run === true
  const now = new Date()

  try {
    if (dryRun) {
      const due = await findDuePriceContractOrganizations(db, now)
      return ok({ dryRun, due: due.length, organizationIds: due.map((organization) => organization.id) })
    }
    const queued = await queueDuePriceContractReminders(db, now)
    await attemptImmediateEmailDelivery(queued.eventKeys)
    return ok({ dryRun, organizations: queued.organizationCount, queued: queued.eventKeys.length })
  } catch (caughtError) {
    logError(caughtError, "PRICE_CONTRACT_REMINDER_SWEEP")
    return error("Price contract reminder sweep failed", 500)
  }
}
