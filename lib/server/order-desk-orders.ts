import "server-only"

import { and, count, desc, eq, gte, ilike, inArray, isNotNull, or, sql, sum, type SQL } from "drizzle-orm"

import { branches, budgets, globalProducts, orderItems, orders, organizations, refunds, users } from "@/db/schema"
import { db } from "@/lib/db"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { isOrderDelivered, normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { deskOrderActions, type DeskOrderActions, type IntakeChannel } from "@/lib/order-desk-access"
import {
  ORDER_RESUBMITTED_ACTION,
  normalizeCorrectionNote,
  resubmissionRefusal,
  type OrderCorrectionRefusal,
} from "@/lib/order-correction"
import { deskOrderStatusSelection, type DeskOrderCounts, type DeskOrderListQuery } from "@/lib/order-desk-query"
import { escapeLikePattern } from "@/lib/utils"
import { orderSelectColumns } from "@/lib/order-select"
import { orderTakesBudget } from "@/lib/organization-budget-policy"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { closeOpenCorrectionRequest } from "@/lib/server/order-correction"
import { loadOrderDeskReach, orderDeskOrderCondition } from "@/lib/server/order-desk-scope"
import { fulfillApprovedOrder, type OrderFulfillmentOutcome } from "@/lib/server/order-fulfillment"
import { releaseHeldQuantityBudgetForOrder } from "@/lib/server/product-quantity-budget-ledger"

/**
 * The Order Desk's own orders: listing, cancelling, resubmitting and
 * fulfilling them.
 *
 * Every function here starts from the desk user's live reach
 * (`loadOrderDeskReach`, purpose `manage`) and reads the order **through**
 * `orderDeskOrderCondition`, so an order the desk did not enter — or one at a
 * branch it no longer reaches — is simply not found.
 *
 * Approval is not the desk's: every desk order starts `PENDING` and an Apricart
 * Executive assigned to its organization approves, rejects or returns it
 * (`lib/order-desk-approval.ts`). While it is pending the desk may edit it
 * (`lib/server/order-desk-edit.ts`) and, once returned, resubmit it (here).
 * Delivery is not the desk's to record either: Super Admin moves it through
 * the existing progress route. The desk fulfils once that delivery is
 * recorded, through `fulfillApprovedOrder`, which refuses an undelivered order
 * in its own claim. Until delivery the desk may cancel (here); after
 * fulfilment it may request a refund through the shared refund route, which
 * Super Admin approves.
 */

export type DeskOrderSummary = DeskOrderActions & {
  id: number
  tid: string
  status: string
  /** Set while an executive has it back with the desk for correction. */
  returnedForCorrectionAt: Date | null
  correctionRequestNote: string | null
  rejectionReason: string | null
  fulfillmentStatus: FulfillmentStatus
  organizationId: number | null
  organizationName: string | null
  branchId: number
  branchName: string | null
  totalCents: number
  refundedCents: number
  pendingRefundCents: number
  poNumber: string | null
  notes: string | null
  intakeChannel: IntakeChannel | null
  intakeReference: string | null
  hasAttachment: boolean
  enteredBy: string | null
  createdAt: Date | null
  deliveredAt: Date | null
  fulfilledAt: Date | null
  cancelledAt: Date | null
  cancellationReason: string | null
  items: { id: number; organizationInventoryId: number | null; productName: string; quantity: number; unit: string | null; priceCents: number }[]
}

export type DeskOrderPage = {
  items: DeskOrderSummary[]
  /** Every tab's size under the same reach, organization, branch and search. */
  counts: DeskOrderCounts
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

const DELIVERED_SQL = sql`COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED') = 'DELIVERED'`
const ORDER_STATUS_SQL = sql`UPPER(${orders.status})`

function tabCondition(filter: DeskOrderListQuery["status"]): SQL | undefined {
  const selection = deskOrderStatusSelection(filter)
  const parts: SQL[] = []
  if (selection.statuses) parts.push(inArray(ORDER_STATUS_SQL, selection.statuses))
  if (selection.delivered === true) parts.push(DELIVERED_SQL)
  if (selection.delivered === false) parts.push(sql`NOT (${DELIVERED_SQL})`)
  return parts.length > 0 ? and(...parts) : undefined
}

/** `count(*) FILTER (WHERE …)` for one tab, so every tab is counted in one read. */
function tabCount(filter: DeskOrderListQuery["status"]) {
  const condition = tabCondition(filter)
  return condition
    ? sql<number>`COUNT(*) FILTER (WHERE ${condition})`.mapWith(Number)
    : sql<number>`COUNT(*)`.mapWith(Number)
}

export async function listDeskOrders(userId: string, query: DeskOrderListQuery): Promise<DeskOrderPage> {
  const reach = await loadOrderDeskReach(db, userId, "manage")
  const conditions: SQL[] = [orderDeskOrderCondition(reach)]
  // Filters only narrow what the reach above already allows.
  if (query.organizationId !== null) conditions.push(eq(orders.organizationId, query.organizationId))
  if (query.branchId !== null) conditions.push(eq(orders.branchId, query.branchId))
  if (query.search) {
    // A parameter, with the LIKE wildcards in what was typed escaped.
    const pattern = `%${escapeLikePattern(query.search)}%`
    conditions.push(or(ilike(orders.tid, pattern), ilike(orders.intakeReference, pattern)) as SQL)
  }
  const scopeWhere = and(...conditions)
  const tab = tabCondition(query.status)
  const where = tab ? and(scopeWhere, tab) : scopeWhere

  const [[{ total }], [counts]] = await Promise.all([
    db.select({ total: count() }).from(orders).where(where),
    db
      .select({
        awaiting_approval: tabCount("awaiting_approval"),
        awaiting_delivery: tabCount("awaiting_delivery"),
        ready_to_fulfil: tabCount("ready_to_fulfil"),
        fulfilled: tabCount("fulfilled"),
        rejected: tabCount("rejected"),
        cancelled: tabCount("cancelled"),
        all: tabCount("all"),
      })
      .from(orders)
      .where(scopeWhere),
  ])

  const rows = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      returnedForCorrectionAt: orders.returnedForCorrectionAt,
      correctionRequestNote: orders.correctionRequestNote,
      rejectionReason: orders.rejectionReason,
      fulfillmentStatus: orders.fulfillmentStatus,
      organizationId: orders.organizationId,
      organizationName: organizations.name,
      branchId: orders.branchId,
      branchName: branches.name,
      totalCents: orders.totalCents,
      refundedCents: orders.refundAmountCents,
      poNumber: orders.poNumber,
      notes: orders.notes,
      intakeChannel: orders.intakeChannel,
      intakeReference: orders.intakeReference,
      intakeAttachmentKey: orders.intakeAttachmentKey,
      enteredBy: users.fullName,
      createdAt: orders.createdAt,
      deliveredAt: orders.deliveredAt,
      fulfilledAt: orders.fulfilledAt,
      cancelledAt: orders.cancelledAt,
      cancellationReason: orders.cancellationReason,
    })
    .from(orders)
    .leftJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branches, eq(branches.id, orders.branchId))
    .leftJoin(users, eq(users.id, orders.createdByUserId))
    .where(where)
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)

  const orderIds = rows.map((row) => row.id)
  const [lineRows, pendingRows] = orderIds.length === 0
    ? [[], []]
    : await Promise.all([
      db
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          organizationInventoryId: orderItems.organizationInventoryId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unit: orderItems.unit,
          priceCents: orderItems.priceCents,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, orderIds)),
      db
        .select({ orderId: refunds.orderId, amount: sum(refunds.amountCents) })
        .from(refunds)
        .where(and(inArray(refunds.orderId, orderIds), eq(refunds.status, "PENDING")))
        .groupBy(refunds.orderId),
    ])
  const pendingByOrder = new Map(pendingRows.map((row) => [row.orderId, Number(row.amount ?? 0)]))

  return {
    counts,
    items: rows.map(({ intakeAttachmentKey, ...row }) => ({
      ...row,
      ...deskOrderActions(row),
      fulfillmentStatus: normalizeFulfillmentStatus(row.fulfillmentStatus),
      totalCents: Number(row.totalCents),
      refundedCents: Number(row.refundedCents ?? 0),
      pendingRefundCents: pendingByOrder.get(row.id) ?? 0,
      intakeChannel: row.intakeChannel as IntakeChannel | null,
      // The key itself never leaves the server; the screenshot is fetched by
      // order id through the desk's attachment route.
      hasAttachment: intakeAttachmentKey !== null,
      items: lineRows
        .filter((line) => line.orderId === row.id)
        .map(({ orderId: _orderId, quantity, priceCents, ...line }) => ({
          ...line,
          quantity: Number(quantity),
          priceCents: Number(priceCents),
        })),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / query.limit),
    },
  }
}

type DeskClient = Parameters<typeof loadOrderDeskReach>[0]

/** One desk order the user reaches, or null. Read through the reach, never around it. */
export async function loadDeskOrder(client: DeskClient, userId: string, orderId: number) {
  const reach = await loadOrderDeskReach(client, userId, "manage")
  const [order] = await client
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      intakeAttachmentKey: orders.intakeAttachmentKey,
    })
    .from(orders)
    .where(and(eq(orders.id, orderId), orderDeskOrderCondition(reach)))
    .limit(1)
  return order ?? null
}

export type DeskFulfilOutcome =
  | { kind: "fulfilled" }
  | { kind: "not-found" }
  | { kind: "not-active"; status: string }
  | { kind: "not-delivered" }
  | { kind: Exclude<OrderFulfillmentOutcome, "fulfilled"> }

/**
 * Settle a delivered desk order to `FULFILLED`. The desk acts on its own
 * entries without a fulfilment token: the token exists so a customer's staff
 * can confirm receipt, and these customers have no staff accounts yet. The
 * named desk user is recorded as the one who fulfilled it.
 */
export async function fulfilDeskOrder(input: {
  orderId: number
  actor: AuditActor & { id: string }
}): Promise<DeskFulfilOutcome> {
  const order = await loadDeskOrder(db, input.actor.id, input.orderId)
  if (!order) return { kind: "not-found" }
  if (String(order.status).toUpperCase() !== "APPROVED") return { kind: "not-active", status: order.status }
  if (!isOrderDelivered(order.fulfillmentStatus)) return { kind: "not-delivered" }

  // The claim inside re-asserts APPROVED and DELIVERED for this tenant and
  // branch, so a concurrent fulfilment or a race past the checks above loses.
  const outcome = await fulfillApprovedOrder({
    orderId: order.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
    fulfilledByUserId: input.actor.id,
  })
  return { kind: outcome }
}

/** A desk user acting on an order; the role is recorded on any correction round it closes. */
type DeskActor = AuditActor & { id: string; role: string }

/** What the desk may cancel: pending, or Active and not yet delivered. */
const CANCELLABLE_STATUSES = ["PENDING", "APPROVED"]

export type DeskCancelOutcome =
  | { kind: "cancelled" }
  | { kind: "not-found" }
  | { kind: "not-active"; status: string }
  | { kind: "delivered" }
  | { kind: "conflict" }

/**
 * Withdraw a desk order before it is delivered — pending, or Active and not
 * yet delivered: status `CANCELLED`, the budget hold and the quantity hold it
 * took released from the order's own period, and its stock put back — all in
 * one transaction, under a lock on the order. A pending order took the same
 * holds and stock at creation as an Active one, so the release is the same.
 * An order returned for correction has its open round closed `CANCELLED`, and
 * the correction flag cleared with it (the row check allows it only on
 * `PENDING`).
 *
 * The release follows the rejection path's rules exactly
 * (`lib/server/order-decision-service.ts`): only an order that took a hold
 * releases one (`orderTakesBudget`), from the row its period names
 * (`budgetPeriodOf`), never driving the hold below zero.
 */
export async function cancelDeskOrder(input: {
  orderId: number
  reason: string
  actor: DeskActor
}): Promise<DeskCancelOutcome> {
  try {
    return await cancelInTransaction(input)
  } catch (error) {
    if (error instanceof Error && error.message === "ORDER_TRANSITION_CONFLICT") return { kind: "conflict" }
    throw error
  }
}

function cancelInTransaction(input: {
  orderId: number
  reason: string
  actor: DeskActor
}): Promise<DeskCancelOutcome> {
  return db.transaction(async (tx): Promise<DeskCancelOutcome> => {
    const reach = await loadOrderDeskReach(tx, input.actor.id, "manage")
    const [current] = await tx
      .select({ id: orders.id, status: orders.status, fulfillmentStatus: orderSelectColumns.fulfillmentStatus })
      .from(orders)
      .where(and(eq(orders.id, input.orderId), orderDeskOrderCondition(reach)))
      .for("update")
      .limit(1)
    if (!current) return { kind: "not-found" }
    const previousStatus = String(current.status).toUpperCase()
    if (!CANCELLABLE_STATUSES.includes(previousStatus)) return { kind: "not-active", status: current.status }
    if (isOrderDelivered(current.fulfillmentStatus)) return { kind: "delivered" }

    const now = new Date()
    const [cancelled] = await tx
      .update(orders)
      .set({
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: input.actor.id,
        cancellationReason: input.reason,
        returnedForCorrectionAt: null,
        returnedForCorrectionByUserId: null,
        correctionRequestNote: null,
        updatedAt: now,
      })
      .where(and(
        eq(orders.id, current.id),
        sql`UPPER(${orders.status}) = ${previousStatus}`,
        sql`COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED') <> 'DELIVERED'`,
      ))
      .returning(orderSelectColumns)
    if (!cancelled) throw new Error("ORDER_TRANSITION_CONFLICT")

    const closedCorrectionRequestId = await closeOpenCorrectionRequest(tx, {
      orderId: cancelled.id,
      resolution: "CANCELLED",
      userId: input.actor.id,
      role: input.actor.role,
    })

    if (orderTakesBudget(cancelled)) {
      const [budget] = await tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(and(eq(budgets.branchId, cancelled.branchId), eq(budgets.period, budgetPeriodOf(cancelled.createdAt))))
        .limit(1)
      if (budget) {
        const [released] = await tx
          .update(budgets)
          .set({ amountHeldCents: sql`${budgets.amountHeldCents} - ${cancelled.totalCents}`, updatedAt: now })
          .where(and(eq(budgets.id, budget.id), gte(budgets.amountHeldCents, cancelled.totalCents)))
          .returning({ id: budgets.id })
        if (!released) throw new Error("BUDGET_LEDGER_INVARIANT")
      }
      await releaseHeldQuantityBudgetForOrder(tx, cancelled)
    }

    const items = await tx
      .select({ globalProductId: orderItems.globalProductId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, cancelled.id))
    for (const item of items) {
      await tx
        .update(globalProducts)
        .set({ stockQuantity: sql`${globalProducts.stockQuantity} + ${item.quantity}`, updatedAt: now })
        .where(eq(globalProducts.id, item.globalProductId))
    }

    await recordAuditEvent(tx, {
      action: "ORDER_CANCELLED",
      entity: "order",
      entityId: cancelled.id,
      actor: input.actor,
      organizationId: cancelled.organizationId,
      branchId: cancelled.branchId,
      before: { status: previousStatus },
      after: { status: "CANCELLED" },
      context: {
        tid: cancelled.tid,
        reason: input.reason,
        totalCents: cancelled.totalCents,
        via: "ORDER_DESK",
        closedCorrectionRequestId,
      },
    })
    return { kind: "cancelled" }
  })
}

export type DeskResubmitOutcome =
  | { kind: "resubmitted" }
  | { kind: "not-found" }
  | { kind: "invalid-state"; refusal: OrderCorrectionRefusal; status: string }
  | { kind: "conflict" }

/**
 * Send a returned desk order back to the executives for approval, optionally
 * with a note. The desk's counterpart of `resubmitOrderForApproval`, which
 * refuses desk orders: the order is read through the desk's reach and locked,
 * the claim is conditional on it still being returned, and the round is closed
 * `RESUBMITTED` on the same transaction.
 *
 * Unlike the requester path it queues no notification: that one tells the
 * tenant's approvers, who do not decide a desk order.
 */
export async function resubmitDeskOrder(input: {
  orderId: number
  note?: string | null
  actor: DeskActor
}): Promise<DeskResubmitOutcome> {
  try {
    return await db.transaction(async (tx): Promise<DeskResubmitOutcome> => {
      const reach = await loadOrderDeskReach(tx, input.actor.id, "manage")
      const [order] = await tx
        .select({
          id: orders.id,
          tid: orders.tid,
          status: orders.status,
          organizationId: orders.organizationId,
          branchId: orders.branchId,
          returnedForCorrectionAt: orders.returnedForCorrectionAt,
        })
        .from(orders)
        .where(and(eq(orders.id, input.orderId), orderDeskOrderCondition(reach)))
        .for("update")
        .limit(1)
      if (!order) return { kind: "not-found" }

      const refusal = resubmissionRefusal(order)
      if (refusal) return { kind: "invalid-state", refusal, status: order.status }

      const [claimed] = await tx
        .update(orders)
        .set({
          returnedForCorrectionAt: null,
          returnedForCorrectionByUserId: null,
          correctionRequestNote: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(orders.id, order.id),
          sql`UPPER(${orders.status}) = 'PENDING'`,
          isNotNull(orders.returnedForCorrectionAt),
        ))
        .returning({ id: orders.id })
      if (!claimed) throw new Error("ORDER_TRANSITION_CONFLICT")

      const note = normalizeCorrectionNote(input.note)
      const correctionRequestId = await closeOpenCorrectionRequest(tx, {
        orderId: order.id,
        resolution: "RESUBMITTED",
        userId: input.actor.id,
        role: input.actor.role,
        responseNote: note,
      })
      // The flag and the open round are written together; one without the
      // other means the state is not what this transition assumes.
      if (correctionRequestId === null) throw new Error("ORDER_TRANSITION_CONFLICT")

      await recordAuditEvent(tx, {
        action: ORDER_RESUBMITTED_ACTION,
        entity: "order",
        entityId: order.id,
        actor: input.actor,
        organizationId: order.organizationId,
        branchId: order.branchId,
        before: { status: "PENDING", awaiting: "CORRECTION" },
        after: { status: "PENDING", awaiting: "APPROVAL" },
        context: { tid: order.tid, note, correctionRequestId, via: "ORDER_DESK" },
      })
      return { kind: "resubmitted" }
    })
  } catch (error) {
    if (error instanceof Error && error.message === "ORDER_TRANSITION_CONFLICT") return { kind: "conflict" }
    throw error
  }
}
