import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { addDeliveryChallanToDeliveredOrder, listDeliveryChallans } from "@/lib/server/delivery-challan"
import { validationMessage, warehouseChallanAttachSchema } from "@/lib/server/mutation-validation"
import { isOrderBranchInWarehouseReach, loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

export const dynamic = "force-dynamic"

/**
 * An order's current delivery challan, for the warehouse (GET), and attaching
 * one to a delivered order that has none (POST) — the challan is optional when
 * the warehouse marks an order delivered, so it may be added afterwards. It
 * never replaces one; that stays Super Admin's. Out of reach is 404.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const rateLimited = await withRateLimit("api", user.id)
    if (rateLimited) return rateLimited

    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Order not found", 404)
    const challans = await listDeliveryChallans({ orderId, includeReplaced: false })
    return NextResponse.json({ items: challans }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]/delivery-challan")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

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

    const parsed = warehouseChallanAttachSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    // Only its work: a refunded or cancelled order at its branch is 404 here too (AC1).
    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Order not found", 404)

    const outcome = await addDeliveryChallanToDeliveredOrder({
      orderId,
      challanId: parsed.data.deliveryChallanId,
      actor: { id: user.id, role: user.role, email: user.email },
      guardInTransaction: (tx, order) => isOrderBranchInWarehouseReach(user.id, order, { client: tx, lock: true }),
    })

    switch (outcome.kind) {
      case "not-found":
        return error("Order not found", 404)
      case "not-delivered":
        return error("A challan is added here only after the order is delivered; attach it when marking it delivered instead", 409)
      case "already-has-challan":
        return error("This order already has a delivery challan. Ask Super Admin to replace it.", 409)
      case "invalid-challan":
        return error("The delivery challan was not uploaded by you for this order, or has already been used. Upload it again.", 400)
      case "attached":
        return NextResponse.json({ message: "Delivery challan added" }, { status: 201 })
    }
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/warehouse/orders/[id]/delivery-challan")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
