import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { parseDeliveryDashboardQuery } from "@/lib/delivery-dashboard"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isActiveDeliveryDashboardReader, loadDeliveryDashboard } from "@/lib/server/delivery-dashboard"

export const dynamic = "force-dynamic"

/**
 * The management delivery dashboard: every organization's approved orders
 * against the delivery SLA. Super Admin and Apricart Executive only; read-only;
 * no money and no people in the response.
 * See plans/OF-DELIVERY-management-delivery-dashboard.md.
 */
export async function GET(req: Request) {
  const roleError = await requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])
  if (roleError) return roleError

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)
  if (!await isActiveDeliveryDashboardReader(scope.userId, scope.role)) return error("Forbidden", 403)

  // Each request reads up to the whole population, so it is rate limited like
  // the other expensive reads.
  const rateLimited = await withRateLimit("search", scope.userId)
  if (rateLimited) return rateLimited

  const now = new Date()
  const parsed = parseDeliveryDashboardQuery(new URL(req.url).searchParams, now)
  if (!parsed.ok) return error(parsed.message, 400)

  try {
    // Latest orders first, as on the warehouse dashboard; the overdue and
    // due-soon cards still narrow the list to the orders needing attention.
    const dashboard = await loadDeliveryDashboard(parsed.filters, now, null, "newest")
    return NextResponse.json(dashboard, { headers: { "Cache-Control": "private, no-store" } })
  } catch (loadError) {
    const handled = handleError(loadError, "GET /api/v1/delivery-dashboard")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
