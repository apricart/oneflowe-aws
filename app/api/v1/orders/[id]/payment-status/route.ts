import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser, verifyResourceAccess } from "@/lib/auth"
import { db } from "@/lib/db"
import { auditLogs, orders, refunds } from "@/db/schema"
import { PAYMENT_STATUSES, normalizePaymentStatus } from "@/lib/payment-status"
import { orderSelectColumns, transitionOrderPaymentStatusColumn } from "@/lib/order-select"
import { and, eq, inArray } from "drizzle-orm"
import { paymentStatusSchema, validationMessage } from "@/lib/server/mutation-validation"

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
  const parsedBody = paymentStatusSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const rawStatus = parsedBody.data.paymentStatus
  if (!PAYMENT_STATUSES.includes(rawStatus as (typeof PAYMENT_STATUSES)[number])) {
    return error("Invalid payment status. Must be PAID or UNPAID.", 400)
  }
  const nextStatus = normalizePaymentStatus(rawStatus)

  const [order] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!order) return error("Order not found", 404)

  const hasAccess = await verifyResourceAccess(order.organizationId, order.branchId)
  if (!hasAccess) return error("Forbidden: You do not have access to this order", 403)

  const currentStatus = normalizePaymentStatus(order.paymentStatus)
  if (currentStatus === nextStatus) {
    return error(`Order is already marked ${nextStatus}`, 400)
  }

  const updated = await db.transaction(async (tx) => {
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
      },
    })

    return { ...order, paymentStatus: nextStatus }
  }).catch((transitionError: any) => {
    if (transitionError?.message === "PAID_REFUND_EXISTS") return "paid-refund-exists" as const
    throw transitionError
  })

  if (updated === "missing-column") {
    return error("Payment status migration has not been applied. Run the order payment status migration first.", 503)
  }
  if (updated === "conflict") return error("Payment status was already changed by another request", 409)
  if (updated === "paid-refund-exists") {
    return error("An order with an approved refund cannot be marked unpaid", 409)
  }

  return ok({
    message: `Order marked ${nextStatus === "PAID" ? "Paid" : "Unpaid"}`,
    item: updated,
  })
}
