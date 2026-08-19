import { ok, error, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import { approveOrder, orderDecisionErrorResponse } from "@/lib/server/order-decision-service"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()
  const scope = await getRequestScope()

  if (!user || !scope || user.id !== scope.userId || user.role !== scope.role) {
    return error("Unauthorized", 401)
  }

  const outcome = await approveOrder({ orderId, scope, user })

  const failure = orderDecisionErrorResponse(outcome, "approve")
  if (failure) return error(failure.message, failure.status)
  if (outcome.kind !== "approved") {
    return error("Order approval could not be completed", 409)
  }

  await attemptImmediateOrderEmailDelivery(outcome.eventKeys)

  return ok({
    message: "Order approved successfully",
    approvalToken: outcome.approvalToken,
    warning: "SAVE THIS TOKEN! It will not be shown again."
  })
}
