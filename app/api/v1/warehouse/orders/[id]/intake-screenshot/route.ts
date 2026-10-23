import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { intakeAttachmentResponse, loadDeskOrderIntakeAttachmentKey } from "@/lib/server/order-desk-attachments"
import { loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

/**
 * The screenshot of the customer's message on an order the Order Desk entered,
 * for the warehouse: approved work at its branches only. Anything else — out of
 * reach, not work, not a desk order, no screenshot — is the same 404. Streamed
 * by the one helper the desk and the executive routes use.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Not found", 404)

    const rateLimited = await withRateLimit("api", user.id)
    if (rateLimited) return rateLimited

    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Not found", 404)
    return await intakeAttachmentResponse(await loadDeskOrderIntakeAttachmentKey(orderId))
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]/intake-screenshot")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
