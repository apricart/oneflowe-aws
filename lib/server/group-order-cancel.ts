import "server-only"

import { and, eq, gte, sql } from "drizzle-orm"

import { branches, budgets, globalProducts, groupAuditLogs, groupOrders, orderItems, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { groupOrderCancelRefusal } from "@/lib/group-order-cancel"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { canRequesterActOnOrder, describeOrderWrite } from "@/lib/order-write-access"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { GROUP_ORDER_PORTAL_ROLE, resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { closeOpenCorrectionRequest } from "@/lib/server/order-correction"
import { notifyRaiserOfOrderWrite } from "@/lib/server/order-write-audit"
import { releaseHeldQuantityBudgetForOrder } from "@/lib/server/product-quantity-budget-ledger"
import { queueWarehouseOrderNotifications } from "@/lib/server/warehouse-order-notifications"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * A group requester withdrawing group orders that are still waiting for
 * approval (`plans/OF-GROUP-cancel-pending-group-orders.md`).
 *
 * One branch order, or every pending branch order of one of the requester's
 * own submissions, in a single transaction. Each order is locked, its scope
 * re-checked against the live assignments read inside that transaction, and
 * claimed only while it is still `PENDING` — the same state approve, reject,
 * return and edit claim on, so a cancel racing an approval has one winner.
 *
 * The release mirrors the Order Desk cancel and the rejection path
 * (`lib/server/order-desk-orders.ts`, `lib/server/order-decision-service.ts`):
 * the money hold from the order's own period, only if the order took one, never
 * below zero; the quantity hold; and the stock, line by line.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The signed-in group requester, resolved from the session by the route. */
export type GroupCancelActor = {
  userId: string
  organizationId: number
  role: string
  email?: string | null
}

export type CancelledBranchOrder = { orderId: number; tid: string; branchId: number }
export type KeptBranchOrder = { orderId: number; tid: string; status: string }

export type BranchOrderCancelOutcome =
  | { kind: "cancelled"; order: CancelledBranchOrder }
  | { kind: "not-found" }
  | { kind: "not-pending"; status: string }
  | { kind: "conflict" }

export type SubmissionCancelOutcome =
  | { kind: "cancelled"; reference: string; cancelled: CancelledBranchOrder[]; kept: KeptBranchOrder[] }
  | { kind: "not-found" }
  | { kind: "nothing-pending"; kept: KeptBranchOrder[] }
  | { kind: "conflict" }

const CANCELLATION_ACTION = "ORDER_CANCELLED"
const RAISER_NOTICE_TYPE = "ORDER_CANCELLED_BY_COLLEAGUE"

const lockedOrderColumns = {
  id: orders.id,
  tid: orders.tid,
  status: orders.status,
  organizationId: orders.organizationId,
  branchId: orders.branchId,
  groupOrderId: orders.groupOrderId,
  createdByUserId: orders.createdByUserId,
  createdAt: orders.createdAt,
  totalCents: orders.totalCents,
  budgetTracked: orders.budgetTracked,
}

type LockedOrder = {
  id: number
  tid: string
  status: string
  organizationId: number | null
  branchId: number
  groupOrderId: number | null
  createdByUserId: string | null
  createdAt: Date | null
  totalCents: number
  budgetTracked: boolean
}

/** Whether this requester may act on this order at all — branch and tenant, not status. */
async function isInScope(tx: Tx, actor: GroupCancelActor, branchIds: number[], order: LockedOrder): Promise<boolean> {
  const [branch] = await tx
    .select({ organizationId: branches.organizationId })
    .from(branches)
    .where(eq(branches.id, order.branchId))
    .limit(1)
  return canRequesterActOnOrder(
    { role: GROUP_ORDER_PORTAL_ROLE, userId: actor.userId, organizationId: actor.organizationId, branchIds },
    {
      status: order.status,
      createdByUserId: order.createdByUserId,
      organizationId: order.organizationId,
      branchId: order.branchId,
      branchOrganizationId: branch?.organizationId ?? null,
    },
  )
}

/**
 * Claim one locked, in-scope, pending group order as `CANCELLED` and release
 * everything its creation took. Throws `ORDER_TRANSITION_CONFLICT` when the
 * claim loses a race, which rolls the whole request back.
 */
async function cancelLockedOrder(tx: Tx, input: {
  order: LockedOrder
  reason: string
  actor: GroupCancelActor
  now: Date
  via: "BRANCH_ORDER" | "SUBMISSION"
}): Promise<CancelledBranchOrder> {
  const { order, actor, now } = input
  const previousStatus = String(order.status).toUpperCase()

  const [cancelled] = await tx
    .update(orders)
    .set({
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: actor.userId,
      cancellationReason: input.reason,
      returnedForCorrectionAt: null,
      returnedForCorrectionByUserId: null,
      correctionRequestNote: null,
      updatedAt: now,
    })
    .where(and(
      eq(orders.id, order.id),
      sql`UPPER(${orders.status}) = 'PENDING'`,
    ))
    .returning({ id: orders.id })
  if (!cancelled) throw new Error("ORDER_TRANSITION_CONFLICT")

  const closedCorrectionRequestId = await closeOpenCorrectionRequest(tx, {
    orderId: order.id,
    resolution: "CANCELLED",
    userId: actor.userId,
    role: actor.role,
  })

  if (orderTakesBudget(order)) {
    const [budget] = await tx
      .select({ id: budgets.id })
      .from(budgets)
      .where(and(eq(budgets.branchId, order.branchId), eq(budgets.period, budgetPeriodOf(order.createdAt))))
      .limit(1)
    if (budget) {
      const [released] = await tx
        .update(budgets)
        .set({ amountHeldCents: sql`${budgets.amountHeldCents} - ${order.totalCents}`, updatedAt: now })
        .where(and(eq(budgets.id, budget.id), gte(budgets.amountHeldCents, order.totalCents)))
        .returning({ id: budgets.id })
      if (!released) throw new Error("BUDGET_LEDGER_INVARIANT")
    }
    await releaseHeldQuantityBudgetForOrder(tx, order)
  }

  const items = await tx
    .select({ globalProductId: orderItems.globalProductId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
  // Counted per warehouse, a pending order took nothing, so nothing goes back.
  for (const item of usesWarehouseStock() ? [] : items) {
    await tx
      .update(globalProducts)
      .set({ stockQuantity: sql`${globalProducts.stockQuantity} + ${item.quantity}`, updatedAt: now })
      .where(eq(globalProducts.id, item.globalProductId))
  }

  const write = describeOrderWrite(
    { role: GROUP_ORDER_PORTAL_ROLE, userId: actor.userId, organizationId: actor.organizationId, branchIds: [] },
    {
      status: order.status,
      createdByUserId: order.createdByUserId,
      organizationId: order.organizationId,
      branchId: order.branchId,
      branchOrganizationId: order.organizationId,
    },
  )

  await queueWarehouseOrderNotifications(tx, { order, event: "CANCELLED" })
  await recordAuditEvent(tx, {
    action: CANCELLATION_ACTION,
    entity: "order",
    entityId: order.id,
    actor: { id: actor.userId, role: actor.role, email: actor.email ?? null },
    organizationId: order.organizationId,
    branchId: order.branchId,
    before: { status: previousStatus },
    after: { status: "CANCELLED" },
    context: {
      tid: order.tid,
      reason: input.reason,
      totalCents: order.totalCents,
      groupOrderId: order.groupOrderId,
      via: `GROUP_ORDER_PORTAL_${input.via}`,
      onBehalfOfUserId: write.onBehalfOfUserId,
      closedCorrectionRequestId,
    },
  })

  if (order.organizationId !== null) {
    await notifyRaiserOfOrderWrite(tx, {
      write,
      organizationId: order.organizationId,
      branchId: order.branchId,
      orderId: order.id,
      tid: order.tid,
      type: RAISER_NOTICE_TYPE,
      message: `Your order ${order.tid} was cancelled by a colleague before approval: ${input.reason}`,
    })
  }

  return { orderId: order.id, tid: order.tid, branchId: order.branchId }
}

function conflictToOutcome<T extends { kind: string }>(work: () => Promise<T>): Promise<T | { kind: "conflict" }> {
  return work().catch((error: unknown) => {
    if (error instanceof Error && error.message === "ORDER_TRANSITION_CONFLICT") return { kind: "conflict" as const }
    throw error
  })
}

/** Cancel one pending group branch order inside this requester's scope. */
export function cancelGroupBranchOrder(input: {
  orderId: number
  reason: string
  actor: GroupCancelActor
}): Promise<BranchOrderCancelOutcome> {
  return conflictToOutcome(() => db.transaction(async (tx): Promise<BranchOrderCancelOutcome> => {
    const [order] = await tx
      .select(lockedOrderColumns)
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.organizationId, input.actor.organizationId)))
      .for("update")
      .limit(1)
    if (!order) return { kind: "not-found" }

    const branchIds = await resolveScopedBranchIds(tx, input.actor.userId)
    // Out of reach and "not a group order" both read as missing: neither is
    // this requester's to cancel, and neither should confirm the order exists.
    if (!(await isInScope(tx, input.actor, branchIds, order))) return { kind: "not-found" }
    const refusal = groupOrderCancelRefusal(order)
    if (refusal === "NOT_GROUP_ORDER") return { kind: "not-found" }
    if (refusal === "NOT_PENDING") return { kind: "not-pending", status: order.status }

    const cancelled = await cancelLockedOrder(tx, {
      order,
      reason: input.reason,
      actor: input.actor,
      now: new Date(),
      via: "BRANCH_ORDER",
    })
    return { kind: "cancelled", order: cancelled }
  }))
}

/**
 * Cancel every still-pending branch order of one submission this requester
 * raised. Approved, fulfilled, rejected and cancelled branch orders are kept
 * as they are and reported back; a branch no longer in the requester's
 * assignments is kept too.
 */
export function cancelPendingGroupSubmission(input: {
  groupOrderId: number
  reason: string
  actor: GroupCancelActor
}): Promise<SubmissionCancelOutcome> {
  return conflictToOutcome(() => db.transaction(async (tx): Promise<SubmissionCancelOutcome> => {
    const [envelope] = await tx
      .select({ id: groupOrders.id, reference: groupOrders.reference, groupId: groupOrders.groupId })
      .from(groupOrders)
      .where(and(
        eq(groupOrders.id, input.groupOrderId),
        eq(groupOrders.organizationId, input.actor.organizationId),
        eq(groupOrders.createdByUserId, input.actor.userId),
      ))
      .limit(1)
    if (!envelope) return { kind: "not-found" }

    // Locked in id order, so two overlapping requests cannot deadlock.
    const children = await tx
      .select(lockedOrderColumns)
      .from(orders)
      .where(and(eq(orders.groupOrderId, envelope.id), eq(orders.organizationId, input.actor.organizationId)))
      .orderBy(orders.id)
      .for("update")

    const branchIds = await resolveScopedBranchIds(tx, input.actor.userId)
    const now = new Date()
    const cancelled: CancelledBranchOrder[] = []
    const kept: KeptBranchOrder[] = []
    for (const child of children) {
      const cancellable = groupOrderCancelRefusal(child) === null
        && (await isInScope(tx, input.actor, branchIds, child))
      if (!cancellable) {
        kept.push({ orderId: child.id, tid: child.tid, status: child.status })
        continue
      }
      cancelled.push(await cancelLockedOrder(tx, {
        order: child,
        reason: input.reason,
        actor: input.actor,
        now,
        via: "SUBMISSION",
      }))
    }

    if (cancelled.length === 0) return { kind: "nothing-pending", kept }

    await tx.insert(groupAuditLogs).values({
      organizationId: input.actor.organizationId,
      groupId: envelope.groupId,
      action: "CANCEL_GROUP_ORDER",
      performedByUserId: input.actor.userId,
      performedByRole: input.actor.role,
      metadata: {
        groupOrderId: envelope.id,
        reference: envelope.reference,
        reason: input.reason,
        cancelledOrderIds: cancelled.map((order) => order.orderId),
        keptOrderIds: kept.map((order) => order.orderId),
      },
    })

    return { kind: "cancelled", reference: envelope.reference, cancelled, kept }
  }))
}
