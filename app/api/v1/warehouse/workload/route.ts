import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { parseDeliveryDashboardQuery } from "@/lib/delivery-dashboard"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadDeliveryDashboard } from "@/lib/server/delivery-dashboard"
import { loadWarehouseOrderReach } from "@/lib/server/warehouse-scope"

export const dynamic = "force-dynamic"

/**
 * The warehouse's workload: the management delivery dashboard — open, due
 * soon, overdue and delivered, by the same SLA rules — fenced to this user's
 * branches. Same query string, same response shape, so the same component
 * renders it. A user with no branches sees an empty dashboard.
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const now = new Date()
    const parsed = parseDeliveryDashboardQuery(new URL(req.url).searchParams, now)
    if (!parsed.ok) return error(parsed.message, 400)

    const reach = await loadWarehouseOrderReach(db, user.id)
    const dashboard = await loadDeliveryDashboard(parsed.filters, now, reach, "newest")
    return NextResponse.json(dashboard, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/workload")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
