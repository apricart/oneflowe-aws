import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { normalizePositiveIds } from "@/lib/server/analytics-scope"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { loadUnpaidInvoiceAlerts } from "@/lib/server/unpaid-invoice-alerts"
import {
  NO_UNPAID_INVOICE_ALERTS,
  UNPAID_INVOICE_ALERT_ROLES,
  alertsAcrossAssignedBranches,
} from "@/lib/unpaid-invoice-alerts"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * GET /api/v1/payment-control/ordering-alerts
 *
 * The caller's branches that are blocked by unpaid invoices or one unpaid
 * invoice short of it, for the alerts at the top of every page
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md). Order Initiators and
 * Financial Approvers read their own branch; the group roles their resolved
 * assignment set. Nothing is taken from the request, nothing is written.
 */
export async function GET() {
  const denied = await requireApiRole([...UNPAID_INVOICE_ALERT_ROLES])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Unauthorized", 401)
    if (!scope.organizationId) return ok(NO_UNPAID_INVOICE_ALERTS, NO_STORE)

    const branchIds = alertsAcrossAssignedBranches(scope.role)
      ? await resolveScopedBranchIds(db, scope.userId)
      : normalizePositiveIds([scope.branchId])

    const view = await loadUnpaidInvoiceAlerts(db, { organizationId: scope.organizationId, branchIds }, new Date())
    return ok(view, NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "PAYMENT_CONTROL_ORDERING_ALERTS")
    return error("Unable to load ordering alerts", 500)
  }
}
