import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { loadRecentTrackableOrders, ORDER_TRACKING_ROLES } from "@/lib/server/order-tracking"

export const dynamic = "force-dynamic"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * GET /api/v1/order-tracking/recent
 *
 * The caller's latest orders, for the tracking page's picker — a bounded
 * subset of what the lookup admits (`loadRecentTrackableOrders`). No amounts.
 */
export async function GET() {
  const denied = await requireApiRole([...ORDER_TRACKING_ROLES])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Unauthorized", 401)
    return ok({ items: await loadRecentTrackableOrders(scope) }, NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "ORDER_TRACKING_RECENT")
    return error("Unable to load recent orders", 500)
  }
}
