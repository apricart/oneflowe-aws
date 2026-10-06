import { ok, error, requireApiRole } from "@/lib/api"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { isOrderWriteRole } from "@/lib/order-write-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderResubmissionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import {
  orderCorrectionErrorResponse,
  resubmitOrderForApproval,
} from "@/lib/server/order-correction"

/**
 * A requester sends a returned order back for approval, optionally with a note.
 *
 * Who may do this is who may edit the order — anyone at its branch with a
 * requester role (`lib/order-write-access.ts`). `resubmitOrderForApproval`
 * re-reads the actor and its branch set inside the transaction; nothing about
 * scope comes from the request. The body may be empty.
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  const err = await requireApiRole(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)

  const user = await getCurrentUser()
  const scope = await getRequestScope()
  if (
    !user
    || !scope
    || user.id !== scope.userId
    || user.role !== scope.role
    || !isOrderWriteRole(user.role)
    || !scope.organizationId
  ) {
    return error("Unauthorized", 401)
  }

  const rateLimited = await withRateLimit("order", user.id)
  if (rateLimited) return rateLimited

  const raw = await req.text().catch(() => "")
  let body: unknown = {}
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw)
    } catch {
      return error("Request body must be valid JSON", 400)
    }
  }
  const parsed = orderResubmissionSchema.safeParse(body)
  if (!parsed.success) return error(validationMessage(parsed.error), 400)

  const outcome = await resubmitOrderForApproval({
    orderId,
    userId: user.id,
    organizationId: scope.organizationId,
    note: parsed.data.note,
  })

  const failure = orderCorrectionErrorResponse(outcome)
  if (failure) return error(failure.message, failure.status)
  if (outcome.kind !== "resubmitted") return error("Order could not be resubmitted", 409)

  await attemptImmediateOrderEmailDelivery(outcome.eventKeys)

  return ok({
    message: "Order resubmitted for approval",
    order: outcome.order,
  })
}
