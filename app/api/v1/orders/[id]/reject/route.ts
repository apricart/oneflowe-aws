import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { orders, budgets, globalProducts, orderItems } from "@/db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { getCurrentUser } from "@/lib/auth"
import { releaseHeldQuantityBudgetForOrder } from "@/lib/server/product-quantity-budget-ledger"
import { orderSelectColumns } from "@/lib/order-select"
import { rejectionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { attemptImmediateOrderEmailDelivery, queueOrderDecisionNotification, type QueuedOrderNotifications } from "@/lib/server/order-notifications"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "SUPER_ADMIN"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()
  const rawBody = await readJson<unknown>(req)
  const parsedBody = rejectionSchema.safeParse(rawBody)

  if (!user) return error("Unauthorized", 401)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const input = parsedBody.data

  // Fetch order
  const [ord] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!ord) return error("Order not found", 404)

  // BOLA
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(ord.organizationId, ord.branchId)
  if (!hasAccess) return error("Forbidden", 403)

  if (ord.status.toUpperCase() !== "PENDING") {
    return error(`Cannot reject order in ${ord.status} state`, 400)
  }

  let queuedNotifications: QueuedOrderNotifications = { eventKeys: [], recipientCount: 0 }
  try {
    queuedNotifications = await db.transaction(async (tx) => {
      // Claim the transition. Only one simultaneous rejection/approval can win.
      const [rejectedOrder] = await tx.update(orders).set({
        status: "REJECTED",
        rejectedByUserId: user.id,
        rejectedAt: new Date(),
        rejectionReason: input.reason,
        updatedAt: new Date()
      }).where(and(
        eq(orders.id, orderId),
        sql`UPPER(${orders.status}) = 'PENDING'`,
      )).returning(orderSelectColumns)

      if (!rejectedOrder) throw new Error("ORDER_TRANSITION_CONFLICT")

      // 2. Restore budget
      const orderMonth = rejectedOrder.createdAt
        ? new Date(rejectedOrder.createdAt).toISOString().slice(0, 7)
        : new Date().toISOString().slice(0, 7)

      const [budget] = await tx.select().from(budgets).where(
        and(
          eq(budgets.branchId, rejectedOrder.branchId),
          eq(budgets.period, orderMonth)
        )
      ).limit(1)

      if (budget) {
        const [releasedBudget] = await tx.update(budgets).set({
          amountHeldCents: sql`${budgets.amountHeldCents} - ${rejectedOrder.totalCents}`,
          updatedAt: new Date(),
        }).where(and(
          eq(budgets.id, budget.id),
          gte(budgets.amountHeldCents, rejectedOrder.totalCents),
        )).returning({ id: budgets.id })
        if (!releasedBudget) throw new Error("BUDGET_LEDGER_INVARIANT")
      }

      // 3. Release quantity budget and restore stock
      await releaseHeldQuantityBudgetForOrder(tx, rejectedOrder)

      const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId))
      for (const item of items) {
        await tx.update(globalProducts)
          .set({
            stockQuantity: sql`${globalProducts.stockQuantity} + ${item.quantity}`,
            updatedAt: new Date()
          })
          .where(eq(globalProducts.id, item.globalProductId))
      }

      return queueOrderDecisionNotification(tx, {
        order: rejectedOrder,
        decision: "REJECTED",
        rejectionReason: input.reason,
      })
    })
  } catch (transitionError: any) {
    if (transitionError?.message === "ORDER_TRANSITION_CONFLICT") {
      return error("Order was already approved, rejected, or otherwise changed", 409)
    }
    if (["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(transitionError?.message)) {
      return error("Order budget hold is inconsistent; rejection was not applied", 409)
    }
    throw transitionError
  }

  if (queuedNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] Rejected order creator was not an active scoped Order Portal user", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  await attemptImmediateOrderEmailDelivery(queuedNotifications.eventKeys)

  return ok({ message: "Order rejected successfully" })
}
