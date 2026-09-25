import "server-only"

import { and, eq, gte, sql } from "drizzle-orm"

import { budgets, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { isTokenHandoffEligible, tokenHandoffSettlesNow } from "@/lib/order-token-handoff"
import { orderSelectColumns, updateOrderFulfillmentStatusColumn } from "@/lib/order-select"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { moveHeldQuantityBudgetToUsedForOrder } from "@/lib/server/product-quantity-budget-ledger"
import {
  findPendingTokenHandoff,
  recordOrderTokenHandoff,
  type TokenHandoffTarget,
} from "@/lib/server/order-token-handoff-store"

/**
 * The APPROVED → FULFILLED transition, extracted so every caller reaches it
 * through one implementation.
 *
 * This module holds exactly the logic that previously lived inline in
 * `app/api/v1/orders/[id]/fulfill`; that route now delegates here, and the
 * token hand-off endpoints reach the same function once the token has reached
 * admin operations **and** the order has been delivered. The transition itself
 * is unchanged: the same single-winner claim, the same money and quantity
 * ledger moves.
 *
 * The one thing a caller chooses is what the transition means for delivery.
 * The Super Admin fulfilment route redeems a token in person and records the
 * delivery as part of settling the order ("record-delivery"). A token hand-off
 * settles an order the delivery status already calls DELIVERED, and must leave
 * that recorded delivery moment exactly as it stands ("require-delivered").
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
  /**
   * The actor whose action settled the order. Null only where no person
   * triggered it — a hand-off whose sender was never recorded, for instance —
   * which is the same value the unattended sweep writes.
   */
  fulfilledByUserId: string | null
  /**
   * Whether this transition records the delivery itself, or requires the order
   * to be delivered already. Defaults to recording it, which is what the
   * Super Admin fulfilment route has always done.
   */
  delivery?: OrderDeliveryHandling
}

/**
 * How a fulfilment relates to physical delivery.
 *
 * - `record-delivery`: the transition marks the order delivered as it settles.
 * - `require-delivered`: the order must already be delivered, and its recorded
 *   delivery moment is left untouched. A not-yet-delivered order simply is not
 *   claimed, so this can never settle goods that have not arrived.
 */
export type OrderDeliveryHandling = "record-delivery" | "require-delivered"

export type OrderFulfillmentOutcome =
  | "fulfilled"
  | "conflict"
  | "ledger-conflict"
  | "migration-missing"

/** Ledger invariants that mean the transition rolled back rather than applied. */
const LEDGER_INVARIANTS = ["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"]

/**
 * "The goods have arrived", read the way every other delivery read in the
 * codebase reads it: through `to_jsonb`, so a database whose fulfilment-status
 * migration has not been applied reports NOT_STARTED rather than failing.
 */
const DELIVERED_ORDER_CONDITION = sql`UPPER(TRIM(COALESCE(to_jsonb("orders") ->> 'fulfillment_status', 'NOT_STARTED'))) = 'DELIVERED'`

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
  const orderMonth = budgetPeriodOf(fulfilledOrder.createdAt)

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
  delivery = "record-delivery",
}: OrderFulfillmentTarget): Promise<OrderFulfillmentOutcome> {
  const requiresDelivery = delivery === "require-delivered"
  try {
    await db.transaction(async (tx) => {
      // Claim the transition so only one simultaneous fulfilment can move ledgers.
      const fulfilledAt = new Date()
      const [fulfilledOrder] = await tx.update(orders).set({
        status: "FULFILLED",
        // A delivered order keeps the moment it was actually delivered; only a
        // transition that records the delivery itself writes this.
        ...(requiresDelivery ? {} : { deliveredAt: fulfilledAt }),
        fulfilledAt,
        fulfilledByUserId,
        updatedAt: fulfilledAt,
      }).where(and(
        eq(orders.id, orderId),
        organizationId === null ? undefined : eq(orders.organizationId, organizationId),
        eq(orders.branchId, branchId),
        sql`UPPER(${orders.status}) = 'APPROVED'`,
        // Part of the same single-winner claim, so an order that is not
        // delivered yet is never settled by a caller that requires delivery.
        requiresDelivery ? DELIVERED_ORDER_CONDITION : undefined,
      )).returning(orderSelectColumns)

      if (!fulfilledOrder) throw new Error("ORDER_TRANSITION_CONFLICT")
      if (!requiresDelivery) {
        const migrationReady = await updateOrderFulfillmentStatusColumn(tx, orderId, "DELIVERED")
        if (!migrationReady) throw new Error("FULFILLMENT_MIGRATION_MISSING")
      }

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
 * What one hand-off did to its order.
 *
 * `fulfilledOrderIds` are the orders that were already delivered and are now
 * settled; `awaitingDeliveryOrderIds` are the ones whose hand-off is recorded
 * and which will settle the moment their delivery is recorded. An order in
 * neither set had its token sent but could not be recorded — a fulfilment
 * someone else won, or a status that moved underneath the request.
 */
export type TokenHandoffSettlement = {
  fulfilledOrderIds: Set<number>
  awaitingDeliveryOrderIds: Set<number>
}

/**
 * One order whose token has just been emailed to admin operations.
 *
 * The sender is named rather than a "fulfiller": handing the token over no
 * longer settles the order on its own, and when it does settle — now or at
 * delivery — this is the person credited with it.
 */
export type TokenHandoffCandidate = TokenHandoffTarget & {
  /** The order's status as the sending route read it. */
  status?: string | null
  handedOffByUserId: string
}

/** Record one hand-off and settle its order if the goods have already arrived. */
async function settleOneTokenHandoff(
  candidate: TokenHandoffCandidate,
  settlement: TokenHandoffSettlement,
): Promise<void> {
  const record = await recordOrderTokenHandoff(candidate)

  if (record.outcome !== "recorded") {
    console.warn(`[TokenHandoff] Order ${candidate.orderId} hand-off not recorded: ${record.outcome}`)
    return
  }

  // Not delivered yet: the hand-off is remembered, and recording the delivery
  // is what will settle the order.
  if (!tokenHandoffSettlesNow(candidate.status, record.fulfillmentStatus)) {
    settlement.awaitingDeliveryOrderIds.add(candidate.orderId)
    return
  }

  const outcome = await fulfillApprovedOrder({
    orderId: candidate.orderId,
    organizationId: candidate.organizationId,
    branchId: candidate.branchId,
    fulfilledByUserId: candidate.handedOffByUserId,
    delivery: "require-delivered",
  })
  if (outcome === "fulfilled") settlement.fulfilledOrderIds.add(candidate.orderId)
  else console.warn(`[TokenHandoff] Order ${candidate.orderId} not fulfilled: ${outcome}`)
}

/**
 * Record every token that has just been handed to admin operations, settle the
 * orders that have already been delivered, and report which ones did which.
 *
 * The message has already left by the time this runs, so one order that cannot
 * move — a fulfilment someone else won, an inconsistent budget hold — must
 * neither fail the hand-off nor stop the orders behind it. Each order gets its
 * own transactions for exactly that reason, and the caller reports the real
 * counts rather than assuming every token settled its order.
 *
 * Recording the hand-off is deliberately committed before the settlement is
 * attempted: a settlement that fails leaves the hand-off on the order, so the
 * delivery transition (or the unattended sweep behind it) can still settle it.
 */
export async function settleOrdersAfterTokenHandoff(
  candidates: ReadonlyArray<TokenHandoffCandidate>,
): Promise<TokenHandoffSettlement> {
  const settlement: TokenHandoffSettlement = {
    fulfilledOrderIds: new Set<number>(),
    awaitingDeliveryOrderIds: new Set<number>(),
  }

  for (const candidate of candidates) {
    if (!isTokenHandoffEligible(candidate.status)) continue
    try {
      await settleOneTokenHandoff(candidate, settlement)
    } catch (fulfillmentError) {
      console.error(`[TokenHandoff] Hand-off failed for order ${candidate.orderId}:`, fulfillmentError)
    }
  }

  return settlement
}

/** What recording a delivery did to an order that was waiting on its token. */
export type DeliverySettlementOutcome =
  /** The token had been handed over, so the delivery settled the order. */
  | "fulfilled"
  /** No token has been handed to admin operations yet; nothing to settle. */
  | "no-handoff"
  /** A hand-off is recorded but the order could not be settled right now. */
  | "not-settled"

/**
 * Settle an order that has just been delivered and whose token already reached
 * admin operations.
 *
 * This is the second half of the hand-off rule: the token arrived before the
 * goods, so the order was left approved with the hand-off remembered, and the
 * delivery is what completes it. It grants nobody new reach — the caller has
 * already been authorized against this order, passes the tenant and branch it
 * authorized, and both are re-asserted by the claim.
 *
 * The order is credited to whoever handed the token over rather than to the
 * administrator who recorded the delivery, so the settled order names the same
 * person it would have named had the goods already been there.
 *
 * It must be called after the delivery transition has committed: it opens its
 * own transaction against the same row.
 */
export async function settleDeliveredOrderAfterTokenHandoff(
  target: TokenHandoffTarget,
): Promise<DeliverySettlementOutcome> {
  const handoff = await findPendingTokenHandoff(target)
  if (!handoff) return "no-handoff"

  const outcome = await fulfillApprovedOrder({
    ...target,
    fulfilledByUserId: handoff.handedOffByUserId,
    delivery: "require-delivered",
  })

  if (outcome === "fulfilled") return "fulfilled"
  console.warn(`[TokenHandoff] Delivered order ${target.orderId} not settled: ${outcome}`)
  return "not-settled"
}
