import "server-only"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { branches, groupOrders, groups, orderItems, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { GROUP_ORDER_PORTAL_ROLE } from "@/lib/server/multi-branch-scope"
import { UNGROUPED_BUCKET_NAME } from "@/lib/server/group-order-portal"

/**
 * Read side of the Group Order Portal: the submissions a user made, each with
 * the live state of the branch orders beneath it.
 *
 * Every query is pinned to both the calling user and their organization. A
 * group order is only ever visible to the user who created it, which keeps this
 * endpoint from becoming a second, weaker route to order data that the main
 * `/api/v1/orders` scoping ladder already governs.
 */

export const HISTORY_PAGE_SIZE_DEFAULT = 10
export const HISTORY_PAGE_SIZE_MAX = 50

export type GroupOrderChild = {
  id: number
  tid: string
  branchId: number
  branchName: string
  status: string
  /**
   * The status the order held when it was refunded. The invoice stays available
   * after a refund of an already-approved order, so this is what tells the
   * requester's history whether to offer the invoice for a refunded row.
   */
  statusAtRefund: string | null
  fulfillmentStatus: string
  totalCents: number
  itemCount: number
  createdAt: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
  /** Set when the group requester withdrew it before approval. */
  cancelledAt: Date | null
  cancellationReason: string | null
  /** Set while an approver has sent this pending order back for correction. */
  returnedForCorrectionAt: Date | null
  correctionRequestNote: string | null
  /**
   * The credential a Super Admin needs to mark this order delivered. Present
   * only while `canViewFulfillmentToken` allows it for the requester who raised
   * the order — never for a pending, rejected, or another user's order.
   */
  approvalToken: string | null
}

export type GroupOrderHistoryItem = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
  poNumber: string | null
  groupId: number | null
  groupName: string
  requestedBranchCount: number
  createdOrderCount: number
  failures: Array<{ branchId: number; branchName: string; reason: string }>
  totalCents: number
  statusCounts: Record<string, number>
  orders: GroupOrderChild[]
}

export type GroupOrderHistoryPage = {
  items: GroupOrderHistoryItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

function countByStatus(children: GroupOrderChild[]): Record<string, number> {
  return children.reduce<Record<string, number>>((counts, child) => {
    const status = (child.status || "PENDING").toUpperCase()
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}

export async function listGroupOrders({
  userId,
  organizationId,
  page,
  limit,
}: {
  userId: string
  organizationId: number | null
  page: number
  limit: number
}): Promise<GroupOrderHistoryPage> {
  const emptyPage: GroupOrderHistoryPage = {
    items: [],
    pagination: { page, limit, total: 0, totalPages: 0, hasMore: false },
  }
  // Fail closed: without a tenant there is no scope to read within.
  if (!organizationId) return emptyPage

  const scope = and(
    eq(groupOrders.createdByUserId, userId),
    eq(groupOrders.organizationId, organizationId),
  )

  const [[countRow], envelopes] = await Promise.all([
    db.select({ total: sql<number>`COUNT(*)::int`.mapWith(Number) }).from(groupOrders).where(scope),
    db
      .select({
        id: groupOrders.id,
        reference: groupOrders.reference,
        createdAt: groupOrders.createdAt,
        notes: groupOrders.notes,
        poNumber: groupOrders.poNumber,
        groupId: groupOrders.groupId,
        groupName: groups.name,
        requestedBranchCount: groupOrders.requestedBranchCount,
        createdOrderCount: groupOrders.createdOrderCount,
        failures: groupOrders.failures,
      })
      .from(groupOrders)
      .leftJoin(groups, and(
        eq(groupOrders.groupId, groups.id),
        eq(groups.organizationId, groupOrders.organizationId),
      ))
      .where(scope)
      .orderBy(desc(groupOrders.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
  ])

  const total = Number(countRow?.total ?? 0)
  if (envelopes.length === 0) {
    return { items: [], pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: false } }
  }

  const childRows = await db
    .select({
      groupOrderId: orders.groupOrderId,
      id: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      status: orders.status,
      statusAtRefund: orders.statusAtRefund,
      fulfillmentStatus: orders.fulfillmentStatus,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      approvedAt: orders.approvedAt,
      rejectionReason: orders.rejectionReason,
      cancelledAt: orders.cancelledAt,
      cancellationReason: orders.cancellationReason,
      returnedForCorrectionAt: orders.returnedForCorrectionAt,
      correctionRequestNote: orders.correctionRequestNote,
      approvalToken: orders.approvalToken,
      createdByUserId: orders.createdByUserId,
      itemCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id}
      )`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      inArray(orders.groupOrderId, envelopes.map((envelope) => envelope.id)),
      // The envelope is already user-scoped; re-asserting the tenant here keeps
      // the join honest if a row were ever written with a mismatched pair.
      eq(orders.organizationId, organizationId),
      eq(orders.createdByUserId, userId),
    ))
    .orderBy(orders.branchId)

  const childrenByEnvelope = new Map<number, GroupOrderChild[]>()
  for (const row of childRows) {
    if (row.groupOrderId === null) continue
    const bucket = childrenByEnvelope.get(row.groupOrderId) ?? []
    bucket.push({
      id: row.id,
      tid: row.tid,
      branchId: row.branchId,
      branchName: row.branchName ?? `Branch ${row.branchId}`,
      status: row.status,
      statusAtRefund: row.statusAtRefund,
      fulfillmentStatus: row.fulfillmentStatus,
      totalCents: row.totalCents,
      itemCount: row.itemCount,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      rejectionReason: row.rejectionReason,
      cancelledAt: row.cancelledAt,
      cancellationReason: row.cancellationReason,
      returnedForCorrectionAt: row.returnedForCorrectionAt,
      correctionRequestNote: row.correctionRequestNote,
      // The query above already pins every row to this user and tenant; the
      // shared policy is still consulted so the token cannot leak from an order
      // that is not approved, and so this surface keeps moving in step with
      // every other one that shows a token.
      approvalToken: canViewFulfillmentToken({
        role: GROUP_ORDER_PORTAL_ROLE,
        userId,
        orderStatus: row.status,
        orderCreatedByUserId: row.createdByUserId,
      })
        ? row.approvalToken
        : null,
    })
    childrenByEnvelope.set(row.groupOrderId, bucket)
  }

  const items = envelopes.map((envelope): GroupOrderHistoryItem => {
    const children = childrenByEnvelope.get(envelope.id) ?? []
    return {
      id: envelope.id,
      reference: envelope.reference,
      createdAt: envelope.createdAt,
      notes: envelope.notes,
      poNumber: envelope.poNumber,
      groupId: envelope.groupId,
      groupName: envelope.groupName ?? UNGROUPED_BUCKET_NAME,
      requestedBranchCount: envelope.requestedBranchCount,
      createdOrderCount: envelope.createdOrderCount,
      failures: envelope.failures ?? [],
      totalCents: children.reduce((sum, child) => sum + (child.totalCents ?? 0), 0),
      statusCounts: countByStatus(children),
      orders: children,
    }
  })

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: page * limit < total,
    },
  }
}
