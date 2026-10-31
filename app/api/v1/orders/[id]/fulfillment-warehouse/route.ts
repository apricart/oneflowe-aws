import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES } from "@/lib/order-warehouse-transfer"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderWarehouseTransferSchema, validationMessage } from "@/lib/server/mutation-validation"
import { loadOrderWarehousePanel, transferOrderWarehouse } from "@/lib/server/order-warehouse-transfer"
import { parseRouteId } from "@/lib/warehouse-orders"
import { transferStockShortfallMessage } from "@/lib/warehouse-stock"

/**
 * Which Apricart warehouse fulfils one order, and moving it to another.
 * Super Admin only (`ORDER_WAREHOUSE_TRANSFER_ROLES`) — every tenant's orders, by design, as on the rest of its
 * order screens. Moving an order changes only `orders.fulfillment_warehouse_id`:
 * the target warehouse's operators pick, dispatch and deliver it from then on,
 * and the accounts that worked it stop seeing it. The audit row, the history
 * row and the notices are written by `transferOrderWarehouse`, in the move.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const panel = await loadOrderWarehousePanel(orderId)
    if (!panel) return error("Order not found", 404)
    return NextResponse.json(panel, { headers: NO_STORE })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/orders/[id]/fulfillment-warehouse")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = orderWarehouseTransferSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await transferOrderWarehouse({
      orderId,
      targetWarehouseId: parsed.data.targetWarehouseId,
      expectedWarehouseId: parsed.data.expectedWarehouseId,
      reason: parsed.data.reason,
      acknowledgeStockShortfall: parsed.data.acknowledgeStockShortfall,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    switch (outcome.kind) {
      case "not-found":
        return error("Order not found", 404)
      case "refused":
        return error(ORDER_WAREHOUSE_TRANSFER_REFUSAL_MESSAGES[outcome.refusal], 409)
      case "stale":
        return error("This order was moved to another warehouse a moment ago. Refresh and try again.", 409)
      case "unchanged":
        return error("The order is already with that warehouse", 409)
      case "target-not-found":
        return error("Warehouse not found", 404)
      case "target-inactive":
        return error("That warehouse is inactive", 409)
      case "no-operator":
        return error(parsed.data.targetWarehouseId === null
          ? "No active warehouse account serves this order's branch — choose a warehouse instead"
          : "That warehouse has no active operator to fulfil the order. Add one on Warehouse Team first.", 409)
      case "stock-shortfall":
        return NextResponse.json({
          error: transferStockShortfallMessage(outcome.shortfalls),
          code: "STOCK_SHORTFALL",
          stockShortfalls: outcome.shortfalls,
        }, { status: 409, headers: NO_STORE })
      case "transferred":
        return NextResponse.json({
          message: "Order transferred",
          item: {
            orderId,
            transferId: outcome.transferId,
            fromWarehouseId: outcome.fromWarehouseId,
            toWarehouseId: outcome.toWarehouseId,
          },
        }, { headers: NO_STORE })
    }
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/orders/[id]/fulfillment-warehouse")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
