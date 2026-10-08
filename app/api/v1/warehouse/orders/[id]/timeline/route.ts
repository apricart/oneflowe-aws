import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadDeliveryTimeline } from "@/lib/server/delivery-dashboard"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

export const dynamic = "force-dynamic"

/**
 * One order's delivery journey, for the warehouse: the management dashboard's
 * timeline, fenced to this user's branches. An order outside them — or outside
 * the dashboard's population (approved before the cutoff, imported) — is 404.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const reach = await loadWarehouseReach(db, user.id)
    const timeline = await loadDeliveryTimeline(orderId, new Date(), reach)
    if (!timeline) return error("Order not found", 404)
    return NextResponse.json(timeline, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]/timeline")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
