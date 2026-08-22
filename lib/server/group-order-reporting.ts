import "server-only"

import { and, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm"

import { branches, groupOrders, groups, orderItems, orders, users } from "@/db/schema"
import { db } from "@/lib/db"
import { roundQuantity } from "@/lib/quantity"
import { escapeLikePattern } from "@/lib/utils"
import { approverScope } from "@/lib/server/group-order-approvals"
import {
  GROUP_ORDER_REFERENCE_MAX_LENGTH,
  type GroupOrderReportStatus,
} from "@/lib/server/group-order-report-filters"
import { UNGROUPED_BUCKET_NAME } from "@/lib/server/group-order-portal"

/**
 * Read side of the Group User's group order report.
 *
 * `group-order-approvals` answers "which group orders am I deciding right now";
 * this module answers "what has been ordered across my branches, rolled up by
 * group order and by group". It is reporting only: nothing here returns an
 * approval token or any other credential, and nothing here writes.
 *
 * Scoping is identical to the approval queue and is not optional. Every query
 * is pinned to the caller's organization *and* to the explicit branch id list
 * resolved from their assignments by `multi-branch-scope`. An empty branch
 * scope produces an empty report and is never widened into "the whole tenant" —
 * the entry points return early rather than issuing an unfiltered query.
 */

export type GroupOrderReportFilters = {
  /** Free-text match on the human-facing reference, e.g. `GRP-8F3K2QWD`. */
  reference?: string | null
  /** Envelope groups to keep. Empty means every group inside the scope. */
  groupIds?: number[]
  status?: GroupOrderReportStatus
  startDate?: Date | null
  endDate?: Date | null
}

export type GroupOrderReportChild = {
  id: number
  tid: string
  branchId: number
  branchName: string
  branchCostCenterId: string | null
  status: string
  fulfillmentStatus: string
  totalCents: number
  refundCents: number
  itemCount: number
  quantityOrdered: number
  createdAt: Date | null
  approvedAt: Date | null
  rejectionReason: string | null
}

export type GroupOrderReportRow = {
  id: number
  reference: string
  createdAt: Date | null
  notes: string | null
  groupId: number | null
  groupName: string
  requestedByName: string
  /** Counted across this approver's branches only, not the whole submission. */
  scopedOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
  statusCounts: Record<string, number>
  orders: GroupOrderReportChild[]
}

export type GroupOrderReportSummary = {
  groupOrderCount: number
  branchOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
  statusCounts: Record<string, number>
}

export type GroupOrderReportPage = {
  items: GroupOrderReportRow[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

export type GroupOrderGroupBreakdownRow = {
  groupId: number | null
  groupName: string
  groupOrderCount: number
  branchOrderCount: number
  branchCount: number
  quantityOrdered: number
  totalCents: number
  refundCents: number
  netCents: number
}

const emptyPage = (page: number, limit: number): GroupOrderReportPage => ({
  items: [],
  pagination: { page, limit, total: 0, totalPages: 0, hasMore: false },
})

const emptySummary: GroupOrderReportSummary = {
  groupOrderCount: 0,
  branchOrderCount: 0,
  branchCount: 0,
  quantityOrdered: 0,
  totalCents: 0,
  refundCents: 0,
  netCents: 0,
  statusCounts: {},
}

/**
 * Quantity ordered on one order, as a correlated subquery so a join can never
 * multiply it. Decoded at definition like the shared metric expressions, so
 * every call site returns a number rather than a driver string.
 */
const orderQuantityExpression = sql<number>`(
  SELECT COALESCE(SUM(${orderItems.quantity}), 0)
  FROM ${orderItems}
  WHERE ${orderItems.orderId} = ${orders.id}
)`.mapWith(Number)

/**
 * A quantity total across many orders.
 *
 * `order_items.quantity` is `numeric(12,3)`, so a tenant ordering in kilograms
 * or litres has real fractions here. The sum therefore stays numeric — casting
 * it to an integer rounded the headline away from the rows underneath it, so
 * three orders of 0.5 read as 2 in the tile and 1.5 in the list.
 */
const quantityTotalExpression = sql<number>`COALESCE(SUM(${orderQuantityExpression}), 0)::numeric`.mapWith(Number)

/** Totals are summed as floats once decoded, so they are re-rounded to scale. */
function sumQuantities(values: number[]): number {
  return roundQuantity(values.reduce((total, value) => total + roundQuantity(value), 0))
}

/** Refunded amount on one order; the column is nullable, a report total is not. */
const refundCentsExpression = sql<number>`COALESCE(${orders.refundAmountCents}, 0)`.mapWith(Number)

function statusCondition(status: GroupOrderReportStatus) {
  if (status === "ALL") return undefined
  // Matches the order report: a cancelled order reads as rejected everywhere a
  // user filters on an outcome, so the two stay one bucket here as well.
  return status === "REJECTED"
    ? sql`UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED')`
    : sql`UPPER(${orders.status}) = ${status}`
}

/**
 * The conditions every child order in the report must satisfy.
 *
 * The first three are the security boundary and are always present: the
 * caller's tenant, the caller's assigned branches, and "raised as part of a
 * group order". The rest are user-supplied narrowing applied on top, so a
 * filter can only ever shrink this set.
 */
function childConditions(
  scope: { organizationId: number; branchIds: number[] },
  filters: GroupOrderReportFilters,
) {
  const conditions: any[] = [
    eq(orders.organizationId, scope.organizationId),
    inArray(orders.branchId, scope.branchIds),
    sql`${orders.groupOrderId} IS NOT NULL`,
  ]

  const status = statusCondition(filters.status ?? "ALL")
  if (status) conditions.push(status)
  if (filters.startDate) conditions.push(gte(orders.createdAt, filters.startDate))
  if (filters.endDate) conditions.push(lte(orders.createdAt, filters.endDate))

  return conditions
}

/**
 * The conditions the envelope itself must satisfy: the caller's tenant, plus
 * the reference and group narrowing. Never a substitute for the child
 * conditions above — both are applied on every read.
 */
function envelopeConditions(
  scope: { organizationId: number },
  filters: GroupOrderReportFilters,
) {
  const conditions: any[] = [eq(groupOrders.organizationId, scope.organizationId)]

  const reference = filters.reference?.trim() ?? ""
  if (reference.length > 0) {
    conditions.push(ilike(
      groupOrders.reference,
      `%${escapeLikePattern(reference.slice(0, GROUP_ORDER_REFERENCE_MAX_LENGTH))}%`,
    ))
  }
  if (filters.groupIds && filters.groupIds.length > 0) {
    conditions.push(inArray(groupOrders.groupId, filters.groupIds))
  }

  return conditions
}

function countByStatus(children: Pick<GroupOrderReportChild, "status">[]): Record<string, number> {
  return children.reduce<Record<string, number>>((counts, child) => {
    const status = (child.status || "PENDING").toUpperCase()
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
}

/**
 * Ids of the envelopes that still have a child order inside the scope once the
 * filters are applied. Used as a subquery so the envelope list and its counts
 * are always derived from orders the caller may actually see.
 */
function matchingEnvelopeIds(
  scope: { organizationId: number; branchIds: number[] },
  filters: GroupOrderReportFilters,
) {
  return db
    .selectDistinct({ id: orders.groupOrderId })
    .from(orders)
    .where(and(...childConditions(scope, filters)))
}

function displayName(row: { firstName: string | null; lastName: string | null; email: string | null }): string {
  const full = [row.firstName, row.lastName].filter(Boolean).join(" ").trim()
  return full || row.email || "Unknown user"
}

/**
 * Who raised each of the envelopes on the current page.
 *
 * Read separately from the envelope query so the requester join can never widen
 * that query's row set, and pinned to the same tenant so a mismatched row
 * contributes no name rather than another tenant's user.
 */
async function loadRequesterNames(
  organizationId: number,
  envelopeIds: number[],
): Promise<Map<number, string>> {
  if (envelopeIds.length === 0) return new Map()

  const rows = await db
    .select({
      id: groupOrders.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(groupOrders)
    .leftJoin(users, eq(groupOrders.createdByUserId, users.id))
    .where(and(
      inArray(groupOrders.id, envelopeIds),
      eq(groupOrders.organizationId, organizationId),
    ))

  return new Map(rows.map((row) => [row.id, displayName(row)]))
}

/** Headline totals across every branch order the filters leave in scope. */
export async function getGroupOrderReportSummary({
  organizationId,
  scopedBranchIds,
  filters,
}: {
  organizationId: number | null
  scopedBranchIds: number[]
  filters: GroupOrderReportFilters
}): Promise<GroupOrderReportSummary> {
  const scope = approverScope(organizationId, scopedBranchIds)
  if (!scope.usable) return emptySummary

  const where = and(
    ...childConditions(scope, filters),
    inArray(
      orders.groupOrderId,
      db.select({ id: groupOrders.id }).from(groupOrders).where(and(...envelopeConditions(scope, filters))),
    ),
  )

  const [row] = await db
    .select({
      groupOrderCount: sql<number>`COUNT(DISTINCT ${orders.groupOrderId})::int`.mapWith(Number),
      branchOrderCount: sql<number>`COUNT(*)::int`.mapWith(Number),
      branchCount: sql<number>`COUNT(DISTINCT ${orders.branchId})::int`.mapWith(Number),
      quantityOrdered: quantityTotalExpression,
      totalCents: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)::bigint`.mapWith(Number),
      refundCents: sql<number>`COALESCE(SUM(${refundCentsExpression}), 0)::bigint`.mapWith(Number),
      pending: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'PENDING')::int`.mapWith(Number),
      approved: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'APPROVED')::int`.mapWith(Number),
      fulfilled: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'FULFILLED')::int`.mapWith(Number),
      rejected: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED'))::int`.mapWith(Number),
      refunded: sql<number>`COUNT(*) FILTER (WHERE UPPER(${orders.status}) = 'REFUNDED')::int`.mapWith(Number),
    })
    .from(orders)
    .where(where)

  const totalCents = Number(row?.totalCents ?? 0)
  const refundCents = Number(row?.refundCents ?? 0)

  return {
    groupOrderCount: Number(row?.groupOrderCount ?? 0),
    branchOrderCount: Number(row?.branchOrderCount ?? 0),
    branchCount: Number(row?.branchCount ?? 0),
    quantityOrdered: roundQuantity(Number(row?.quantityOrdered ?? 0)),
    totalCents,
    refundCents,
    netCents: totalCents - refundCents,
    statusCounts: {
      PENDING: Number(row?.pending ?? 0),
      APPROVED: Number(row?.approved ?? 0),
      FULFILLED: Number(row?.fulfilled ?? 0),
      REJECTED: Number(row?.rejected ?? 0),
      REFUNDED: Number(row?.refunded ?? 0),
    },
  }
}

/**
 * One row per group order, newest first, each carrying only the branch orders
 * inside the approver's scope.
 *
 * A submission that also reached branches the caller does not cover is reported
 * as the part they are responsible for, never in full — the child read
 * re-asserts the branch scope rather than trusting the envelope's visibility.
 */
export async function listGroupOrderReport({
  organizationId,
  scopedBranchIds,
  page,
  limit,
  filters,
}: {
  organizationId: number | null
  scopedBranchIds: number[]
  page: number
  limit: number
  filters: GroupOrderReportFilters
}): Promise<GroupOrderReportPage> {
  const scope = approverScope(organizationId, scopedBranchIds)
  if (!scope.usable) return emptyPage(page, limit)

  const envelopeWhere = and(
    ...envelopeConditions(scope, filters),
    inArray(groupOrders.id, matchingEnvelopeIds(scope, filters)),
  )

  const [[countRow], envelopes] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(*)::int`.mapWith(Number) })
      .from(groupOrders)
      .where(envelopeWhere),
    db
      .select({
        id: groupOrders.id,
        reference: groupOrders.reference,
        createdAt: groupOrders.createdAt,
        notes: groupOrders.notes,
        groupId: groupOrders.groupId,
        groupName: groups.name,
      })
      .from(groupOrders)
      .leftJoin(groups, and(
        eq(groupOrders.groupId, groups.id),
        eq(groups.organizationId, groupOrders.organizationId),
      ))
      .where(envelopeWhere)
      .orderBy(desc(groupOrders.createdAt), desc(groupOrders.id))
      .limit(limit)
      .offset((page - 1) * limit),
  ])

  const total = Number(countRow?.total ?? 0)
  const totalPages = Math.ceil(total / limit)
  if (envelopes.length === 0) {
    return { items: [], pagination: { page, limit, total, totalPages, hasMore: false } }
  }

  const envelopeIds = envelopes.map((envelope) => envelope.id)
  const requesterNames = await loadRequesterNames(scope.organizationId, envelopeIds)

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
      refundCents: refundCentsExpression,
      createdAt: orders.createdAt,
      approvedAt: orders.approvedAt,
      rejectionReason: orders.rejectionReason,
      quantityOrdered: orderQuantityExpression,
      itemCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id}
      )`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    // The full scope is re-asserted here: an envelope being visible never
    // implies its orders in other branches are.
    .where(and(...childConditions(scope, filters), inArray(orders.groupOrderId, envelopeIds)))
    .orderBy(orders.branchId, orders.id)

  const childrenByEnvelope = new Map<number, GroupOrderReportChild[]>()
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
      refundCents: Number(row.refundCents ?? 0),
      itemCount: row.itemCount,
      quantityOrdered: roundQuantity(Number(row.quantityOrdered ?? 0)),
      createdAt: row.createdAt,
      approvedAt: row.approvedAt,
      rejectionReason: row.rejectionReason,
    })
    childrenByEnvelope.set(row.groupOrderId, bucket)
  }

  const items = envelopes.map((envelope): GroupOrderReportRow => {
    const children = childrenByEnvelope.get(envelope.id) ?? []
    const totalCents = children.reduce((sum, child) => sum + (child.totalCents ?? 0), 0)
    const refundCents = children.reduce((sum, child) => sum + (child.refundCents ?? 0), 0)
    return {
      id: envelope.id,
      reference: envelope.reference,
      createdAt: envelope.createdAt,
      notes: envelope.notes,
      groupId: envelope.groupId,
      groupName: envelope.groupName ?? UNGROUPED_BUCKET_NAME,
      requestedByName: requesterNames.get(envelope.id) ?? "Unknown user",
      scopedOrderCount: children.length,
      branchCount: new Set(children.map((child) => child.branchId)).size,
      quantityOrdered: sumQuantities(children.map((child) => child.quantityOrdered ?? 0)),
      totalCents,
      refundCents,
      netCents: totalCents - refundCents,
      statusCounts: countByStatus(children),
      orders: children,
    }
  })

  return {
    items,
    pagination: { page, limit, total, totalPages, hasMore: page * limit < total },
  }
}

/**
 * Totals rolled up by the group each submission was raised under.
 *
 * This is the "orders by group" view of the same filtered set the row list
 * shows, so the two always agree. Submissions raised for branches without a
 * group land in a single unassigned bucket rather than being dropped.
 */
export async function summarizeGroupOrdersByGroup({
  organizationId,
  scopedBranchIds,
  filters,
}: {
  organizationId: number | null
  scopedBranchIds: number[]
  filters: GroupOrderReportFilters
}): Promise<GroupOrderGroupBreakdownRow[]> {
  const scope = approverScope(organizationId, scopedBranchIds)
  if (!scope.usable) return []

  const rows = await db
    .select({
      groupId: groupOrders.groupId,
      groupName: groups.name,
      groupOrderCount: sql<number>`COUNT(DISTINCT ${orders.groupOrderId})::int`.mapWith(Number),
      branchOrderCount: sql<number>`COUNT(*)::int`.mapWith(Number),
      branchCount: sql<number>`COUNT(DISTINCT ${orders.branchId})::int`.mapWith(Number),
      quantityOrdered: quantityTotalExpression,
      totalCents: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)::bigint`.mapWith(Number),
      refundCents: sql<number>`COALESCE(SUM(${refundCentsExpression}), 0)::bigint`.mapWith(Number),
    })
    .from(orders)
    // Inner join: an order without a readable envelope in this tenant is not
    // part of the group order report at all.
    .innerJoin(groupOrders, and(
      eq(orders.groupOrderId, groupOrders.id),
      eq(groupOrders.organizationId, scope.organizationId),
    ))
    .leftJoin(groups, and(
      eq(groupOrders.groupId, groups.id),
      eq(groups.organizationId, groupOrders.organizationId),
    ))
    .where(and(...childConditions(scope, filters), ...envelopeConditions(scope, filters)))
    .groupBy(groupOrders.groupId, groups.name)
    .orderBy(desc(sql`COALESCE(SUM(${orders.totalCents}), 0)`))

  return rows.map((row): GroupOrderGroupBreakdownRow => {
    const totalCents = Number(row.totalCents ?? 0)
    const refundCents = Number(row.refundCents ?? 0)
    return {
      groupId: row.groupId,
      groupName: row.groupName ?? UNGROUPED_BUCKET_NAME,
      groupOrderCount: Number(row.groupOrderCount ?? 0),
      branchOrderCount: Number(row.branchOrderCount ?? 0),
      branchCount: Number(row.branchCount ?? 0),
      quantityOrdered: roundQuantity(Number(row.quantityOrdered ?? 0)),
      totalCents,
      refundCents,
      netCents: totalCents - refundCents,
    }
  })
}
