import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, verifyResourceAccess } from "@/lib/auth"
import { normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { fulfillmentStatusSchema, validationMessage } from "@/lib/server/mutation-validation"
import { PROGRESS_STATUSES, progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"

/**
 * Super Admin moves an order's delivery forward one stage. The stage rule, the
 * compare-and-set, the challan, the audit row and the settlement of a waiting
 * token hand-off all live in `progressOrderFulfillment`, which the warehouse's
 * route shares. Here a delivery still needs its challan
 * (plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md): the body schema demands
 * one, and `challanRequired` makes the shared module refuse without one too.
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const roleError = await requireApiRole(["SUPER_ADMIN"])
  if (roleError) return roleError

  const user = await getCurrentUser()
  if (!user) return error("Unauthorized", 401)

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return error("Invalid order ID", 400)
  }

  const rawBody = await readJson<unknown>(req)
  const parsedBody = fulfillmentStatusSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const nextStatus = normalizeFulfillmentStatus(parsedBody.data.fulfillmentStatus)
  if (!PROGRESS_STATUSES.includes(nextStatus)) {
    return error("Invalid fulfillment status", 400)
  }

  const outcome = await progressOrderFulfillment({
    orderId,
    nextStatus,
    deliveryChallanId: parsedBody.data.deliveryChallanId ?? null,
    challanRequired: true,
    actor: { id: user.id, role: user.role },
    authorize: (order) => verifyResourceAccess(order.organizationId, order.branchId),
  })

  switch (outcome.kind) {
    case "not-found":
      return error("Order not found", 404)
    case "out-of-scope":
      return error("Forbidden: You do not have access to this order", 403)
    case "not-approved":
      return error(`Fulfillment progress can only be updated for approved orders. Current status: ${outcome.status}`, 400)
    case "invalid-step":
      return error(`Cannot move fulfillment progress from ${outcome.from} to ${outcome.to}`, 400)
    case "challan-refused":
      return error("The delivery challan was not uploaded for this order, or has already been used. Upload it again.", 400)
    case "missing-column":
      return error("Fulfillment progress migration has not been applied. Run the order fulfillment status migration first.", 503)
    case "conflict":
      return error("Fulfillment progress was already changed by another request", 409)
    case "updated":
      return ok({
        message: outcome.fulfilled
          ? "Fulfillment progress updated — the order is now marked fulfilled"
          : "Fulfillment progress updated",
        fulfilled: outcome.fulfilled,
        item: outcome.order,
      })
  }
}
