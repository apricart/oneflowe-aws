import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderDeskCancelSchema, validationMessage } from "@/lib/server/mutation-validation"
import { cancelDeskOrder } from "@/lib/server/order-desk-orders"

/**
 * Withdraw an Order Desk order before processing starts. Its budget hold and
 * stock are released in the same transaction, and the reason is recorded. An
 * order outside the desk user's reach is 404; one already in process is 409 —
 * its tax invoice is issued then, and a numbered invoice is reversed by a
 * refund's credit note, never by cancelling (plans/OF-INVOICE-issue-at-processing.md).
 * The audit row is written by `lib/server/order-desk-orders.ts`.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
    }

    const parsed = orderDeskCancelSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await cancelDeskOrder({
      orderId,
      reason: parsed.data.reason,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    switch (outcome.kind) {
      case "cancelled":
        return NextResponse.json({ message: "Order cancelled" })
      case "not-found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      case "not-active":
        return NextResponse.json({ error: `Cannot cancel an order in ${outcome.status} state` }, { status: 409 })
      case "conflict":
        return NextResponse.json({ error: "The order was changed by another request; reload and try again" }, { status: 409 })
      case "invoiced":
        return NextResponse.json({
          error: "Processing has started and the tax invoice has been issued, so this order can no longer be cancelled. Ask Super Admin to refund it, which issues a credit note.",
        }, { status: 409 })
    }
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/order-desk/orders/[id]/cancel")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
