import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { rejectionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { orderDecisionErrorResponse, rejectOrder } from "@/lib/server/order-decision-service"

/**
 * An Apricart Executive rejects an Order Desk order in an organization
 * assigned to them, with a reason. Delegates to the shared `rejectOrder`,
 * which authorizes inside its transaction and releases the budget hold, the
 * quantity hold and the stock the order took. Outside the reach is 404.
 * Super Admin rejects any desk order here too, never any other order
 * (plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md).
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */
export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])
    if (roleError) return roleError

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)

    const user = await getCurrentUser()
    const scope = await getRequestScope()
    if (!user || !scope || user.id !== scope.userId || user.role !== scope.role) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("order", user.id)
    if (rateLimited) return rateLimited

    const parsed = rejectionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await rejectOrder({ orderId, scope, user, reason: parsed.data.reason })
    const failure = orderDecisionErrorResponse(outcome, "reject")
    if (failure) return error(failure.message, failure.status)
    if (outcome.kind !== "rejected") return error("Order rejection could not be completed", 409)

    return NextResponse.json({
      message: "Order rejected",
      order: { id: outcome.order.id, tid: outcome.order.tid, status: "REJECTED" },
    })
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/executive/approvals/[id]/reject")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
