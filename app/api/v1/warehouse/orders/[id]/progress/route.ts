import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage, warehouseProgressSchema } from "@/lib/server/mutation-validation"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"
import { db } from "@/lib/db"
import { isOrderBranchInWarehouseReach, loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

/**
 * The warehouse moves an order's delivery one stage forward:
 * `NOT_STARTED → IN_PROCESS → OUT_FOR_DELIVERY → DELIVERED`.
 *
 * Everything after authorization is `progressOrderFulfillment`, which Super
 * Admin's route shares, so a delivery recorded here has exactly the same
 * effects (delivered_at written once, a waiting token hand-off settled, the
 * audit row). The differences are two: the reach is this user's branches,
 * re-read inside the writing transaction under FOR SHARE; and a delivery
 * challan is optional (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
 *
 * Anything outside the reach is 404, never 403, so this cannot be used to
 * learn which order ids exist — and so is an order at its own branch that is
 * not its work (pending, rejected, cancelled, refunded), so a refusal never
 * tells it that order's status (AC1).
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = warehouseProgressSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Order not found", 404)

    const outcome = await progressOrderFulfillment({
      orderId,
      nextStatus: parsed.data.fulfillmentStatus,
      deliveryChallanId: parsed.data.deliveryChallanId ?? null,
      challanRequired: false,
      actor: { id: user.id, role: user.role },
      authorize: (order) => isOrderBranchInWarehouseReach(user.id, order),
      guardInTransaction: (tx, order) => isOrderBranchInWarehouseReach(user.id, order, { client: tx, lock: true }),
    })

    switch (outcome.kind) {
      case "not-found":
      case "out-of-scope":
        return error("Order not found", 404)
      case "not-approved":
        return error(`Only an approved order moves through delivery. Current status: ${outcome.status}`, 409)
      case "invalid-step":
        return error(`Cannot move delivery from ${outcome.from} to ${outcome.to}`, 409)
      case "challan-refused":
        return error("The delivery challan was not uploaded by you for this order, or has already been used. Upload it again.", 400)
      case "missing-column":
        return error("Fulfillment progress migration has not been applied", 503)
      case "conflict":
        return error("This order was moved by someone else a moment ago. Refresh and try again.", 409)
      case "updated":
        return NextResponse.json({
          message: outcome.fulfilled ? "Delivery recorded — the order is now fulfilled" : "Delivery progress updated",
          fulfilled: outcome.fulfilled,
          item: {
            id: outcome.order.id,
            status: outcome.order.status,
            fulfillmentStatus: outcome.order.fulfillmentStatus,
            deliveredAt: outcome.order.deliveredAt,
          },
        })
    }
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/warehouse/orders/[id]/progress")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
