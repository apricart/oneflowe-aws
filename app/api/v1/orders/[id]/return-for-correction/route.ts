import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderCorrectionRequestSchema, validationMessage } from "@/lib/server/mutation-validation"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import {
  orderCorrectionErrorResponse,
  returnOrderForCorrection,
} from "@/lib/server/order-correction"

/**
 * An approver sends a pending order back to its requesters with a comment.
 *
 * The roles are the approve/reject roles, and `returnOrderForCorrection` holds
 * the caller to the same decision policy (`authorizeOrderDecision`) inside its
 * transaction. See plans/OF-ORDER-RETURN-for-correction.md.
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
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

  const rateLimited = await withRateLimit("order", user.id)
  if (rateLimited) return rateLimited

  const parsed = orderCorrectionRequestSchema.safeParse(await readJson<unknown>(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)

  const outcome = await returnOrderForCorrection({
    orderId,
    scope,
    user,
    comment: parsed.data.comment,
  })

  const failure = orderCorrectionErrorResponse(outcome)
  if (failure) return error(failure.message, failure.status)
  if (outcome.kind !== "returned") return error("Order could not be returned for correction", 409)

  await attemptImmediateOrderEmailDelivery(outcome.eventKeys)

  return ok({
    message: "Order returned for correction",
    order: outcome.order,
  })
}
