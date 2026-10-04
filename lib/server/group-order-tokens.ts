import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { auditLogs, branches, groupOrders, groups, orderItems, orders } from "@/db/schema"
import { db } from "@/lib/db"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { UNGROUPED_BUCKET_NAME } from "@/lib/server/group-order-portal"
import { GROUP_ORDER_PORTAL_ROLE, resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * The fulfilment tokens for one group order, handed to admin operations in a
 * single message.
 *
 * The single-order hand-off emails one token at a time, which is right when
 * there is one order. A group order approves into one branch order per branch,
 * each with its own token, so doing the same thing here would mean dozens of
 * separate emails — and would quickly exhaust the shared email allowance.
 * Collecting them into one message is both the better hand-off for the
 * administrator and the version of this that works at group scale.
 *
 * It grants no reach the per-order route does not already grant. Every token
 * released here belongs to an approved order this same user created, inside
 * their own tenant, at a branch still in their live assignments, and the
 * decision is made by the same `canViewFulfillmentToken` policy every other
 * surface consults.
 */

export type GroupOrderTokenLine = {
  productName: string
  productCode: string | null
  quantity: number
  unit: string
}

export type GroupOrderTokenEntry = {
  orderId: number
  tid: string
  branchId: number
  branchName: string
  status: string
  token: string
  createdAt: Date | null
  items: GroupOrderTokenLine[]
}

export type GroupOrderTokenBundle = {
  reference: string
  groupName: string
  organizationId: number
  entries: GroupOrderTokenEntry[]
}

/**
 * Collect every token this user may currently share for one of their own group
 * orders. Returns null when the group order is not theirs, which the route
 * turns into a 404 rather than a 403.
 */
export async function loadShareableGroupTokens({
  userId,
  organizationId,
  groupOrderId,
}: {
  userId: string
  organizationId: number
  groupOrderId: number
}): Promise<GroupOrderTokenBundle | null> {
  const [envelope] = await db
    .select({
      id: groupOrders.id,
      reference: groupOrders.reference,
      groupName: groups.name,
    })
    .from(groupOrders)
    .leftJoin(groups, and(
      eq(groupOrders.groupId, groups.id),
      eq(groups.organizationId, groupOrders.organizationId),
    ))
    .where(and(
      eq(groupOrders.id, groupOrderId),
      eq(groupOrders.createdByUserId, userId),
      eq(groupOrders.organizationId, organizationId),
    ))
    .limit(1)

  if (!envelope) return null

  const bundle: GroupOrderTokenBundle = {
    reference: envelope.reference,
    groupName: envelope.groupName ?? UNGROUPED_BUCKET_NAME,
    organizationId,
    entries: [],
  }

  const children = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      status: orders.status,
      createdByUserId: orders.createdByUserId,
      approvalToken: orders.approvalToken,
      createdAt: orders.createdAt,
      branchOrganizationId: branches.organizationId,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      eq(orders.groupOrderId, envelope.id),
      eq(orders.organizationId, organizationId),
      eq(orders.createdByUserId, userId),
    ))
    .orderBy(orders.branchId)

  if (children.length === 0) return bundle

  // The branch scope is resolved live, so an assignment taken away closes the
  // branch immediately even for an order this user did raise.
  const scopedBranchIds = new Set(await resolveScopedBranchIds(db, userId))

  const shareable = children.filter((child) => {
    if (!child.approvalToken) return false
    if (!scopedBranchIds.has(child.branchId)) return false
    // Re-assert the branch's own tenant, so a mismatched row contributes nothing.
    if (child.branchOrganizationId !== organizationId) return false
    return canViewFulfillmentToken({
      role: GROUP_ORDER_PORTAL_ROLE,
      userId,
      orderStatus: child.status,
      orderCreatedByUserId: child.createdByUserId,
    })
  })

  if (shareable.length === 0) return bundle

  const itemRows = await db
    .select({
      orderId: orderItems.orderId,
      productName: orderItems.productName,
      productCode: orderItems.productCode,
      quantity: orderItems.quantity,
      unit: orderItems.unit,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, shareable.map((child) => child.id)))

  const itemsByOrder = new Map<number, GroupOrderTokenLine[]>()
  for (const row of itemRows) {
    const bucket = itemsByOrder.get(row.orderId) ?? []
    bucket.push({
      productName: row.productName,
      productCode: row.productCode ?? null,
      quantity: Number(row.quantity || 0),
      unit: row.unit ?? "",
    })
    itemsByOrder.set(row.orderId, bucket)
  }

  bundle.entries = shareable.map((child) => ({
    orderId: child.id,
    tid: child.tid,
    branchId: child.branchId,
    branchName: child.branchName ?? `Branch ${child.branchId}`,
    status: child.status,
    token: child.approvalToken as string,
    createdAt: child.createdAt,
    items: itemsByOrder.get(child.id) ?? [],
  }))

  return bundle
}

/**
 * Record the hand-off against every order whose token was shared, so a group
 * hand-off leaves the same per-order trail a single hand-off does.
 */
export async function recordGroupTokenHandoff({
  userId,
  organizationId,
  bundle,
  recipient,
  fulfilledOrderIds,
  awaitingDeliveryOrderIds,
}: {
  userId: string
  organizationId: number
  bundle: GroupOrderTokenBundle
  recipient: string
  /** The orders the hand-off actually settled, so the trail records what moved. */
  fulfilledOrderIds?: ReadonlySet<number>
  /** The orders whose hand-off is recorded and waiting on their delivery. */
  awaitingDeliveryOrderIds?: ReadonlySet<number>
}): Promise<void> {
  if (bundle.entries.length === 0) return

  await db.insert(auditLogs).values(bundle.entries.map((entry) => ({
    userId,
    organizationId,
    branchId: entry.branchId,
    action: "SEND_ORDER_TOKEN_EMAIL",
    entity: "ORDER",
    entityId: String(entry.orderId),
    metadata: {
      tid: entry.tid,
      recipient,
      groupOrderReference: bundle.reference,
      fulfilled: Boolean(fulfilledOrderIds?.has(entry.orderId)),
      awaitingDelivery: Boolean(awaitingDeliveryOrderIds?.has(entry.orderId)),
    },
  })))
}
