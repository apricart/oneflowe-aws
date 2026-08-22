import "server-only"

import { and, eq, gte, sql } from "drizzle-orm"

import { budgets, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { isTokenHandoffEligible } from "@/lib/order-token-handoff"
import { orderSelectColumns, updateOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { moveHeldQuantityBudgetToUsedForOrder } from "@/lib/server/product-quantity-budget-ledger"

/**
 * The APPROVED → FULFILLED transition, extracted so every caller reaches it
 * through one implementation.
 *
 * This module holds exactly the logic that previously lived inline in
 * `app/api/v1/orders/[id]/fulfill`; that route now delegates here, and the
 * token hand-off endpoints call the same function once the token has reached
 * admin operations. Nothing about the transition itself changed: the same
 * single-winner claim, the same money and quantity ledger moves, the same
 * DELIVERED progress write.
 *
 * Authorization is **not** performed here. Every caller has already decided
 * that this actor may act on this order, and passes the tenant and branch it
 * authorized so the claim can re-assert them in its own WHERE clause — a
 * mismatched pair simply claims nothing rather than moving another tenant's
 * ledgers.
 */

export type OrderFulfillmentTarget = {
  orderId: number
  /**
   * The tenant the caller authorized; re-asserted by the claim. Orders predate
   * the column being required, so a legacy row can still carry no tenant at
   * all — there is simply nothing to re-assert for those, and the caller's own
   * authorization remains what allowed the transition.
   */
  organizationId: number | null
  /** The branch the caller authorized; re-asserted by the claim. */
  branchId: number
  /** The actor whose action settled the order. */
  fulfilledByUserId: string
}

export type OrderFulfillmentOutcome =
  | "fulfilled"
  | "conflict"
  | "ledger-conflict"
  | "migration-missing"

/** Ledger invariants that mean the transition rolled back rather than applied. */
const LEDGER_INVARIANTS = ["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"]

function fulfillmentFailureOutcome(transitionError: any): OrderFulfillmentOutcome | null {
  if (transitionError?.message === "ORDER_TRANSITION_CONFLICT") return "conflict"
  if (LEDGER_INVARIANTS.includes(transitionError?.message)) return "ledger-conflict"
  if (transitionError?.message === "FULFILLMENT_MIGRATION_MISSING") return "migration-missing"
  return null
}

/** Move this branch period's money ledger from held to spent, or fail closed. */
async function moveBudgetHeldToSpent(
  tx: any,
  fulfilledOrder: { branchId: number; totalCents: number; createdAt: Date | string | null },
) {
  const orderMonth = fulfilledOrder.createdAt
    ? new Date(fulfilledOrder.createdAt).toISOString().slice(0, 7)
    : new Date().toISOString().slice(0, 7)

  const [budget] = await tx.select().from(budgets).where(
    and(
      eq(budgets.branchId, fulfilledOrder.branchId),
      eq(budgets.period, orderMonth)
    )
  ).limit(1)

  if (!budget) return

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

/**
 * Settle one approved order: status, delivery progress, and both ledgers, in a
 * single transaction. Unexpected errors are rethrown; the outcomes above are
 * the states a caller is expected to handle.
 */
export async function fulfillApprovedOrder({
  orderId,
  organizationId,
  branchId,
  fulfilledByUserId,
}: OrderFulfillmentTarget): Promise<OrderFulfillmentOutcome> {
  try {
    await db.transaction(async (tx) => {
      // Claim the transition so only one simultaneous fulfilment can move ledgers.
      const fulfilledAt = new Date()
      const [fulfilledOrder] = await tx.update(orders).set({
        status: "FULFILLED",
        deliveredAt: fulfilledAt,
        fulfilledAt,
        fulfilledByUserId,
        updatedAt: fulfilledAt,
      }).where(and(
        eq(orders.id, orderId),
        organizationId === null ? undefined : eq(orders.organizationId, organizationId),
        eq(orders.branchId, branchId),
        sql`UPPER(${orders.status}) = 'APPROVED'`,
      )).returning(orderSelectColumns)

      if (!fulfilledOrder) throw new Error("ORDER_TRANSITION_CONFLICT")
      const migrationReady = await updateOrderFulfillmentStatusColumn(tx, orderId, "DELIVERED")
      if (!migrationReady) throw new Error("FULFILLMENT_MIGRATION_MISSING")

      await moveBudgetHeldToSpent(tx, fulfilledOrder)
      await moveHeldQuantityBudgetToUsedForOrder(tx, fulfilledOrder)
    })
  } catch (transitionError: any) {
    const outcome = fulfillmentFailureOutcome(transitionError)
    if (outcome) return outcome
    throw transitionError
  }

  return "fulfilled"
}

/**
 * Settle every order whose token has just been handed to admin operations, and
 * report which ones actually moved.
 *
 * The message has already left by the time this runs, so one order that cannot
 * move — a fulfilment someone else won, an inconsistent budget hold — must
 * neither fail the hand-off nor stop the orders behind it. Each order gets its
 * own transaction for exactly that reason, and the caller reports the real
 * count rather than assuming every token settled its order.
 */
export async function fulfillOrdersAfterTokenHandoff(
  candidates: ReadonlyArray<OrderFulfillmentTarget & { status?: string | null }>,
): Promise<Set<number>> {
  const fulfilledOrderIds = new Set<number>()

  for (const candidate of candidates) {
    if (!isTokenHandoffEligible(candidate.status)) continue
    try {
      const outcome = await fulfillApprovedOrder(candidate)
      if (outcome === "fulfilled") fulfilledOrderIds.add(candidate.orderId)
      else console.warn(`[TokenHandoff] Order ${candidate.orderId} not fulfilled: ${outcome}`)
    } catch (fulfillmentError) {
      console.error(`[TokenHandoff] Fulfilment failed for order ${candidate.orderId}:`, fulfillmentError)
    }
  }

  return fulfilledOrderIds
}
