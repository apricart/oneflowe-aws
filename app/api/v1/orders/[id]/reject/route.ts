import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { rejectionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import { orderDecisionErrorResponse, rejectOrder } from "@/lib/server/order-decision-service"

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
  const rawBody = await readJson<unknown>(req)
  const parsedBody = rejectionSchema.safeParse(rawBody)

  if (!user || !scope || user.id !== scope.userId || user.role !== scope.role) {
    return error("Unauthorized", 401)
  }
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

  const outcome = await rejectOrder({
    orderId,
    scope,
    user,
    reason: parsedBody.data.reason,
  })

  const failure = orderDecisionErrorResponse(outcome, "reject")
  if (failure) return error(failure.message, failure.status)
  if (outcome.kind !== "rejected") {
    return error("Order rejection could not be completed", 409)
  }

  await attemptImmediateOrderEmailDelivery(outcome.eventKeys)

  return ok({ message: "Order rejected successfully" })
}
