import { NextRequest, NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadExecutiveApprovalOrder } from "@/lib/server/executive-approvals"
import { intakeAttachmentResponse } from "@/lib/server/order-desk-attachments"

/**
 * The screenshot of the customer's message on one Order Desk order, for an
 * Apricart Executive deciding it. Only for a desk order in an organization
 * assigned to them; anything else — no such order, outside the reach, no
 * screenshot — is the same 404. Served exactly as the desk's own route serves
 * it (`intakeAttachmentResponse`).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["APRICART_EXECUTIVE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("api", user.id)
    if (rateLimit) return rateLimit

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const order = await loadExecutiveApprovalOrder(user.id, orderId)
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return await intakeAttachmentResponse(order.intakeAttachmentKey)
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/executive/approvals/[id]/attachment")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
