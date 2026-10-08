import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { orderCorrectionRefusalMessage } from "@/lib/order-correction"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderResubmissionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { resubmitDeskOrder } from "@/lib/server/order-desk-orders"

/**
 * Send a desk order an Apricart Executive returned for correction back for
 * approval, with an optional note. Read through the desk user's reach, so an
 * order outside it is 404; one not awaiting correction is 409. The body may be
 * empty. The audit row is written by `lib/server/order-desk-orders.ts`.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("order", user.id)
    if (rateLimit) return rateLimit

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
    }

    const raw = await req.text().catch(() => "")
    let body: unknown = {}
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw)
      } catch {
        return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 })
      }
    }
    const parsed = orderResubmissionSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await resubmitDeskOrder({
      orderId,
      note: parsed.data.note,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    switch (outcome.kind) {
      case "resubmitted":
        return NextResponse.json({ message: "Order resubmitted for approval" })
      case "not-found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      case "invalid-state":
        return NextResponse.json({ error: orderCorrectionRefusalMessage(outcome.refusal, outcome.status) }, { status: 409 })
      case "conflict":
        return NextResponse.json({ error: "The order was changed by another request; reload and try again" }, { status: 409 })
    }
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/order-desk/orders/[id]/resubmit")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
