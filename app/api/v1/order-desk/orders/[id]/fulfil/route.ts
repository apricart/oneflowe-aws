import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { fulfilDeskOrder } from "@/lib/server/order-desk-orders"

/**
 * Fulfil a delivered Order Desk order. Refused (409) until delivery has been
 * recorded, whoever asks — and `fulfillApprovedOrder` refuses it again in its
 * own claim. The order is read through the desk user's live reach, so anything
 * outside it is 404. The audit row and the ledger move are written by
 * `lib/server/order-fulfillment.ts`, inside the same transaction.
 */

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const { id } = await props.params
    const orderId = Number(id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
    }

    const outcome = await fulfilDeskOrder({
      orderId,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    switch (outcome.kind) {
      case "fulfilled":
        return NextResponse.json({ message: "Order fulfilled" })
      case "not-found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      case "not-active":
        return NextResponse.json({ error: `Cannot fulfil an order in ${outcome.status} state` }, { status: 409 })
      case "not-delivered":
        return NextResponse.json({ error: "Order cannot be fulfilled until it has been delivered" }, { status: 409 })
      case "conflict":
        return NextResponse.json({ error: "Order was already fulfilled or otherwise changed" }, { status: 409 })
      case "ledger-conflict":
        return NextResponse.json({ error: "Order budget hold is inconsistent; fulfilment was not applied" }, { status: 409 })
    }
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/order-desk/orders/[id]/fulfil")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
