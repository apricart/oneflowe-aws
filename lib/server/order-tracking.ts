import "server-only"

import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm"

import { auditLogs, branchDeliveryAddresses, branches, orderItems, orders, refunds } from "@/db/schema"
import type { RequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { describeDeliveryAddress } from "@/lib/delivery-address"
import {
  RECENT_TRACKABLE_ORDER_LIMIT,
  stageTimesFromTrail,
  trackingReferenceOrderId,
  type RecentTrackableOrder,
  type TrackedOrderView,
} from "@/lib/order-tracking"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { canReadOrderDetail } from "@/lib/server/order-read-access"

/**
 * The requester order tracker (plans/OF-TRACKING-requester-order-tracking.md).
 *
 * Who may track an order is **exactly** who may read it on the order page:
 * the reference is resolved to an order inside the caller's own organization,
 * and that order is then put through `canReadOrderDetail` — the Order
 * Initiator its own orders and its branch's group orders, the Group Order
 * Initiator the orders of the branches it is assigned. Not found and not
 * yours answer the same null, so the lookup cannot be used to probe for ids.
 */

/** The two requester roles the tracker serves. */
export const ORDER_TRACKING_ROLES = ["ORDER_PORTAL", "GROUP_ORDER_PORTAL"] as const

const MAX_TRACKED_ITEMS = 200
const MAX_TRACKED_REFUNDS = 20
const MAX_TRAIL_ROWS = 50

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isTrackingRole(role: unknown): boolean {
  return typeof role === "string" && (ORDER_TRACKING_ROLES as readonly string[]).includes(role)
}

/**
 * The order a reference names inside the caller's organization: a transaction
 * id first (TIDs are generated lower-case, so a typed upper-case one still
 * matches), else an order id.
 */
async function resolveReference(organizationId: number, reference: string): Promise<number | null> {
  const tids = Array.from(new Set([reference, reference.toLowerCase()]))
  const orderId = trackingReferenceOrderId(reference)
  const rows = await db
    .select({ id: orders.id, tid: orders.tid })
    .from(orders)
    .where(and(
      eq(orders.organizationId, organizationId),
      orderId === null ? inArray(orders.tid, tids) : or(inArray(orders.tid, tids), eq(orders.id, orderId)),
    ))
    .limit(2)
  return (rows.find((row) => tids.includes(row.tid)) ?? rows[0])?.id ?? null
}

/** The tracked view of one order, or null when it is not the caller's to read. */
export async function loadTrackedOrder(scope: RequestScope | null, reference: string): Promise<TrackedOrderView | null> {
  if (!scope || !isTrackingRole(scope.role) || !scope.organizationId) return null
  const organizationId = scope.organizationId

  const orderId = await resolveReference(organizationId, reference)
  if (orderId === null) return null
  if (!await canReadOrderDetail({ orderId, scope })) return null

  const [order] = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      paymentStatus: orders.paymentStatus,
      branchName: branches.name,
      deliveryLabel: branchDeliveryAddresses.label,
      deliveryAddress: branchDeliveryAddresses.address,
      deliveryCity: branchDeliveryAddresses.city,
      deliveryProvince: branchDeliveryAddresses.province,
      poNumber: orders.poNumber,
      groupOrderId: orders.groupOrderId,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      approvedAt: orders.approvedAt,
      rejectedAt: orders.rejectedAt,
      cancelledAt: orders.cancelledAt,
      returnedForCorrectionAt: orders.returnedForCorrectionAt,
      deliveredAt: orders.deliveredAt,
      fulfilledAt: orders.fulfilledAt,
      paidAt: orders.paidAt,
      refundedAt: orders.refundedAt,
      rejectionReason: orders.rejectionReason,
      cancellationReason: orders.cancellationReason,
      correctionRequestNote: orders.correctionRequestNote,
    })
    .from(orders)
    .innerJoin(branches, and(eq(branches.id, orders.branchId), eq(branches.organizationId, organizationId)))
    .leftJoin(branchDeliveryAddresses, and(
      eq(branchDeliveryAddresses.id, orders.deliveryAddressId),
      eq(branchDeliveryAddresses.branchId, orders.branchId),
    ))
    .where(and(eq(orders.id, orderId), eq(orders.organizationId, organizationId)))
    .limit(1)
  if (!order) return null

  const [items, refundRows, trail, hidePrices] = await Promise.all([
    db
      .select({
        productName: orderItems.productName,
        productCode: orderItems.productCode,
        unit: orderItems.unit,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id))
      .limit(MAX_TRACKED_ITEMS),
    db
      .select({ status: refunds.status, createdAt: refunds.createdAt, updatedAt: refunds.updatedAt })
      .from(refunds)
      .where(and(eq(refunds.orderId, order.id), or(isNull(refunds.organizationId), eq(refunds.organizationId, organizationId))))
      .orderBy(asc(refunds.createdAt), asc(refunds.id))
      .limit(MAX_TRACKED_REFUNDS),
    // The progress route records each delivery step with entity `Order`; the
    // lower-case spelling is read too, as the delivery dashboard does.
    db
      .select({ metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(
        inArray(auditLogs.entity, ["Order", "order"]),
        eq(auditLogs.entityId, String(order.id)),
        eq(auditLogs.action, "ORDER_FULFILLMENT_STATUS_UPDATE"),
        or(isNull(auditLogs.organizationId), eq(auditLogs.organizationId, organizationId)),
      ))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(MAX_TRAIL_ROWS),
    shouldHidePricesForRole(scope.role, organizationId),
  ])

  const stageTimes = stageTimesFromTrail(
    trail.map((entry) => ({ to: (entry.metadata as { to?: unknown } | null)?.to, at: entry.createdAt })),
    order.fulfillmentStatus,
  )

  return {
    id: order.id,
    tid: order.tid,
    status: order.status,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus,
    branchName: order.branchName,
    deliveryAddress: order.deliveryAddress
      ? describeDeliveryAddress({
        label: order.deliveryLabel,
        address: order.deliveryAddress,
        city: order.deliveryCity,
        province: order.deliveryProvince,
      }) || null
      : null,
    poNumber: order.poNumber,
    isGroupOrder: order.groupOrderId !== null,
    totalCents: hidePrices ? null : Number(order.totalCents),
    createdAt: iso(order.createdAt),
    approvedAt: iso(order.approvedAt),
    rejectedAt: iso(order.rejectedAt),
    cancelledAt: iso(order.cancelledAt),
    returnedForCorrectionAt: iso(order.returnedForCorrectionAt),
    inProcessAt: stageTimes.IN_PROCESS ?? null,
    outForDeliveryAt: stageTimes.OUT_FOR_DELIVERY ?? null,
    deliveredAt: iso(order.deliveredAt),
    fulfilledAt: iso(order.fulfilledAt),
    paidAt: iso(order.paidAt),
    refundedAt: iso(order.refundedAt),
    rejectionReason: order.rejectionReason,
    cancellationReason: order.cancellationReason,
    correctionRequestNote: order.correctionRequestNote,
    refunds: refundRows.map((row) => ({ status: row.status, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })),
    items: items.map((item) => ({
      productName: item.productName,
      productCode: item.productCode,
      unit: item.unit,
      quantity: Number(item.quantity),
    })),
  }
}

/**
 * The caller's most recent orders, for the picker on the tracking page. A
 * subset of what `loadTrackedOrder` would admit: the Order Initiator's own
 * orders and its branch's group orders at its own branch; the Group Order
 * Initiator's own submissions at branches it is still assigned. No branch or
 * no assignment reads nothing rather than widening to the organization.
 */
export async function loadRecentTrackableOrders(scope: RequestScope | null): Promise<RecentTrackableOrder[]> {
  if (!scope || !isTrackingRole(scope.role) || !scope.organizationId) return []

  let reach
  if (scope.role === "GROUP_ORDER_PORTAL") {
    const branchIds = await resolveScopedBranchIds(db, scope.userId)
    if (branchIds.length === 0) return []
    reach = and(inArray(orders.branchId, branchIds), eq(orders.createdByUserId, scope.userId))
  } else {
    if (!scope.branchId) return []
    reach = and(
      eq(orders.branchId, scope.branchId),
      or(eq(orders.createdByUserId, scope.userId), isNotNull(orders.groupOrderId)),
    )
  }

  const rows = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      paymentStatus: orders.paymentStatus,
      branchName: branches.name,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(branches, and(eq(branches.id, orders.branchId), eq(branches.organizationId, scope.organizationId)))
    .where(and(eq(orders.organizationId, scope.organizationId), reach))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(RECENT_TRACKABLE_ORDER_LIMIT)

  return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }))
}
