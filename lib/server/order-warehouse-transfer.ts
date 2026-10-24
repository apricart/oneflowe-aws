import "server-only"

import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import {
  apricartWarehouseMemberships,
  apricartWarehouses,
  branches,
  branchFulfillmentRoutes,
  orders,
  orderWarehouseTransfers,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  ORDER_WAREHOUSE_TRANSFER_AUDIT_ACTION,
  ORDER_WAREHOUSE_TRANSFER_HISTORY_LIMIT,
  orderWarehouseTransferRefusal,
  type OrderWarehouseTransferRefusal,
} from "@/lib/order-warehouse-transfer"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import {
  loadBranchWarehouseRecipients,
  loadWarehouseOrderRecipients,
  queueWarehouseOrderNotifications,
} from "@/lib/server/warehouse-order-notifications"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"

/**
 * Super Admin moves one order from one Apricart warehouse to another.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 3, as built).
 *
 * Only `orders.fulfillment_warehouse_id` moves. The order's branch, tenant,
 * status, stage, approval, budget hold, invoice and delivery clock
 * (`approved_at`) are untouched, and so is `updated_at`: an executive approving
 * a pending desk order names the `updated_at` it saw, and a transfer changes
 * nothing it approved. Every warehouse read and write judges the order by
 * `isOrderInWarehouseOrderReach`, so the change takes effect for both sides the
 * moment this commits.
 */

type Actor = AuditActor & { id: string }
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type WarehouseSummary = { id: number; code: string; name: string; city: string | null }

export type OrderWarehousePanel = {
  order: {
    id: number
    tid: string
    status: string
    fulfillmentStatus: string | null
    branchId: number
    branchName: string
  }
  /** The warehouse the order was transferred to, or null: worked by whoever serves its branch. */
  currentWarehouse: (WarehouseSummary & { status: string }) | null
  /** The branch's default warehouse (Warehouse Team → Warehouses). Information only. */
  branchDefaultWarehouse: WarehouseSummary | null
  /** The accounts working the order now. */
  workedBy: Array<{ id: string; name: string }>
  /** How many accounts serve the branch, for handing the order back to them. */
  branchServingAccountCount: number
  refusal: OrderWarehouseTransferRefusal | null
  targets: Array<WarehouseSummary & { operatorCount: number }>
  history: Array<{
    id: number
    from: WarehouseSummary | null
    to: WarehouseSummary | null
    reason: string
    transferredBy: string | null
    createdAt: string
  }>
}

const WORKED_BY_LIMIT = 20
const TARGET_LIMIT = 200

const warehouseSummaryColumns = {
  id: apricartWarehouses.id,
  code: apricartWarehouses.code,
  name: apricartWarehouses.name,
  city: apricartWarehouses.city,
}

function accountName(account: { fullName: string | null; username: string | null; email: string | null }): string {
  return account.fullName?.trim() || account.username?.trim() || account.email?.trim() || "Warehouse account"
}

async function activeOperatorCounts(client: typeof db | Transaction, warehouseIds: number[]): Promise<Map<number, number>> {
  if (warehouseIds.length === 0) return new Map()
  const rows = await client
    .select({ warehouseId: apricartWarehouseMemberships.warehouseId, operators: count() })
    .from(apricartWarehouseMemberships)
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      inArray(apricartWarehouseMemberships.warehouseId, warehouseIds),
      eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR"),
      eq(roles.name, WAREHOUSE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .groupBy(apricartWarehouseMemberships.warehouseId)
  return new Map(rows.map((row) => [row.warehouseId, Number(row.operators)]))
}

/** Super Admin's view of one order's warehouse, or null when the order does not exist. */
export async function loadOrderWarehousePanel(orderId: number): Promise<OrderWarehousePanel | null> {
  const current = alias(apricartWarehouses, "current_warehouse")
  const routed = alias(apricartWarehouses, "routed_warehouse")
  const [row] = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      branchId: orders.branchId,
      branchName: branches.name,
      fulfillmentWarehouseId: orders.fulfillmentWarehouseId,
      currentCode: current.code,
      currentName: current.name,
      currentCity: current.city,
      currentStatus: current.status,
      routedId: routed.id,
      routedCode: routed.code,
      routedName: routed.name,
      routedCity: routed.city,
    })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .leftJoin(current, eq(current.id, orders.fulfillmentWarehouseId))
    .leftJoin(branchFulfillmentRoutes, eq(branchFulfillmentRoutes.branchId, orders.branchId))
    .leftJoin(routed, eq(routed.id, branchFulfillmentRoutes.warehouseId))
    .where(eq(orders.id, orderId))
    .limit(1)
  if (!row) return null

  const from = alias(apricartWarehouses, "from_warehouse")
  const to = alias(apricartWarehouses, "to_warehouse")
  const [recipients, branchServing, targetRows, historyRows] = await Promise.all([
    loadWarehouseOrderRecipients(db, orderId),
    loadBranchWarehouseRecipients(db, row.branchId),
    db
      .select(warehouseSummaryColumns)
      .from(apricartWarehouses)
      .where(eq(apricartWarehouses.status, "ACTIVE"))
      .orderBy(asc(apricartWarehouses.code))
      .limit(TARGET_LIMIT),
    db
      .select({
        id: orderWarehouseTransfers.id,
        reason: orderWarehouseTransfers.reason,
        createdAt: orderWarehouseTransfers.createdAt,
        fromId: from.id,
        fromCode: from.code,
        fromName: from.name,
        fromCity: from.city,
        toId: to.id,
        toCode: to.code,
        toName: to.name,
        toCity: to.city,
        actorFullName: users.fullName,
        actorUsername: users.username,
        actorEmail: users.email,
      })
      .from(orderWarehouseTransfers)
      .leftJoin(from, eq(from.id, orderWarehouseTransfers.fromWarehouseId))
      .leftJoin(to, eq(to.id, orderWarehouseTransfers.toWarehouseId))
      .leftJoin(users, eq(users.id, orderWarehouseTransfers.transferredByUserId))
      .where(eq(orderWarehouseTransfers.orderId, orderId))
      .orderBy(desc(orderWarehouseTransfers.id))
      .limit(ORDER_WAREHOUSE_TRANSFER_HISTORY_LIMIT),
  ])

  const workedByRows = recipients.length === 0
    ? []
    : await db
      .select({ id: users.id, fullName: users.fullName, username: users.username, email: users.email })
      .from(users)
      .where(inArray(users.id, recipients.slice(0, WORKED_BY_LIMIT).map((recipient) => recipient.id)))
      .orderBy(asc(users.fullName))
  const operators = await activeOperatorCounts(db, targetRows.map((target) => target.id))

  return {
    order: {
      id: row.id,
      tid: row.tid,
      status: row.status,
      fulfillmentStatus: row.fulfillmentStatus,
      branchId: row.branchId,
      branchName: row.branchName,
    },
    currentWarehouse: row.fulfillmentWarehouseId !== null && row.currentCode && row.currentName && row.currentStatus
      ? { id: row.fulfillmentWarehouseId, code: row.currentCode, name: row.currentName, city: row.currentCity, status: row.currentStatus }
      : null,
    branchDefaultWarehouse: row.routedId !== null && row.routedCode && row.routedName
      ? { id: row.routedId, code: row.routedCode, name: row.routedName, city: row.routedCity }
      : null,
    workedBy: workedByRows.map((account) => ({ id: account.id, name: accountName(account) })),
    branchServingAccountCount: branchServing.length,
    refusal: orderWarehouseTransferRefusal(row),
    targets: targetRows.map((target) => ({ ...target, operatorCount: operators.get(target.id) ?? 0 })),
    history: historyRows.map((entry) => ({
      id: entry.id,
      from: entry.fromId !== null && entry.fromCode && entry.fromName
        ? { id: entry.fromId, code: entry.fromCode, name: entry.fromName, city: entry.fromCity }
        : null,
      to: entry.toId !== null && entry.toCode && entry.toName
        ? { id: entry.toId, code: entry.toCode, name: entry.toName, city: entry.toCity }
        : null,
      reason: entry.reason,
      transferredBy: entry.actorFullName || entry.actorUsername || entry.actorEmail
        ? accountName({ fullName: entry.actorFullName, username: entry.actorUsername, email: entry.actorEmail })
        : null,
      createdAt: entry.createdAt.toISOString(),
    })),
  }
}

export type OrderWarehouseTransferOutcome =
  | { kind: "transferred"; transferId: number; fromWarehouseId: number | null; toWarehouseId: number | null }
  | { kind: "not-found" }
  | { kind: "refused"; refusal: OrderWarehouseTransferRefusal }
  /** The order's warehouse is no longer the one the caller saw. */
  | { kind: "stale" }
  | { kind: "unchanged" }
  | { kind: "target-not-found" }
  | { kind: "target-inactive" }
  /** Nobody would work the order there: no active operator, or no account serving the branch. */
  | { kind: "no-operator" }

/**
 * Move one order to `targetWarehouseId`, or — with null — hand it back to the
 * accounts that serve its branch.
 *
 * Under the order row's FOR UPDATE, the lock every warehouse write takes in its
 * guard, so a transfer and a stage move of one order have one winner; the
 * target warehouse is taken FOR SHARE, so it cannot be deactivated or lose its
 * operators while the order moves onto it. `expectedWarehouseId` is the
 * warehouse the caller's screen showed: if another transfer happened since,
 * nothing moves.
 */
export async function transferOrderWarehouse(input: {
  orderId: number
  targetWarehouseId: number | null
  expectedWarehouseId: number | null
  reason: string
  actor: Actor
}): Promise<OrderWarehouseTransferOutcome> {
  let eventKeys: string[] = []
  const outcome = await db.transaction(async (tx): Promise<OrderWarehouseTransferOutcome> => {
    const [order] = await tx
      .select({
        id: orders.id,
        tid: orders.tid,
        organizationId: orders.organizationId,
        branchId: orders.branchId,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        fulfillmentWarehouseId: orders.fulfillmentWarehouseId,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId))
      .for("update")
      .limit(1)
    if (!order) return { kind: "not-found" }

    const refusal = orderWarehouseTransferRefusal(order)
    if (refusal) return { kind: "refused", refusal }
    if (order.fulfillmentWarehouseId !== input.expectedWarehouseId) return { kind: "stale" }
    if (order.fulfillmentWarehouseId === input.targetWarehouseId) return { kind: "unchanged" }

    let target: { id: number; code: string; name: string } | null = null
    if (input.targetWarehouseId !== null) {
      const [row] = await tx
        .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, name: apricartWarehouses.name, status: apricartWarehouses.status })
        .from(apricartWarehouses)
        .where(eq(apricartWarehouses.id, input.targetWarehouseId))
        .for("share")
        .limit(1)
      if (!row) return { kind: "target-not-found" }
      if (row.status !== "ACTIVE") return { kind: "target-inactive" }
      if (((await activeOperatorCounts(tx, [row.id])).get(row.id) ?? 0) === 0) return { kind: "no-operator" }
      target = { id: row.id, code: row.code, name: row.name }
    } else if ((await loadBranchWarehouseRecipients(tx, order.branchId)).length === 0) {
      return { kind: "no-operator" }
    }

    const [source] = order.fulfillmentWarehouseId === null
      ? []
      : await tx
        .select({ code: apricartWarehouses.code, name: apricartWarehouses.name })
        .from(apricartWarehouses)
        .where(eq(apricartWarehouses.id, order.fulfillmentWarehouseId))
        .limit(1)

    const before = await loadWarehouseOrderRecipients(tx, order.id)

    await tx
      .update(orders)
      .set({ fulfillmentWarehouseId: input.targetWarehouseId })
      .where(eq(orders.id, order.id))

    const [transfer] = await tx
      .insert(orderWarehouseTransfers)
      .values({
        orderId: order.id,
        fromWarehouseId: order.fulfillmentWarehouseId,
        toWarehouseId: input.targetWarehouseId,
        reason: input.reason,
        transferredByUserId: input.actor.id,
      })
      .returning({ id: orderWarehouseTransfers.id })

    await recordAuditEvent(tx, {
      action: ORDER_WAREHOUSE_TRANSFER_AUDIT_ACTION,
      entity: "Order",
      entityId: order.id,
      actor: input.actor,
      organizationId: order.organizationId,
      branchId: order.branchId,
      before: { fulfillmentWarehouseId: order.fulfillmentWarehouseId, warehouseCode: source?.code ?? null },
      after: { fulfillmentWarehouseId: input.targetWarehouseId, warehouseCode: target?.code ?? null },
      context: {
        tid: order.tid,
        transferId: transfer.id,
        reason: input.reason,
        status: order.status,
        fulfillmentStatus: order.fulfillmentStatus,
      },
    })

    // The accounts that lost the order are told to stop; the ones that gained
    // it are told it is theirs. Anyone in both keeps working it and is told
    // nothing.
    const after = await loadWarehouseOrderRecipients(tx, order.id)
    const beforeIds = new Set(before.map((recipient) => recipient.id))
    const afterIds = new Set(after.map((recipient) => recipient.id))
    const notificationOrder = { id: order.id, tid: order.tid, organizationId: order.organizationId, branchId: order.branchId }
    const out = await queueWarehouseOrderNotifications(tx, {
      order: notificationOrder,
      event: "TRANSFERRED_OUT",
      occurrence: transfer.id,
      recipients: before.filter((recipient) => !afterIds.has(recipient.id)),
    })
    const into = await queueWarehouseOrderNotifications(tx, {
      order: notificationOrder,
      event: "TRANSFERRED_IN",
      occurrence: transfer.id,
      recipients: after.filter((recipient) => !beforeIds.has(recipient.id)),
    })
    eventKeys = [...out.eventKeys, ...into.eventKeys]

    return {
      kind: "transferred",
      transferId: transfer.id,
      fromWarehouseId: order.fulfillmentWarehouseId,
      toWarehouseId: input.targetWarehouseId,
    }
  })

  await attemptImmediateOrderEmailDelivery(eventKeys)
  return outcome
}
