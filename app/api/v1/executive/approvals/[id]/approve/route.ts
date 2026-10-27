import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { executiveOrderApprovalSchema, validationMessage } from "@/lib/server/mutation-validation"
import { approveOrder, orderDecisionErrorResponse } from "@/lib/server/order-decision-service"

/**
 * An Apricart Executive approves an Order Desk order in an organization
 * assigned to them. Delegates to the shared `approveOrder`, whose
 * `authorizeOrderDecision` re-reads the account and the assignment inside the
 * deciding transaction; anything outside the reach is 404. The approval must
 * name the version the executive saw (`expectedUpdatedAt`), so a desk edit in
 * between is a 409 rather than an approval of lines nobody looked at.
 *
 * The approval token is never returned: the desk fulfils its orders without it.
 * Super Admin approves any desk order through this route too, from Order Desk
 * Team; never any other order (plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md).
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

    const parsed = executiveOrderApprovalSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const { expectedUpdatedAt } = parsed.data

    const outcome = await approveOrder({
      orderId,
      scope,
      user,
      expectedUpdatedAt: expectedUpdatedAt === null ? null : new Date(expectedUpdatedAt),
    })
    if (outcome.kind === "conflict") {
      return error("The order was changed or decided since you opened it; reload and review it again", 409)
    }
    const failure = orderDecisionErrorResponse(outcome, "approve")
    if (failure) return error(failure.message, failure.status)
    if (outcome.kind !== "approved") return error("Order approval could not be completed", 409)

    return NextResponse.json({
      message: "Order approved",
      order: { id: outcome.order.id, tid: outcome.order.tid, status: "APPROVED" },
    })
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/executive/approvals/[id]/approve")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
