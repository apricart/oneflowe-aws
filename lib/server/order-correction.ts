import "server-only"

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm"
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core"

import { branches, orderCorrectionRequests, orders, roles, users } from "@/db/schema"
import type { RequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  ORDER_RESUBMITTED_ACTION,
  ORDER_RETURNED_FOR_CORRECTION_ACTION,
  normalizeCorrectionNote,
  orderCorrectionRefusalMessage,
  resubmissionRefusal,
  returnForCorrectionRefusal,
  type OrderCorrectionRefusal,
  type OrderCorrectionResolution,
} from "@/lib/order-correction"
import {
  canRequesterActOnOrder,
  describeOrderWrite,
  isOrderWriteRole,
} from "@/lib/order-write-access"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { authorizeOrderDecision } from "@/lib/server/order-decision-policy"
import {
  queueOrderResubmittedNotifications,
  queueOrderReturnedNotification,
} from "@/lib/server/order-notifications"
import { notifyRaiserOfOrderWrite } from "@/lib/server/order-write-audit"
import { resolveScopedBranchIds, usesMultiBranchScope } from "@/lib/server/multi-branch-scope"

/**
 * Returning a pending order for correction, and resubmitting it.
 * See plans/OF-ORDER-RETURN-for-correction.md and `lib/order-correction.ts`.
 *
 * Neither transition touches money or stock. A returned order is still
 * PENDING and keeps every reservation it took; the requester's edit (the
 * existing `PUT /api/v1/orders/{id}`) moves them by the difference as it always
 * has. These functions move only who the order is waiting on.
 *
 * Authorization is never the caller's: returning runs `authorizeOrderDecision`
 * — the approve/reject policy — inside the transaction; resubmitting re-reads
 * the actor and its branch set inside the transaction and applies the edit
 * rule from `lib/order-write-access.ts`, exactly as the edit does.
 */

type CorrectionActor = { id: string; email?: string | null; role: string }

type CorrectedOrder = { id: number; tid: string; status: string }

export type ReturnForCorrectionOutcome =
  | { kind: "returned"; order: CorrectedOrder & { returnedForCorrectionAt: Date }; eventKeys: string[] }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "invalid-state"; refusal: OrderCorrectionRefusal; status: string }
  | { kind: "conflict" }

export type ResubmissionOutcome =
  | { kind: "resubmitted"; order: CorrectedOrder; eventKeys: string[] }
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "invalid-state"; refusal: OrderCorrectionRefusal; status: string }
  | { kind: "conflict" }

/**
 * Close the order's open round, if it has one, and say which.
 *
 * Called by resubmission and by rejection — a returned order may still be
 * rejected outright — on the transaction that moved the order, after the
 * order row was claimed, so the order lock already serializes it.
 */
export async function closeOpenCorrectionRequest(tx: any, input: {
  orderId: number
  resolution: OrderCorrectionResolution
  userId: string
  role: string
  responseNote?: string | null
}): Promise<number | null> {
  const [closed] = await tx
    .update(orderCorrectionRequests)
    .set({
      resolution: input.resolution,
      resolvedAt: new Date(),
      resolvedByUserId: input.userId,
      resolvedByRole: input.role,
      responseNote: input.resolution === "RESUBMITTED" ? normalizeCorrectionNote(input.responseNote) : null,
    })
    .where(and(
      eq(orderCorrectionRequests.orderId, input.orderId),
      isNull(orderCorrectionRequests.resolution),
    ))
    .returning({ id: orderCorrectionRequests.id })
  return closed?.id ?? null
}

/**
 * An approver sends a pending order back to its requesters.
 *
 * Who may do this is exactly who may approve or reject it. The claim is
 * conditional on the order still being PENDING with no open request, so a
 * concurrent approval, rejection or second return cannot also succeed.
 */
export async function returnOrderForCorrection(input: {
  orderId: number
  scope: RequestScope
  user: CorrectionActor
  comment: string
}): Promise<ReturnForCorrectionOutcome> {
  return db.transaction(async (tx) => {
    const authorization = await authorizeOrderDecision(tx, { orderId: input.orderId, scope: input.scope })
    if (!authorization.ok) return { kind: authorization.reason }
    const ord = authorization.order

    const refusal = returnForCorrectionRefusal(ord)
    if (refusal) return { kind: "invalid-state", refusal, status: ord.status }

    const returnedAt = new Date()
    const [claimed] = await tx.update(orders).set({
      returnedForCorrectionAt: returnedAt,
      returnedForCorrectionByUserId: input.user.id,
      correctionRequestNote: input.comment,
      updatedAt: returnedAt,
    }).where(and(
      eq(orders.id, input.orderId),
      sql`UPPER(${orders.status}) = 'PENDING'`,
      isNull(orders.returnedForCorrectionAt),
    )).returning({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      createdByUserId: orders.createdByUserId,
    })
    if (!claimed) return { kind: "conflict" }

    const [request] = await tx.insert(orderCorrectionRequests).values({
      orderId: claimed.id,
      organizationId: claimed.organizationId!,
      branchId: claimed.branchId,
      requestedByUserId: input.user.id,
      requestedByRole: input.user.role,
      comment: input.comment,
      requestedAt: returnedAt,
    }).returning({ id: orderCorrectionRequests.id })

    const notifications = await queueOrderReturnedNotification(tx, {
      order: claimed,
      correctionRequestId: request.id,
      comment: input.comment,
      returnedByRole: authorization.decisionRole,
    })

    await recordAuditEvent(tx, {
      action: ORDER_RETURNED_FOR_CORRECTION_ACTION,
      entity: "order",
      entityId: claimed.id,
      actor: { id: input.user.id, role: input.user.role, email: input.user.email ?? null },
      organizationId: claimed.organizationId,
      branchId: claimed.branchId,
      before: { status: "PENDING", awaiting: "APPROVAL" },
      after: { status: "PENDING", awaiting: "CORRECTION" },
      context: {
        tid: claimed.tid,
        comment: input.comment,
        correctionRequestId: request.id,
        decisionRole: authorization.decisionRole,
        configuredApproverRole: authorization.configuredApproverRole,
        raiserNotified: notifications.recipientCount > 0,
      },
    })

    return {
      kind: "returned",
      order: { id: claimed.id, tid: claimed.tid, status: claimed.status, returnedForCorrectionAt: returnedAt },
      eventKeys: notifications.eventKeys,
    }
  })
}

function displayName(row: { fullName: string | null; firstName: string | null; lastName: string | null }): string | null {
  const full = row.fullName?.trim()
  if (full) return full
  const parts = [row.firstName, row.lastName].map((part) => part?.trim()).filter(Boolean).join(" ")
  return parts || null
}

/**
 * A requester sends a returned order back for approval.
 *
 * The order is located by id and the actor's tenant and locked; the actor and
 * its branch set are re-read on this transaction. Out of scope reads as "not
 * found", matching the edit and the read path, so the response cannot be used
 * to discover an order at another branch.
 */
export async function resubmitOrderForApproval(input: {
  orderId: number
  userId: string
  organizationId: number
  note?: string | null
}): Promise<ResubmissionOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [actor] = await tx.select({
        id: users.id,
        email: users.email,
        role: roles.name,
        organizationId: users.organizationId,
        branchId: users.branchId,
        fullName: users.fullName,
        firstName: users.firstName,
        lastName: users.lastName,
      }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(and(
        eq(users.id, input.userId),
        eq(users.isActive, true),
        isNull(users.deletedAt),
      )).limit(1)
      if (!actor || !isOrderWriteRole(actor.role) || actor.organizationId !== input.organizationId) {
        return { kind: "forbidden" } as const
      }

      const branchIds = usesMultiBranchScope(actor.role)
        ? await resolveScopedBranchIds(tx, actor.id)
        : (actor.branchId ? [actor.branchId] : [])
      if (branchIds.length === 0) return { kind: "forbidden" } as const

      const [order] = await tx.select({
        id: orders.id,
        tid: orders.tid,
        status: orders.status,
        organizationId: orders.organizationId,
        branchId: orders.branchId,
        createdByUserId: orders.createdByUserId,
        returnedForCorrectionAt: orders.returnedForCorrectionAt,
        returnedForCorrectionByUserId: orders.returnedForCorrectionByUserId,
      }).from(orders).where(and(
        eq(orders.id, input.orderId),
        eq(orders.organizationId, input.organizationId),
      )).for("update").limit(1)
      if (!order) return { kind: "not-found" } as const

      const [orderBranch] = await tx.select({ organizationId: branches.organizationId })
        .from(branches).where(eq(branches.id, order.branchId)).for("share").limit(1)

      const writeActor = {
        role: actor.role,
        userId: actor.id,
        organizationId: actor.organizationId,
        branchIds,
      }
      const subject = {
        status: order.status,
        createdByUserId: order.createdByUserId,
        organizationId: order.organizationId,
        branchId: order.branchId,
        branchOrganizationId: orderBranch?.organizationId,
      }
      if (!canRequesterActOnOrder(writeActor, subject)) return { kind: "not-found" } as const

      const refusal = resubmissionRefusal(order)
      if (refusal) return { kind: "invalid-state", refusal, status: order.status } as const

      const [claimed] = await tx.update(orders).set({
        returnedForCorrectionAt: null,
        returnedForCorrectionByUserId: null,
        correctionRequestNote: null,
        updatedAt: new Date(),
      }).where(and(
        eq(orders.id, order.id),
        eq(orders.organizationId, input.organizationId),
        eq(orders.branchId, order.branchId),
        sql`UPPER(${orders.status}) = 'PENDING'`,
        isNotNull(orders.returnedForCorrectionAt),
      )).returning({ id: orders.id })
      if (!claimed) throw new Error("ORDER_CORRECTION_CONFLICT")

      const note = normalizeCorrectionNote(input.note)
      const correctionRequestId = await closeOpenCorrectionRequest(tx, {
        orderId: order.id,
        resolution: "RESUBMITTED",
        userId: actor.id,
        role: actor.role,
        responseNote: note,
      })
      // The flag and the open round are written together; one without the
      // other means the state is not what this transition assumes.
      if (correctionRequestId === null) throw new Error("ORDER_CORRECTION_CONFLICT")

      const write = describeOrderWrite(writeActor, subject)
      await recordAuditEvent(tx, {
        action: ORDER_RESUBMITTED_ACTION,
        entity: "order",
        entityId: order.id,
        actor: { id: actor.id, role: actor.role, email: actor.email },
        organizationId: order.organizationId,
        branchId: order.branchId,
        before: { status: "PENDING", awaiting: "CORRECTION" },
        after: { status: "PENDING", awaiting: "APPROVAL" },
        context: {
          tid: order.tid,
          note,
          correctionRequestId,
          onBehalfOfUserId: write.onBehalfOfUserId,
          crossRequesterWrite: write.isCrossRequesterWrite,
        },
      })
      await notifyRaiserOfOrderWrite(tx, {
        write,
        organizationId: input.organizationId,
        branchId: order.branchId,
        orderId: order.id,
        tid: order.tid,
        message: `Order ${order.tid} was resubmitted for approval by a colleague at your branch.`,
        type: "ORDER_RESUBMITTED_BY_COLLEAGUE",
        occurrence: correctionRequestId,
      })

      const notifications = await queueOrderResubmittedNotifications(tx, {
        order: {
          id: order.id,
          tid: order.tid,
          organizationId: order.organizationId,
          branchId: order.branchId,
          createdByUserId: order.createdByUserId,
        },
        correctionRequestId,
        returnedByUserId: order.returnedForCorrectionByUserId!,
        resubmittedBy: displayName(actor) ?? "A requester",
        note,
      })

      return {
        kind: "resubmitted",
        order: { id: order.id, tid: order.tid, status: order.status },
        eventKeys: notifications.eventKeys,
      } as const
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "ORDER_CORRECTION_CONFLICT") return { kind: "conflict" }
    throw error
  }
}

/** The user-facing message for every unsuccessful outcome of either transition. */
export function orderCorrectionErrorResponse(
  outcome: ReturnForCorrectionOutcome | ResubmissionOutcome,
): { message: string; status: number } | null {
  switch (outcome.kind) {
    case "not-found":
      return { message: "Order not found", status: 404 }
    case "forbidden":
      return { message: "Forbidden", status: 403 }
    case "invalid-state":
      return { message: orderCorrectionRefusalMessage(outcome.refusal, outcome.status), status: 409 }
    case "conflict":
      return { message: "Order was already approved, rejected, returned or otherwise changed", status: 409 }
    default:
      return null
  }
}

export type OrderCorrectionHistoryEntry = {
  id: number
  comment: string
  requestedAt: Date
  requestedByName: string | null
  requestedByRole: string
  resolution: OrderCorrectionResolution | null
  resolvedAt: Date | null
  resolvedByName: string | null
  resolvedByRole: string | null
  responseNote: string | null
}

/**
 * Every round of one order, oldest first, for the order detail.
 *
 * The caller has already authorized the read of this order; the tenant is
 * re-asserted here anyway so this can never be pointed at another tenant's
 * order by id alone. Names only — no email or phone — because the requester
 * and the approver both read it.
 */
export async function loadOrderCorrectionHistory(input: {
  orderId: number
  organizationId: number
}): Promise<OrderCorrectionHistoryEntry[]> {
  const requester = alias(users, "correction_requester")
  const resolver = alias(users, "correction_resolver")
  const nameOf = (person: { fullName: AnyPgColumn; firstName: AnyPgColumn; lastName: AnyPgColumn }) => sql<string | null>`COALESCE(
    NULLIF(TRIM(${person.fullName}), ''),
    NULLIF(TRIM(CONCAT_WS(' ', ${person.firstName}, ${person.lastName})), '')
  )`

  const rows = await db
    .select({
      id: orderCorrectionRequests.id,
      comment: orderCorrectionRequests.comment,
      requestedAt: orderCorrectionRequests.requestedAt,
      requestedByName: nameOf(requester),
      requestedByRole: orderCorrectionRequests.requestedByRole,
      resolution: orderCorrectionRequests.resolution,
      resolvedAt: orderCorrectionRequests.resolvedAt,
      resolvedByName: nameOf(resolver),
      resolvedByRole: orderCorrectionRequests.resolvedByRole,
      responseNote: orderCorrectionRequests.responseNote,
    })
    .from(orderCorrectionRequests)
    .leftJoin(requester, eq(orderCorrectionRequests.requestedByUserId, requester.id))
    .leftJoin(resolver, eq(orderCorrectionRequests.resolvedByUserId, resolver.id))
    .where(and(
      eq(orderCorrectionRequests.orderId, input.orderId),
      eq(orderCorrectionRequests.organizationId, input.organizationId),
    ))
    .orderBy(asc(orderCorrectionRequests.requestedAt), asc(orderCorrectionRequests.id))
    // A bound on a list that grows with use; far beyond any real order.
    .limit(100)

  return rows.map((row) => ({
    ...row,
    resolution: row.resolution as OrderCorrectionResolution | null,
  }))
}
