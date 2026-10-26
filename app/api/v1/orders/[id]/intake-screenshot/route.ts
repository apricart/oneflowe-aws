import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { intakeAttachmentResponse, loadDeskOrderIntakeAttachmentKey } from "@/lib/server/order-desk-attachments"
import { ORDER_DETAIL_READ_ROLES, canReadOrderDetail } from "@/lib/server/order-read-access"

/**
 * The screenshot of the customer's message on an order the Order Desk entered,
 * for whoever may read the order — exactly the rule `GET /api/v1/orders/{id}`
 * applies (`canReadOrderDetail`), so the two can never drift. Anything else —
 * out of scope, not a desk order, no screenshot — is the same 404. Streamed by
 * the one helper the desk and the executive routes use.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const roleError = await requireApiRole([...ORDER_DETAIL_READ_ROLES], { viewerReadsAsHeadOffice: true })
  if (roleError) return roleError

  const { id } = await props.params
  const orderId = /^\d+$/.test(id) ? Number(id) : NaN
  if (!Number.isSafeInteger(orderId) || orderId <= 0) return error("Not found", 404)

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)
  const rateLimited = await withRateLimit("api", scope.userId)
  if (rateLimited) return rateLimited

  try {
    if (!await canReadOrderDetail({ orderId, scope, viewerReadsAsHeadOffice: true })) return error("Not found", 404)
    return await intakeAttachmentResponse(await loadDeskOrderIntakeAttachmentKey(orderId))
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/orders/[id]/intake-screenshot")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
