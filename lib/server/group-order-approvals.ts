import "server-only"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { branches, groupOrders, groups, orderItems, orders, users } from "@/db/schema"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { db } from "@/lib/db"
import { GROUP_USER_ROLE } from "@/lib/server/multi-branch-scope"
import { UNGROUPED_BUCKET_NAME } from "@/lib/server/group-order-portal"

/**
 * Read side of the Group User approval queue.
 *
 * `group-order-history` answers "which group orders did I submit"; this module
 * answers "which group orders am I responsible for deciding". The two are
 * deliberately separate: the history is keyed by creator, this one is keyed by
 * the approver's branch scope, and neither can be used to reach the other's
 * rows.
 *
 * Every query is pinned to the caller's organization *and* to an explicit list
 * of scoped branch ids resolved by `multi-branch-scope`. An empty branch scope
 * yields an empty page and is never widened into "the whole tenant" — the
 * callers below return early rather than issuing an unfiltered query.
 */

export const APPROVAL_PAGE_SIZE_DEFAULT = 10
export const APPROVAL_PAGE_SIZE_MAX = 50

export type ApprovalFilter = "pending" | "all"

export type ApprovalOrder = {
  id: number
  tid: string
  branchId: number
  branchName: string
  branchCostCenterId: string | null
  status: string
  fulfillmentStatus: string
  totalCents: number
  itemCount: number
  createdAt: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
  /** Present only for orders this approver may still see a token for. */
  approvalToken: string | null
}

export type ApprovalGroupOrder = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedByName: string
  /** Counted across this approver's branches only, not the whole submission. */
  scopedOrderCount: number
  pendingOrderCount: number
  totalCents: number
  statusCounts: Record<string, number>
  orders: ApprovalOrder[]
}

export type ApprovalQueuePage = {
  items: ApprovalGroupOrder[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

export type ApprovalQueueSummary = {
  pendingOrders: number
  approvedOrders: number
  rejectedOrders: number
  pendingGroupOrders: number
  branchesInScope: number
}

const emptyPage = (page: number, limit: number): ApprovalQueuePage => ({
  items: [],
  pagination: { page, limit, total: 0, totalPages: 0, hasMore: false },
})

function countByStatus(children: ApprovalOrder[]): Record<string, number> {
  return children.reduce<Record<string, number>>((counts, child) => {
    const status = (child.status || "PENDING").toUpperCase()
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}

function displayName(row: { firstName: string | null; lastName: string | null; email: string | null }): string {
  const full = [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
  return full || row.email || "Unknown user"
}

/**
 * The scope every query in this module is built on. Returning a discriminated
 * "empty" rather than an optional filter makes it impossible for a caller to
 * accidentally run one of these queries without a branch restriction.
 */
type ResolvedApproverScope =
  | { usable: false }
  | { usable: true; organizationId: number; branchIds: number[] }

export function approverScope(
  organizationId: number | null,
  scopedBranchIds: number[],
): ResolvedApproverScope {
  if (!organizationId || scopedBranchIds.length === 0) return { usable: false }
  return { usable: true, organizationId, branchIds: scopedBranchIds }
}

/** Headline counts across every branch this approver covers. */
export async function getApprovalQueueSummary(
  organizationId: number | null,
  scopedBranchIds: number[],
): Promise<ApprovalQueueSummary> {
  const scope = approverScope(organizationId, scopedBranchIds)
  if (!scope.usable) {
    return {
      pendingOrders: 0,
      approvedOrders: 0,
      rejectedOrders: 0,
      pendingGroupOrders: 0,
      branchesInScope: 0,
    }
  }

  const inScope = and(
    eq(orders.organizationId, scope.organizationId),
    inArray(orders.branchId, scope.branchIds),
  )

  const [[counts], [pendingGroups]] = await Promise.all([
    db
      .select({
        pending: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'PENDING')::int`.mapWith(Number),
        approved: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'APPROVED')::int`.mapWith(Number),
        rejected: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'REJECTED')::int`.mapWith(Number),
      })
      .from(orders)
      .where(inScope),
    db
      .select({
        total: sql<number>`COUNT(DISTINCT ${orders.groupOrderId})::int`.mapWith(Number),
      })
      .from(orders)
      .where(and(
        inScope,
        sql`${orders.groupOrderId} IS NOT NULL`,
        sql`UPPER(${orders.status}) = 'PENDING'`,
      )),
  ])

  return {
    pendingOrders: Number(counts?.pending ?? 0),
    approvedOrders: Number(counts?.approved ?? 0),
    rejectedOrders: Number(counts?.rejected ?? 0),
    pendingGroupOrders: Number(pendingGroups?.total ?? 0),
    branchesInScope: scope.branchIds.length,
  }
}

/**
 * Group orders that placed at least one order in this approver's branches,
 * newest first. Each envelope carries only the child orders inside the
 * approver's scope — a submission spanning branches they do not cover is shown
 * as the part they are responsible for, never in full.
 */
export async function listApprovalQueue({
  organizationId,
  scopedBranchIds,
  page,
  limit,
  filter,
}: {
  organizationId: number | null
  scopedBranchIds: number[]
  page: number
  limit: number
  filter: ApprovalFilter
}): Promise<ApprovalQueuePage> {
  const scope = approverScope(organizationId, scopedBranchIds)
  if (!scope.usable) return emptyPage(page, limit)

  // The set of envelopes is derived from the orders the approver may act on, so
  // an envelope is reachable only through a child order already inside scope.
  const childScope = and(
    eq(orders.organizationId, scope.organizationId),
    inArray(orders.branchId, scope.branchIds),
    sql`${orders.groupOrderId} IS NOT NULL`,
  )
  const envelopeScope = filter === "pending"
    ? and(childScope, sql`UPPER(${orders.status}) = 'PENDING'`)
    : childScope

  const matchingEnvelopeIds = db
    .selectDistinct({ id: orders.groupOrderId })
    .from(orders)
    .where(envelopeScope)

  const [[countRow], envelopes] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(*)::int`.mapWith(Number) })
      .from(groupOrders)
      .where(and(
        eq(groupOrders.organizationId, scope.organizationId),
        inArray(groupOrders.id, matchingEnvelopeIds),
      )),
    db
      .select({
        id: groupOrders.id,
        reference: groupOrders.reference,
        createdAt: groupOrders.createdAt,
        notes: groupOrders.notes,
        groupId: groupOrders.groupId,
        groupName: groups.name,
        requesterFirstName: users.firstName,
        requesterLastName: users.lastName,
        requesterEmail: users.email,
      })
      .from(groupOrders)
      .leftJoin(groups, and(
        eq(groupOrders.groupId, groups.id),
        eq(groups.organizationId, groupOrders.organizationId),
      ))
      .leftJoin(users, eq(groupOrders.createdByUserId, users.id))
      .where(and(
        eq(groupOrders.organizationId, scope.organizationId),
        inArray(groupOrders.id, matchingEnvelopeIds),
      ))
      .orderBy(desc(groupOrders.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
  ])

  const total = Number(countRow?.total ?? 0)
  const totalPages = Math.ceil(total / limit)
  if (envelopes.length === 0) {
    return { items: [], pagination: { page, limit, total, totalPages, hasMore: false } }
  }

  const childRows = await db
    .select({
      groupOrderId: orders.groupOrderId,
      id: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      branchCostCenterId: branches.costCenterId,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      approvedAt: orders.approvedAt,
      rejectionReason: orders.rejectionReason,
      approvalToken: orders.approvalToken,
      itemCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id}
      )`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    // Re-asserts the full scope on the child read: an envelope being visible
    // never implies its other branches are.
    .where(and(
      inArray(orders.groupOrderId, envelopes.map((envelope) => envelope.id)),
      eq(orders.organizationId, scope.organizationId),
      inArray(orders.branchId, scope.branchIds),
    ))
    .orderBy(orders.branchId)

  const childrenByEnvelope = new Map<number, ApprovalOrder[]>()
  for (const row of childRows) {
    if (row.groupOrderId === null) continue
    const bucket = childrenByEnvelope.get(row.groupOrderId) ?? []
    bucket.push({
      id: row.id,
      tid: row.tid,
      branchId: row.branchId,
      branchName: row.branchName ?? `Branch ${row.branchId}`,
      branchCostCenterId: row.branchCostCenterId ?? null,
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      totalCents: row.totalCents,
      itemCount: row.itemCount,
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      rejectionReason: row.rejectionReason,
      // The token is the credential a Super Admin needs to mark the order
      // delivered. The branch scope is already enforced by the query above;
      // whether the token may be shown at all is deferred to the one shared
      // policy, so this read can never drift from the other surfaces.
      approvalToken: canViewFulfillmentToken({
        role: GROUP_USER_ROLE,
        orderStatus: row.status,
      })
        ? row.approvalToken
        : null,
    })
    childrenByEnvelope.set(row.groupOrderId, bucket)
  }

  const items = envelopes.map((envelope): ApprovalGroupOrder => {
    const children = childrenByEnvelope.get(envelope.id) ?? []
    return {
      id: envelope.id,
      reference: envelope.reference,
      createdAt: envelope.createdAt,
      notes: envelope.notes,
      groupId: envelope.groupId,
      groupName: envelope.groupName ?? UNGROUPED_BUCKET_NAME,
      requestedByName: displayName({
        firstName: envelope.requesterFirstName,
        lastName: envelope.requesterLastName,
        email: envelope.requesterEmail,
      }),
      scopedOrderCount: children.length,
      pendingOrderCount: children.filter(
        (child) => String(child.status || "").toUpperCase() === "PENDING",
      ).length,
      totalCents: children.reduce((sum, child) => sum + (child.totalCents ?? 0), 0),
      statusCounts: countByStatus(children),
      orders: children,
    }
  })

  return {
    items,
    pagination: { page, limit, total, totalPages, hasMore: page * limit < total },
  }
}
