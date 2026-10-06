import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope, getSharedServerSession } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { auditActorFromSession } from "@/lib/server/activity-audit"
import { listDeliveryChallans, replaceDeliveryChallan } from "@/lib/server/delivery-challan"
import { deliveryChallanReplaceSchema, validationMessage } from "@/lib/server/mutation-validation"
import { ORDER_DETAIL_READ_ROLES, canReadOrderDetail } from "@/lib/server/order-read-access"

/**
 * An order's delivery challan. See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
 *
 * GET  — readable by exactly whoever may read the order (`canReadOrderDetail`,
 *        the order detail's own rule); out of scope is 404. Super Admin also
 *        sees the challans a replacement superseded.
 * POST — Super Admin replaces a delivered order's challan with one it uploaded.
 */

function parseOrderId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const roleError = await requireApiRole([...ORDER_DETAIL_READ_ROLES])
  if (roleError) return roleError

  const orderId = parseOrderId((await props.params).id)
  if (!orderId) return error("Invalid order ID", 400)

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)
  const rateLimited = await withRateLimit("api", scope.userId)
  if (rateLimited) return rateLimited

  try {
    if (!await canReadOrderDetail({ orderId, scope })) return error("Order not found", 404)
    const items = await listDeliveryChallans({ orderId, includeReplaced: scope.role === "SUPER_ADMIN" })
    return NextResponse.json({ items }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (loadError) {
    const handled = handleError(loadError, "GET /api/v1/orders/[id]/delivery-challan")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const roleError = await requireApiRole(["SUPER_ADMIN"])
  if (roleError) return roleError

  const orderId = parseOrderId((await props.params).id)
  if (!orderId) return error("Invalid order ID", 400)

  const session = await getSharedServerSession()
  const actor = auditActorFromSession(session)
  if (!actor.id) return error("Unauthorized", 401)
  const rateLimited = await withRateLimit("write", actor.id)
  if (rateLimited) return rateLimited

  const parsed = deliveryChallanReplaceSchema.safeParse(await readJson<unknown>(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)

  try {
    const outcome = await replaceDeliveryChallan({
      orderId,
      challanId: parsed.data.deliveryChallanId,
      actor: { ...actor, id: actor.id },
    })
    switch (outcome.kind) {
      case "not-found":
        return error("Order not found", 404)
      case "not-delivered":
        return error("Only a delivered order's challan can be replaced", 409)
      case "invalid-challan":
        return error("The delivery challan was not uploaded for this order, or has already been used. Upload it again.", 400)
      default:
        return NextResponse.json({ message: "Delivery challan replaced", previousChallanId: outcome.previousChallanId })
    }
  } catch (replaceError) {
    const handled = handleError(replaceError, "POST /api/v1/orders/[id]/delivery-challan")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
