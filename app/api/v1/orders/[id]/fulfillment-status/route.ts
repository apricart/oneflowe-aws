import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, verifyResourceAccess } from "@/lib/auth"
import { db } from "@/lib/db"
import { auditLogs, orders } from "@/db/schema"
import { FULFILLMENT_STATUSES, normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { orderSelectColumns, transitionOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { eq } from "drizzle-orm"
import { fulfillmentStatusSchema, validationMessage } from "@/lib/server/mutation-validation"
import { settleDeliveredOrderAfterTokenHandoff } from "@/lib/server/order-fulfillment"

const PROGRESS_STATUSES = FULFILLMENT_STATUSES.filter(
  (status) => status !== "NOT_STARTED"
) as FulfillmentStatus[]

/** The order this route reads and, once delivered, may settle. */
type ProgressOrder = {
  id: number
  tid: string
  organizationId: number | null
  branchId: number
}

/**
 * Settle an order whose fulfilment token already reached admin operations.
 *
 * A hand-off does not complete an order on its own — the goods have to arrive —
 * so a token handed over before delivery is remembered on the order. Recording
 * the delivery is the other half of that rule, and this is where it is applied.
 *
 * It runs after the progress transition has committed, never inside it: the
 * settlement opens its own transaction against the same row. It adds no reach —
 * this request has already been authorized against this order, and it settles
 * that order alone, re-asserting the same tenant and branch.
 *
 * An order with no hand-off recorded is left approved exactly as before, which
 * is every order whose token is redeemed by the administrator directly.
 */
async function settleOnDeliveryIfTokenHandedOff(
  order: ProgressOrder,
  actorUserId: string,
): Promise<boolean> {
  const outcome = await settleDeliveredOrderAfterTokenHandoff({
    orderId: order.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
  })

  if (outcome !== "fulfilled") return false

  await db.insert(auditLogs).values({
    userId: actorUserId,
    organizationId: order.organizationId,
    branchId: order.branchId,
    action: "ORDER_FULFILLED_ON_DELIVERY",
    entity: "Order",
    entityId: String(order.id),
    metadata: {
      tid: order.tid,
      reason: "Fulfilment token was already handed to admin operations; delivery completed the order",
    },
  })

  return true
}

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

  const fulfilled = nextStatus === "DELIVERED"
    && await settleOnDeliveryIfTokenHandedOff(
      { id: order.id, tid: order.tid, organizationId: order.organizationId, branchId: order.branchId },
      user.id,
    )

  // Settling the order changed the row this response reports, so it is read
  // back rather than describing the state it had a moment earlier.
  const [settledOrder] = fulfilled
    ? await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
    : []

  return ok({
    message: fulfilled
      ? "Fulfillment progress updated — the order is now marked fulfilled"
      : "Fulfillment progress updated",
    fulfilled,
    item: settledOrder ?? updated,
  })
}
