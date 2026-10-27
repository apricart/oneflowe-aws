import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderCorrectionRequestSchema, validationMessage } from "@/lib/server/mutation-validation"
import { orderCorrectionErrorResponse, returnOrderForCorrection } from "@/lib/server/order-correction"

/**
 * An Apricart Executive sends an Order Desk order back to the desk for
 * correction, with a comment. Delegates to the shared
 * `returnOrderForCorrection`, held to the same in-transaction decision policy
 * as approve and reject. Nothing moves in money or stock; the desk edits and
 * resubmits. Outside the reach is 404. Super Admin returns any desk order here
 * too, never any other order (plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md).
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

    const parsed = orderCorrectionRequestSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await returnOrderForCorrection({ orderId, scope, user, comment: parsed.data.comment })
    const failure = orderCorrectionErrorResponse(outcome)
    if (failure) return error(failure.message, failure.status)
    if (outcome.kind !== "returned") return error("Order could not be returned for correction", 409)

    return NextResponse.json({ message: "Order returned to the Order Desk for correction", order: outcome.order })
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/executive/approvals/[id]/return")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
