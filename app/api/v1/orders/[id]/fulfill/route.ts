import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { orders, budgets } from "@/db/schema"
import { eq, and, gte, sql } from "drizzle-orm"
import { getCurrentUser } from "@/lib/auth"
import { verifyApprovalToken } from "@/lib/approval-token"
import { logFulfillmentAttempt } from "@/lib/global-logger"
import { moveHeldQuantityBudgetToUsedForOrder } from "@/lib/server/product-quantity-budget-ledger"
import { orderSelectColumns, updateOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { fulfillmentSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  // Only SUPER_ADMIN or HEAD_OFFICE can fulfill
  const err = await requireApiRole(["HEAD_OFFICE", "SUPER_ADMIN"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()
  const rawBody = await readJson<unknown>(req)
  const parsedBody = fulfillmentSchema.safeParse(rawBody)

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

  if (ord.status.toUpperCase() !== "APPROVED") {
    return error(`Cannot fulfill order in ${ord.status} state`, 400)
  }

  if (!ord.approvalTokenHash) {
    return error("Order has no approval token - cannot fulfill", 400)
  }

  const isValid = await verifyApprovalToken(input.approvalToken, ord.approvalTokenHash)

  if (!isValid) {
    logFulfillmentAttempt(
      orderId,
      ord.tid,
      user.id,
      user.email || "unknown",
      user.role,
      false,
      "Invalid token provided"
    )
    return error("Invalid approval token - fulfillment denied", 403)
  }

  try {
    await db.transaction(async (tx) => {
      // Claim the transition so only one simultaneous fulfilment can move ledgers.
      const fulfilledAt = new Date()
      const [fulfilledOrder] = await tx.update(orders).set({
        status: "FULFILLED",
        deliveredAt: fulfilledAt,
        fulfilledAt,
        fulfilledByUserId: user.id,
        updatedAt: fulfilledAt,
      }).where(and(
        eq(orders.id, orderId),
        sql`UPPER(${orders.status}) = 'APPROVED'`,
      )).returning(orderSelectColumns)

      if (!fulfilledOrder) throw new Error("ORDER_TRANSITION_CONFLICT")
      const migrationReady = await updateOrderFulfillmentStatusColumn(tx, orderId, "DELIVERED")
      if (!migrationReady) throw new Error("FULFILLMENT_MIGRATION_MISSING")

      // 2. Move budget from held to spent
      const orderMonth = fulfilledOrder.createdAt
        ? new Date(fulfilledOrder.createdAt).toISOString().slice(0, 7)
        : new Date().toISOString().slice(0, 7)

      const [budget] = await tx.select().from(budgets).where(
        and(
          eq(budgets.branchId, fulfilledOrder.branchId),
          eq(budgets.period, orderMonth)
        )
      ).limit(1)

      if (budget) {
        const [movedBudget] = await tx.update(budgets).set({
          amountHeldCents: sql`${budgets.amountHeldCents} - ${fulfilledOrder.totalCents}`,
          amountSpentCents: sql`${budgets.amountSpentCents} + ${fulfilledOrder.totalCents}`,
          updatedAt: new Date(),
        }).where(and(
          eq(budgets.id, budget.id),
          gte(budgets.amountHeldCents, fulfilledOrder.totalCents),
        )).returning({ id: budgets.id })
        if (!movedBudget) throw new Error("BUDGET_LEDGER_INVARIANT")
      }

      await moveHeldQuantityBudgetToUsedForOrder(tx, fulfilledOrder)
    })
  } catch (transitionError: any) {
    if (transitionError?.message === "ORDER_TRANSITION_CONFLICT") {
      return error("Order was already fulfilled or otherwise changed", 409)
    }
    if (["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"].includes(transitionError?.message)) {
      return error("Order budget hold is inconsistent; fulfilment was not applied", 409)
    }
    if (transitionError?.message === "FULFILLMENT_MIGRATION_MISSING") {
      return error("Fulfillment progress migration has not been applied", 503)
    }
    throw transitionError
  }

  return ok({ message: "Order fulfilled successfully" })
}
