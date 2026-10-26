import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, verifyResourceAccess } from "@/lib/auth"
import { db } from "@/lib/db"
import { auditLogs, orders, refunds } from "@/db/schema"
import { isPaymentStatusUpdateEligible } from "@/lib/business-rules"
import { PAYMENT_STATUSES, normalizePaymentStatus } from "@/lib/payment-status"
import { orderSelectColumns, transitionOrderPaymentStatusColumn } from "@/lib/order-select"
import { and, eq, inArray } from "drizzle-orm"
import { paymentStatusSchema, validationMessage } from "@/lib/server/mutation-validation"
import { PAYMENT_STATUS_UPDATE_ROLES, isFinanceRole } from "@/lib/finance-access"
import { financeReachesOrganization } from "@/lib/server/finance-scope"
import { withRateLimit } from "@/lib/rate-limiter"

/**
 * Mark an approved order Paid or Unpaid. Super Admin anywhere; Finance only in
 * an organization assigned to it, checked before the order's state is revealed
 * and again under a lock inside the write (plans/OF-FINANCE-finance-role.md).
 */
export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const roleError = await requireApiRole([...PAYMENT_STATUS_UPDATE_ROLES])
  if (roleError) return roleError

  const user = await getCurrentUser()
  if (!user) return error("Unauthorized", 401)

  // A reconciliation marks many orders in a row, so the ordinary write limit.
  const rateLimit = await withRateLimit("write", user.id)
  if (rateLimit) return rateLimit

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return error("Invalid order ID", 400)
  }

  const rawBody = await readJson<unknown>(req)
  const parsedBody = paymentStatusSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const rawStatus = parsedBody.data.paymentStatus
  if (!PAYMENT_STATUSES.includes(rawStatus as (typeof PAYMENT_STATUSES)[number])) {
    return error("Invalid payment status. Must be PAID or UNPAID.", 400)
  }
  const nextStatus = normalizePaymentStatus(rawStatus)

  const [order] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return error("Order not found", 404)

  const finance = isFinanceRole(user.role)
  if (finance) {
    // Outside the assigned organizations reads as not found, so an id cannot
    // be used to learn that an order exists or what state it is in.
    if (!await financeReachesOrganization(db, user.id, order.organizationId)) return error("Order not found", 404)
  } else {
    const hasAccess = await verifyResourceAccess(order.organizationId, order.branchId)
    if (!hasAccess) return error("Forbidden: You do not have access to this order", 403)
  }

  if (!isPaymentStatusUpdateEligible(order.status, order.fulfillmentStatus)) {
    return error(
      `Payment status can only be updated for approved orders. Current order status: ${order.status}`,
      400,
    )
  }

  const currentStatus = normalizePaymentStatus(order.paymentStatus)
  if (currentStatus === nextStatus) {
    return error(`Order is already marked ${nextStatus}`, 400)
  }

  const updated = await db.transaction(async (tx) => {
    // Under FOR SHARE on the assignment, so Super Admin withdrawing the
    // organization waits for this write rather than racing past it.
    if (finance && !await financeReachesOrganization(tx, user.id, order.organizationId, { lock: true })) {
      return "out-of-reach" as const
    }

    const transition = await transitionOrderPaymentStatusColumn(tx, orderId, currentStatus, nextStatus, user.id)
    if (transition !== "updated") return transition

    if (nextStatus === "UNPAID") {
      const [approvedRefund] = await tx
        .select({ id: refunds.id })
        .from(refunds)
        .where(and(
          eq(refunds.orderId, orderId),
          inArray(refunds.status, ["APPROVED", "COMPLETED"]),
        ))
        .limit(1)
      if (approvedRefund) throw new Error("PAID_REFUND_EXISTS")
    }

    await tx.insert(auditLogs).values({
      userId: user.id,
      organizationId: order.organizationId,
      branchId: order.branchId,
      action: "ORDER_PAYMENT_STATUS_UPDATE",
      entity: "Order",
      entityId: String(order.id),
      metadata: {
        tid: order.tid,
        from: currentStatus,
        to: nextStatus,
        actorRole: user.role,
      },
    })

    return { ...order, paymentStatus: nextStatus }
  }).catch((transitionError: any) => {
    if (transitionError?.message === "PAID_REFUND_EXISTS") return "paid-refund-exists" as const
    throw transitionError
  })

  if (updated === "out-of-reach") return error("Order not found", 404)
  if (updated === "missing-column") {
    return error("Payment status migration has not been applied. Run the order payment status migration first.", 503)
  }
  if (updated === "conflict") return error("Order state or payment status was already changed by another request", 409)
  if (updated === "paid-refund-exists") {
    return error("An order with an approved refund cannot be marked unpaid", 409)
  }

  return ok({
    message: `Order marked ${nextStatus === "PAID" ? "Paid" : "Unpaid"}`,
    item: updated,
  })
}
