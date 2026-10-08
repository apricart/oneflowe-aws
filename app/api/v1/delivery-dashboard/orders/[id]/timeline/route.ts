import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isActiveDeliveryDashboardReader, loadDeliveryTimeline } from "@/lib/server/delivery-dashboard"

export const dynamic = "force-dynamic"

/**
 * One order's delivery journey, for the dashboard's drill-down. Only an order
 * inside the dashboard's population is returned; anything else is 404, so this
 * cannot be used to read an arbitrary order.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const roleError = await requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])
  if (roleError) return roleError

  const { id } = await props.params
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    return error("Invalid order ID", 400)
  }

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)
  if (!await isActiveDeliveryDashboardReader(scope.userId, scope.role)) return error("Forbidden", 403)

  const rateLimited = await withRateLimit("search", scope.userId)
  if (rateLimited) return rateLimited

  try {
    const timeline = await loadDeliveryTimeline(Number(id), new Date())
    if (!timeline) return error("Order not found", 404)
    return NextResponse.json(timeline, { headers: { "Cache-Control": "private, no-store" } })
  } catch (loadError) {
    const handled = handleError(loadError, "GET /api/v1/delivery-dashboard/orders/[id]/timeline")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
