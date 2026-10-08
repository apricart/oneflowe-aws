import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadWarehouseOrder } from "@/lib/server/warehouse-orders"
import { parseRouteId } from "@/lib/warehouse-orders"

export const dynamic = "force-dynamic"

/**
 * One order's picking sheet for the warehouse: lines with product code,
 * quantity, unit and price; notes; destination; invoice figures; delivery
 * health; current challan. An order outside this user's branches — or not
 * approved work — is 404, the same as one that does not exist.
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

    const sheet = await loadWarehouseOrder(user.id, orderId, new Date())
    if (!sheet) return error("Order not found", 404)
    return NextResponse.json(sheet, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
