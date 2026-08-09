import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { auditLogs, orders, budgets, globalProducts, orderItems } from "@/db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { getCurrentUser, getRequestScope } from "@/lib/auth"
import { releaseHeldQuantityBudgetForOrder } from "@/lib/server/product-quantity-budget-ledger"
import { orderSelectColumns } from "@/lib/order-select"
import { rejectionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { attemptImmediateOrderEmailDelivery, queueOrderDecisionNotification, type QueuedOrderNotifications } from "@/lib/server/order-notifications"
import { authorizeOrderDecision } from "@/lib/server/order-decision-policy"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE"])
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
  const input = parsedBody.data

  let queuedNotifications: QueuedOrderNotifications = { eventKeys: [], recipientCount: 0 }
  let decidedOrder: { organizationId: number | null; branchId: number } | null = null
  try {
    const decisionResult = await db.transaction(async (tx) => {
      const authorization = await authorizeOrderDecision(tx, { orderId, scope })
      if (!authorization.ok) return { kind: authorization.reason } as const
      const ord = authorization.order

      if (ord.status.toUpperCase() !== "PENDING") {
        return { kind: "invalid-state", status: ord.status } as const
      }

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

      const notifications = await queueOrderDecisionNotification(tx, {
        order: rejectedOrder,
        decision: "REJECTED",
        rejectionReason: input.reason,
      })

      await tx.insert(auditLogs).values({
        userId: user.id,
        organizationId: rejectedOrder.organizationId,
        branchId: rejectedOrder.branchId,
        action: "ORDER_REJECTED",
        entity: "order",
        entityId: String(rejectedOrder.id),
        metadata: {
          tid: rejectedOrder.tid,
          reason: input.reason,
          actorRole: user.role,
          configuredApproverRole: authorization.configuredApproverRole,
        },
      })

      return {
        kind: "rejected",
        order: rejectedOrder,
        notifications,
      } as const
    })

    if (decisionResult.kind === "not-found") return error("Order not found", 404)
    if (decisionResult.kind === "forbidden") return error("Forbidden", 403)
    if (decisionResult.kind === "invalid-state") {
      return error(`Cannot reject order in ${decisionResult.status} state`, 400)
    }
    if (decisionResult.kind !== "rejected") {
      return error("Order rejection could not be completed", 409)
    }
    queuedNotifications = decisionResult.notifications
    decidedOrder = decisionResult.order
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
      organizationId: decidedOrder?.organizationId,
      branchId: decidedOrder?.branchId,
    })
  }
  await attemptImmediateOrderEmailDelivery(queuedNotifications.eventKeys)

  return ok({ message: "Order rejected successfully" })
}
