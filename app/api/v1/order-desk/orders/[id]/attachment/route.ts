import { NextRequest, NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { intakeAttachmentResponse } from "@/lib/server/order-desk-attachments"
import { loadDeskOrder } from "@/lib/server/order-desk-orders"

/**
 * The screenshot of the customer's message on one Order Desk order.
 *
 * It carries a customer's personal details, so it is never served by the
 * public product-image route: only here, by order id, for a desk order this
 * desk user currently reaches. Anything else — no such order, someone else's
 * order, an order with no screenshot — is the same 404.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("api", user.id)
    if (rateLimit) return rateLimit

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const order = await loadDeskOrder(db, user.id, orderId)
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return await intakeAttachmentResponse(order.intakeAttachmentKey)
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/orders/[id]/attachment")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
