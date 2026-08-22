import "server-only"

import { and, eq, gte, sql } from "drizzle-orm"

import { auditLogs, budgets, globalProducts, orderItems, orders } from "@/db/schema"
import type { RequestScope } from "@/lib/auth"
import { generateApprovalToken, hashApprovalToken } from "@/lib/approval-token"
import { db } from "@/lib/db"
import { logTokenGenerated } from "@/lib/global-logger"
import { orderSelectColumns } from "@/lib/order-select"
import { authorizeOrderDecision } from "@/lib/server/order-decision-policy"
import {
  queueOrderDecisionNotification,
  queueSuperAdminApprovalNotifications,
} from "@/lib/server/order-notifications"
import { releaseHeldQuantityBudgetForOrder } from "@/lib/server/product-quantity-budget-ledger"

/**
 * The approve and reject transitions, extracted so every caller reaches them
 * through one implementation.
 *
 * This module holds exactly the logic that previously lived inline in
 * `app/api/v1/orders/[id]/approve` and `.../reject`; those routes now delegate
 * here, and the multi-branch bulk endpoint calls the same functions per order.
 * Authorization is never re-implemented by a caller — every path runs
 * `authorizeOrderDecision` inside the same transaction as the status change, so
 * a GROUP_USER deciding many orders is held to precisely the same tenant and
 * branch-scope checks as a BRANCH_ADMIN deciding one.
 *
 * Callers receive the queued notification event keys rather than having mail
 * sent for them, so a bulk decision flushes one batch instead of one delivery
 * attempt per order.
 */

type DecisionActor = {
  id: string
  email?: string | null
  role: string
}

export type OrderDecisionInput = {
  orderId: number
  scope: RequestScope
  user: DecisionActor
}

type DecidedOrder = typeof orders.$inferSelect

export type OrderDecisionOutcome =
  | { kind: "approved"; order: DecidedOrder; approvalToken: string; eventKeys: string[] }
  | { kind: "rejected"; order: DecidedOrder; eventKeys: string[] }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "invalid-state"; status: string }
  | { kind: "conflict" }
  | { kind: "ledger-conflict"; decision: "approve" | "reject" }

/** Ledger invariants that mean the transition rolled back rather than applied. */
const LEDGER_INVARIANTS = ["BUDGET_LEDGER_INVARIANT", "QUANTITY_BUDGET_LEDGER_INVARIANT"]

function decisionFailureOutcome(
  transitionError: any,
  decision: "approve" | "reject",
): OrderDecisionOutcome | null {
  if (transitionError?.message === "ORDER_TRANSITION_CONFLICT") return { kind: "conflict" }
  if (LEDGER_INVARIANTS.includes(transitionError?.message)) {
    return { kind: "ledger-conflict", decision }
  }
  return null
}

/** Collapse an unsuccessful transaction result into the shared outcome shape. */
function unsuccessfulOutcome(
  result: { kind: string; status?: string },
): OrderDecisionOutcome {
  if (result.kind === "invalid-state") {
    return { kind: "invalid-state", status: result.status ?? "unknown" }
  }
  if (result.kind === "not-found") return { kind: "not-found" }
  if (result.kind === "forbidden") return { kind: "forbidden" }
  return { kind: "conflict" }
}

export async function approveOrder({
  orderId,
  scope,
  user,
}: OrderDecisionInput): Promise<OrderDecisionOutcome> {
  // Generated before the transaction so the plaintext is never read back out of
  // committed state; it is returned to the approver exactly once.
  const plainToken = generateApprovalToken(10)

  const decisionResult = await db.transaction(async (tx) => {
    const authorization = await authorizeOrderDecision(tx, { orderId, scope })
    if (!authorization.ok) return { kind: authorization.reason } as const
    const ord = authorization.order

    if (ord.status.toUpperCase() !== "PENDING") {
      return { kind: "invalid-state", status: ord.status } as const
    }

    const tokenHash = await hashApprovalToken(plainToken)
    const [approved] = await tx.update(orders).set({
      status: "APPROVED",
      approvedByUserId: user.id,
      approvedAt: new Date(),
      approvalToken: plainToken,
      approvalTokenHash: tokenHash,
      approvalTokenCreatedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(orders.id, orderId),
      sql`UPPER(${orders.status}) = 'PENDING'`,
    )).returning({ id: orders.id })

    if (!approved) return { kind: "conflict" } as const

    const creatorNotifications = await queueOrderDecisionNotification(tx, {
      order: ord,
      decision: "APPROVED",
    })
    const superAdminNotifications = await queueSuperAdminApprovalNotifications(tx, {
      order: ord,
      approvedByUserId: user.id,
      approvedByRole: authorization.decisionRole,
    })

    await tx.insert(auditLogs).values({
      userId: user.id,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
      action: "ORDER_APPROVED",
      entity: "order",
      entityId: String(ord.id),
      metadata: {
        tid: ord.tid,
        actorRole: user.role,
        decisionRole: authorization.decisionRole,
        configuredApproverRole: authorization.configuredApproverRole,
      },
    })

    return {
      kind: "approved",
      order: ord,
      creatorNotifications,
      superAdminNotifications,
    } as const
  })

  if (decisionResult.kind !== "approved") return unsuccessfulOutcome(decisionResult)

  const ord = decisionResult.order
  logTokenGenerated(orderId, ord.tid, user.id, user.email || "unknown")

  if (decisionResult.creatorNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] Approved order creator was not an active scoped Order Portal user", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }
  if (decisionResult.superAdminNotifications.recipientCount === 0) {
    console.warn("[OrderNotifications] No active Super Admin recipient was available", {
      orderId,
      organizationId: ord.organizationId,
      branchId: ord.branchId,
    })
  }

  return {
    kind: "approved",
    order: ord,
    approvalToken: plainToken,
    eventKeys: [
      ...decisionResult.creatorNotifications.eventKeys,
      ...decisionResult.superAdminNotifications.eventKeys,
    ],
  }
}

export async function rejectOrder({
  orderId,
  scope,
  user,
  reason,
}: OrderDecisionInput & { reason: string }): Promise<OrderDecisionOutcome> {
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
        rejectionReason: reason,
        updatedAt: new Date(),
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
          eq(budgets.period, orderMonth),
        ),
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
            updatedAt: new Date(),
          })
          .where(eq(globalProducts.id, item.globalProductId))
      }

      const notifications = await queueOrderDecisionNotification(tx, {
        order: rejectedOrder,
        decision: "REJECTED",
        rejectionReason: reason,
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
          reason,
          actorRole: user.role,
          decisionRole: authorization.decisionRole,
          configuredApproverRole: authorization.configuredApproverRole,
        },
      })

      return {
        kind: "rejected",
        order: rejectedOrder,
        notifications,
      } as const
    })

    if (decisionResult.kind !== "rejected") return unsuccessfulOutcome(decisionResult)

    if (decisionResult.notifications.recipientCount === 0) {
      console.warn("[OrderNotifications] Rejected order creator was not an active scoped Order Portal user", {
        orderId,
        organizationId: decisionResult.order.organizationId,
        branchId: decisionResult.order.branchId,
      })
    }

    return {
      kind: "rejected",
      order: decisionResult.order as DecidedOrder,
      eventKeys: decisionResult.notifications.eventKeys,
    }
  } catch (transitionError: any) {
    const outcome = decisionFailureOutcome(transitionError, "reject")
    if (outcome) return outcome
    throw transitionError
  }
}

/** The user-facing message for every non-success outcome. */
export function orderDecisionErrorResponse(
  outcome: OrderDecisionOutcome,
  decision: "approve" | "reject",
): { message: string; status: number } | null {
  switch (outcome.kind) {
    case "not-found":
      return { message: "Order not found", status: 404 }
    case "forbidden":
      return { message: "Forbidden", status: 403 }
    case "invalid-state":
      return { message: `Cannot ${decision} order in ${outcome.status} state`, status: 400 }
    case "conflict":
      return { message: "Order was already approved, rejected, or otherwise changed", status: 409 }
    case "ledger-conflict":
      return {
        message: outcome.decision === "reject"
          ? "Order budget hold is inconsistent; rejection was not applied"
          : "Order budget hold is inconsistent; approval was not applied",
        status: 409,
      }
    default:
      return null
  }
}
