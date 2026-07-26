import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, verifyResourceAccess } from "@/lib/auth"
import { db } from "@/lib/db"
import { auditLogs, orders } from "@/db/schema"
import { FULFILLMENT_STATUSES, normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { orderSelectColumns, transitionOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { eq } from "drizzle-orm"
import { fulfillmentStatusSchema, validationMessage } from "@/lib/server/mutation-validation"

const PROGRESS_STATUSES = FULFILLMENT_STATUSES.filter(
  (status) => status !== "NOT_STARTED"
) as FulfillmentStatus[]

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

  const [order] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return error("Order not found", 404)

  const hasAccess = await verifyResourceAccess(order.organizationId, order.branchId)
  if (!hasAccess) return error("Forbidden: You do not have access to this order", 403)

  const orderStatus = String(order.status || "").toUpperCase()
  if (orderStatus !== "APPROVED") {
    return error(`Fulfillment progress can only be updated for approved orders. Current status: ${order.status}`, 400)
  }

  const currentStatus = normalizeFulfillmentStatus(order.fulfillmentStatus)
  const currentIndex = FULFILLMENT_STATUSES.indexOf(currentStatus)
  const nextIndex = FULFILLMENT_STATUSES.indexOf(nextStatus)

  if (nextIndex !== currentIndex + 1) {
    return error(`Cannot move fulfillment progress from ${currentStatus} to ${nextStatus}`, 400)
  }

  const updated = await db.transaction(async (tx) => {
    const transition = await transitionOrderFulfillmentStatusColumn(tx, orderId, currentStatus, nextStatus)
    if (transition !== "updated") return transition

    await tx.insert(auditLogs).values({
      userId: user.id,
      organizationId: order.organizationId,
      branchId: order.branchId,
      action: "ORDER_FULFILLMENT_STATUS_UPDATE",
      entity: "Order",
      entityId: String(order.id),
      metadata: {
        tid: order.tid,
        from: currentStatus,
        to: nextStatus,
      },
    })

    const [updatedOrder] = await tx
      .select(orderSelectColumns)
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)

    return updatedOrder || { ...order, fulfillmentStatus: nextStatus }
  })

  if (updated === "missing-column") {
    return error("Fulfillment progress migration has not been applied. Run the order fulfillment status migration first.", 503)
  }
  if (updated === "conflict") {
    return error("Fulfillment progress was already changed by another request", 409)
  }

  return ok({
    message: "Fulfillment progress updated",
    item: updated,
  })
}
