import "server-only"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { branches, groupOrders, groups, orderItems, orders } from "@/db/schema"
import { db } from "@/lib/db"
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
  fulfillmentStatus: string
  totalCents: number
  itemCount: number
  createdAt: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
}

export type GroupOrderHistoryItem = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
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
      fulfillmentStatus: orders.fulfillmentStatus,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      approvedAt: orders.approvedAt,
      rejectionReason: orders.rejectionReason,
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
      fulfillmentStatus: row.fulfillmentStatus,
      totalCents: row.totalCents,
      itemCount: row.itemCount,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      rejectionReason: row.rejectionReason,
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
