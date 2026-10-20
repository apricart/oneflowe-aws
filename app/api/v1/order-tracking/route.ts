import { NextRequest } from "next/server"

import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { parseTrackingReference } from "@/lib/order-tracking"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadTrackedOrder, ORDER_TRACKING_ROLES } from "@/lib/server/order-tracking"

export const dynamic = "force-dynamic"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }
const NOT_FOUND = "No order with that reference was found in your order history"

/**
 * GET /api/v1/order-tracking?reference=<order id or transaction id>
 *
 * The requester order tracker. Order Initiator and Group Order Initiator only;
 * the order must be one the caller may read on the order page
 * (`canReadOrderDetail`), and anything else — another tenant's, a colleague's,
 * a non-existent id — is the same 404. Read-only; nothing is audited.
 */
export async function GET(req: NextRequest) {
  const denied = await requireApiRole([...ORDER_TRACKING_ROLES])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Unauthorized", 401)

    // Enumerable by design (it takes an id), so it is rate limited per user.
    const limited = await withRateLimit("search", scope.userId)
    if (limited) return limited

    const reference = parseTrackingReference(new URL(req.url).searchParams.get("reference"))
    if (!reference) return error("Enter a valid order ID or transaction ID", 400)

    const item = await loadTrackedOrder(scope, reference)
    if (!item) return error(NOT_FOUND, 404)
    return ok({ item }, NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "ORDER_TRACKING_READ")
    return error("Unable to load order tracking", 500)
  }
}
