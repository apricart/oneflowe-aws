import "server-only"

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  auditLogs,
  branches,
  globalProducts,
  groupOrders,
  groups,
  notifications,
  orderItems,
  orders,
  refundItems,
  refunds,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import { calculateLineCents, formatQuantity, roundQuantity, validateProductQuantity } from "@/lib/quantity"
import { UNGROUPED_BUCKET_NAME } from "@/lib/server/group-order-portal"
import {
  MAX_ITEMS_PER_REFUNDED_ORDER,
  OUT_OF_SCOPE_REASON,
  getRequesterRefundBlockReason,
  remainingRefundableCents,
  remainingRefundableQuantity,
} from "@/lib/server/group-refund-rules"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * Refunds raised from the Group Order Portal.
 *
 * A group order is not a new kind of order — it is one ordinary branch order
 * per branch under a shared envelope — so a group refund is not a new kind of
 * refund either. This module turns one submission into the same PENDING
 * `refunds` rows the single-order endpoint creates, one per branch order, which
 * is what lets them reach the existing Super Admin queue, approval path, and
 * reporting untouched. Nothing here approves anything: only a Super Admin does
 * that, through the admin routes that already exist.
 *
 * Scoping is not optional and is applied at every step. Every read and every
 * write is pinned to the caller's own user id, their organization, a group
 * order they created, and their live branch assignments. An empty branch scope
 * means no access and is never widened into "the whole tenant".
 */

/** Refund states that consume refundable capacity. */
const LIVE_REFUND_STATUSES = ["PENDING", "APPROVED", "COMPLETED"]
const SETTLED_REFUND_STATUSES = new Set(["APPROVED", "COMPLETED"])
const PENDING_STATUS = "PENDING"

const CONFLICT_MESSAGE =
  "This order changed while the request was being processed. Refresh and try again."

export type RequesterRefundScope = {
  userId: string
  organizationId: number
}

export type RefundableLine = {
  orderItemId: number
  productName: string
  productCode: string | null
  unit: string | null
  globalProductId: number
  priceCents: number
  quantityOrdered: number
  quantityRemaining: number
  allowDecimalQuantity: boolean
  quantityStep: number | null
}

export type RefundableOrder = {
  orderId: number
  tid: string
  branchId: number
  branchName: string
  status: string
  fulfillmentStatus: string
  totalCents: number
  remainingRefundableCents: number
  createdAt: Date | null
  lines: RefundableLine[]
}

export type IneligibleOrder = {
  orderId: number
  tid: string
  branchId: number
  branchName: string
  status: string
  fulfillmentStatus: string
  reason: string
}

export type GroupRefundWorkspace = {
  groupOrder: { id: number; reference: string; groupName: string; createdAt: Date | null }
  refundable: RefundableOrder[]
  ineligible: IneligibleOrder[]
}

type ChildOrderRow = {
  id: number
  tid: string
  branchId: number
  branchName: string | null
  status: string
  fulfillmentStatus: string
  totalCents: number
  refundAmountCents: number | null
  createdAt: Date | null
}

type OrderItemRow = typeof orderItems.$inferSelect
type QuantityRule = { allowDecimalQuantity: boolean; quantityStep: number | null }

/** Refund pressure already on a row: settled money, and money awaiting a decision. */
type RefundPressure = { approved: number; pending: number }

const emptyPressure = (): RefundPressure => ({ approved: 0, pending: 0 })

function accumulatePressure(bucket: RefundPressure, status: string, amount: number): void {
  if (status === PENDING_STATUS) {
    bucket.pending += amount
  } else if (SETTLED_REFUND_STATUSES.has(status)) {
    bucket.approved += amount
  }
}

function indexPressure(
  rows: Array<{ key: number; status: string; amount: number }>,
): Map<number, RefundPressure> {
  const index = new Map<number, RefundPressure>()
  for (const row of rows) {
    const bucket = index.get(row.key) ?? emptyPressure()
    accumulatePressure(bucket, row.status, row.amount)
    index.set(row.key, bucket)
  }
  return index
}

/**
 * The group order, only if this user created it inside this tenant. Any other
 * combination reads as "not found" rather than "forbidden", so this cannot be
 * used to probe for group orders belonging to somebody else.
 */
async function loadOwnedGroupOrder(scope: RequesterRefundScope, groupOrderId: number) {
  const [envelope] = await db
    .select({
      id: groupOrders.id,
      reference: groupOrders.reference,
      createdAt: groupOrders.createdAt,
      groupName: groups.name,
    })
    .from(groupOrders)
    .leftJoin(groups, and(
      eq(groupOrders.groupId, groups.id),
      eq(groups.organizationId, groupOrders.organizationId),
    ))
    .where(and(
      eq(groupOrders.id, groupOrderId),
      eq(groupOrders.createdByUserId, scope.userId),
      eq(groupOrders.organizationId, scope.organizationId),
    ))
    .limit(1)

  return envelope ?? null
}

/** The branch orders under one envelope, re-pinned to the creator and tenant. */
async function loadChildOrders(
  scope: RequesterRefundScope,
  groupOrderId: number,
): Promise<ChildOrderRow[]> {
  return db
    .select({
      id: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      totalCents: orders.totalCents,
      refundAmountCents: orders.refundAmountCents,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      eq(orders.groupOrderId, groupOrderId),
      eq(orders.organizationId, scope.organizationId),
      eq(orders.createdByUserId, scope.userId),
    ))
    .orderBy(orders.branchId)
}

/** Refund money already booked against each of the given orders. */
async function loadRefundPressureByOrder(orderIds: number[]): Promise<Map<number, RefundPressure>> {
  if (orderIds.length === 0) return new Map()

  const rows = await db
    .select({ orderId: refunds.orderId, amountCents: refunds.amountCents, status: refunds.status })
    .from(refunds)
    .where(inArray(refunds.orderId, orderIds))

  return indexPressure(rows.map((row) => ({
    key: row.orderId,
    status: row.status,
    amount: Number(row.amountCents || 0),
  })))
}

/** Refund quantity already booked against each order line. */
async function loadRefundPressureByItem(orderIds: number[]): Promise<Map<number, RefundPressure>> {
  if (orderIds.length === 0) return new Map()

  const rows = await db
    .select({
      orderItemId: refundItems.orderItemId,
      quantity: refundItems.quantity,
      status: refunds.status,
    })
    .from(refundItems)
    .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
    .where(inArray(refunds.orderId, orderIds))

  return indexPressure(rows.map((row) => ({
    key: row.orderItemId,
    status: row.status,
    amount: Number(row.quantity || 0),
  })))
}

/** Per-product quantity rules, so a decimal or stepped unit is honoured on refunds too. */
async function loadQuantityRules(productIds: number[]): Promise<Map<number, QuantityRule>> {
  if (productIds.length === 0) return new Map()

  const rows = await db
    .select({
      id: globalProducts.id,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
    })
    .from(globalProducts)
    .where(inArray(globalProducts.id, productIds))

  return new Map(rows.map((rule) => [rule.id, {
    allowDecimalQuantity: Boolean(rule.allowDecimalQuantity),
    quantityStep: rule.quantityStep === null ? null : Number(rule.quantityStep),
  }]))
}

function toIneligible(child: ChildOrderRow, reason: string): IneligibleOrder {
  return {
    orderId: child.id,
    tid: child.tid,
    branchId: child.branchId,
    branchName: child.branchName ?? `Branch ${child.branchId}`,
    status: child.status,
    fulfillmentStatus: child.fulfillmentStatus,
    reason,
  }
}

/**
 * Why this child order cannot be refunded right now, or null when it can.
 * The branch scope is checked first: an assignment that has been taken away
 * closes the branch immediately, whatever state the order itself is in.
 */
function blockReasonForChild(
  child: ChildOrderRow,
  scopedBranchIds: Set<number>,
  remainingCents: number,
  now: Date,
): string | null {
  if (!scopedBranchIds.has(child.branchId)) return OUT_OF_SCOPE_REASON
  return getRequesterRefundBlockReason({
    status: child.status,
    fulfillmentStatus: child.fulfillmentStatus,
    createdAt: child.createdAt,
    remainingRefundableCents: remainingCents,
    now,
  })
}

function buildRefundableLines(
  rows: OrderItemRow[],
  itemPressure: Map<number, RefundPressure>,
  quantityRules: Map<number, QuantityRule>,
): RefundableLine[] {
  return rows
    .map((row) => {
      const pressure = itemPressure.get(row.id) ?? emptyPressure()
      const rule = quantityRules.get(row.globalProductId)
      const quantityOrdered = Number(row.quantity || 0)
      return {
        orderItemId: row.id,
        productName: row.productName,
        productCode: row.productCode ?? null,
        unit: row.unit ?? null,
        globalProductId: row.globalProductId,
        priceCents: Number(row.priceCents || 0),
        quantityOrdered,
        quantityRemaining: remainingRefundableQuantity({
          quantityOrdered,
          quantityApproved: pressure.approved,
          quantityPending: pressure.pending,
        }),
        allowDecimalQuantity: rule?.allowDecimalQuantity ?? false,
        quantityStep: rule?.quantityStep ?? null,
      }
    })
    .filter((line) => line.quantityRemaining > 0)
}

function groupItemsByOrder(rows: OrderItemRow[]): Map<number, OrderItemRow[]> {
  const byOrder = new Map<number, OrderItemRow[]>()
  for (const row of rows) {
    const bucket = byOrder.get(row.orderId) ?? []
    bucket.push(row)
    byOrder.set(row.orderId, bucket)
  }
  return byOrder
}

/**
 * Everything the refund screen needs for one group order: which branch orders
 * can still be refunded and by how much, and — just as importantly — why each
 * of the others cannot be.
 *
 * Returns null when the group order is not this user's, which the routes turn
 * into a 404.
 */
export async function loadGroupRefundWorkspace({
  userId,
  organizationId,
  groupOrderId,
  now = new Date(),
}: RequesterRefundScope & { groupOrderId: number; now?: Date }): Promise<GroupRefundWorkspace | null> {
  const scope = { userId, organizationId }
  const envelope = await loadOwnedGroupOrder(scope, groupOrderId)
  if (!envelope) return null

  const groupOrder = {
    id: envelope.id,
    reference: envelope.reference,
    groupName: envelope.groupName ?? UNGROUPED_BUCKET_NAME,
    createdAt: envelope.createdAt,
  }

  const children = await loadChildOrders(scope, groupOrderId)
  if (children.length === 0) return { groupOrder, refundable: [], ineligible: [] }

  const orderIds = children.map((child) => child.id)
  const [scopedBranchIds, orderPressure, itemPressure, itemRows] = await Promise.all([
    resolveScopedBranchIds(db, userId).then((ids) => new Set(ids)),
    loadRefundPressureByOrder(orderIds),
    loadRefundPressureByItem(orderIds),
    db.select().from(orderItems).where(inArray(orderItems.orderId, orderIds)),
  ])
  const quantityRules = await loadQuantityRules([...new Set(itemRows.map((row) => row.globalProductId))])
  const itemsByOrder = groupItemsByOrder(itemRows)

  const refundable: RefundableOrder[] = []
  const ineligible: IneligibleOrder[] = []

  for (const child of children) {
    const pressure = orderPressure.get(child.id) ?? emptyPressure()
    const remainingCents = remainingRefundableCents({
      orderTotalCents: Number(child.totalCents || 0),
      approvedRefundCents: pressure.approved,
      pendingRefundCents: pressure.pending,
      orderRefundAmountCents: Number(child.refundAmountCents || 0),
    })

    const blocked = blockReasonForChild(child, scopedBranchIds, remainingCents, now)
    if (blocked) {
      ineligible.push(toIneligible(child, blocked))
      continue
    }

    const lines = buildRefundableLines(itemsByOrder.get(child.id) ?? [], itemPressure, quantityRules)
    if (lines.length === 0) {
      ineligible.push(toIneligible(child, "Every item on this order has already been requested or refunded."))
      continue
    }

    refundable.push({
      orderId: child.id,
      tid: child.tid,
      branchId: child.branchId,
      branchName: child.branchName ?? `Branch ${child.branchId}`,
      status: child.status,
      fulfillmentStatus: child.fulfillmentStatus,
      totalCents: Number(child.totalCents || 0),
      remainingRefundableCents: remainingCents,
      createdAt: child.createdAt,
      lines,
    })
  }

  return { groupOrder, refundable, ineligible }
}

export type RequestedRefundOrder = {
  orderId: number
  items: Array<{ id: number; quantity: number }>
}

export type GroupRefundOrderResult =
  | {
    status: "requested"
    orderId: number
    tid: string
    branchName: string
    refundId: number
    refundNumber: string
    amountCents: number
    itemCount: number
  }
  | {
    status: "skipped"
    orderId: number
    tid: string
    branchName: string
    reason: string
  }

export type GroupRefundSubmission = {
  reference: string
  requestedOrderCount: number
  skippedOrderCount: number
  totalAmountCents: number
  results: GroupRefundOrderResult[]
}

/** One priced refund line, resolved against the authoritative order data. */
type PricedLine = { orderItemId: number; productName: string; quantity: number; amountCents: number }

type PreparedOrder = {
  order: RefundableOrder
  lines: PricedLine[]
  totalCents: number
}

/**
 * Price one order's requested lines against the workspace the server has just
 * built for itself. Nothing in the request body is trusted beyond "which line,
 * how much": the unit price, the ordered quantity, and the remaining quantity
 * all come from the database read, never from the client.
 */
type PricingResult =
  | { ok: true; prepared: PreparedOrder }
  | { ok: false; reason: string }

function priceRequestedLines(
  order: RefundableOrder,
  items: Array<{ id: number; quantity: number }>,
): PricingResult {
  if (items.length > MAX_ITEMS_PER_REFUNDED_ORDER) {
    return { ok: false, reason: `An order can carry at most ${MAX_ITEMS_PER_REFUNDED_ORDER} refund lines.` }
  }

  const lineById = new Map(order.lines.map((line) => [line.orderItemId, line]))
  const priced: PricedLine[] = []

  for (const item of items) {
    const line = lineById.get(item.id)
    if (!line) return { ok: false, reason: "One or more selected items are not refundable on this order." }

    const validation = validateProductQuantity(item.quantity, {
      allowDecimalQuantity: line.allowDecimalQuantity,
      quantityStep: line.quantityStep,
      label: `Refund quantity for ${line.productName}`,
    })
    if (!validation.ok) return { ok: false, reason: validation.error }

    if (roundQuantity(validation.quantity) > line.quantityRemaining) {
      return {
        ok: false,
        reason: `Only ${formatQuantity(line.quantityRemaining)} of ${line.productName} is still refundable.`,
      }
    }

    priced.push({
      orderItemId: line.orderItemId,
      productName: line.productName,
      quantity: validation.quantity,
      amountCents: calculateLineCents(line.priceCents, validation.quantity),
    })
  }

  const totalCents = priced.reduce((sum, line) => sum + line.amountCents, 0)
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
    return { ok: false, reason: "The selected quantities do not add up to a refundable amount." }
  }
  if (totalCents > order.remainingRefundableCents) {
    return { ok: false, reason: "The selected quantities exceed this order's remaining refundable amount." }
  }

  return { ok: true, prepared: { order, lines: priced, totalCents } }
}

/**
 * Re-check inside the write transaction what was checked during the read.
 *
 * The workspace read and the write are separate statements, so an approval, a
 * competing refund, or a scope change can land between them. Re-reading the
 * locked order and its live refund rows here is what makes the earlier decision
 * safe to act on; anything that no longer holds throws, and that branch order
 * is skipped rather than written.
 */
async function assertStillRefundable(tx: any, prepared: PreparedOrder, now: Date): Promise<void> {
  const [locked] = await tx
    .select({
      id: orders.id,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      totalCents: orders.totalCents,
      refundAmountCents: orders.refundAmountCents,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.id, prepared.order.orderId))
    .for("update")

  if (!locked) throw new Error(CONFLICT_MESSAGE)

  const liveRefunds = await tx
    .select({ amountCents: refunds.amountCents, status: refunds.status })
    .from(refunds)
    .where(eq(refunds.orderId, prepared.order.orderId))

  const pressure = emptyPressure()
  for (const row of liveRefunds) {
    accumulatePressure(pressure, row.status, Number(row.amountCents || 0))
  }

  const remainingCents = remainingRefundableCents({
    orderTotalCents: Number(locked.totalCents || 0),
    approvedRefundCents: pressure.approved,
    pendingRefundCents: pressure.pending,
    orderRefundAmountCents: Number(locked.refundAmountCents || 0),
  })

  const blocked = getRequesterRefundBlockReason({
    status: locked.status,
    fulfillmentStatus: locked.fulfillmentStatus,
    createdAt: locked.createdAt,
    remainingRefundableCents: remainingCents,
    now,
  })
  if (blocked || prepared.totalCents > remainingCents) throw new Error(CONFLICT_MESSAGE)

  await assertLineQuantitiesStillAvailable(tx, prepared)
}

async function assertLineQuantitiesStillAvailable(tx: any, prepared: PreparedOrder): Promise<void> {
  const liveLines = await tx
    .select({
      orderItemId: refundItems.orderItemId,
      quantity: refundItems.quantity,
    })
    .from(refundItems)
    .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
    .where(and(
      eq(refunds.orderId, prepared.order.orderId),
      inArray(refunds.status, LIVE_REFUND_STATUSES),
    ))

  const takenByItem = new Map<number, number>()
  for (const line of liveLines) {
    takenByItem.set(
      line.orderItemId,
      roundQuantity((takenByItem.get(line.orderItemId) ?? 0) + Number(line.quantity || 0)),
    )
  }

  const orderedByItem = new Map(prepared.order.lines.map((line) => [line.orderItemId, line.quantityOrdered]))
  for (const line of prepared.lines) {
    // Rounded on the same scale the quantities are stored at, so float drift in
    // the subtraction cannot reject a request for exactly what is left.
    const stillAvailable = remainingRefundableQuantity({
      quantityOrdered: orderedByItem.get(line.orderItemId) ?? 0,
      quantityApproved: takenByItem.get(line.orderItemId) ?? 0,
      quantityPending: 0,
    })
    if (roundQuantity(line.quantity) > stillAvailable) {
      throw new Error(CONFLICT_MESSAGE)
    }
  }
}

/**
 * Record one branch order's refund request. Always PENDING: this role asks, it
 * never decides, so no budget is released and no order status moves here. A
 * Super Admin approving the request through the existing admin route is what
 * performs those effects, exactly as for a single-order request.
 */
async function insertRefundRequest(
  tx: any,
  input: {
    prepared: PreparedOrder
    scope: RequesterRefundScope
    reference: string
    reason: string
  },
): Promise<{ refundId: number; refundNumber: string }> {
  const { prepared, scope, reference, reason } = input

  const [inserted] = await tx
    .insert(refunds)
    .values({
      organizationId: scope.organizationId,
      orderId: prepared.order.orderId,
      amountCents: prepared.totalCents,
      reason,
      status: PENDING_STATUS,
      requestedByUserId: scope.userId,
    })
    .returning({ id: refunds.id })

  const refundNumber = `Refund-${String(inserted.id).padStart(6, "0")}`
  await tx.update(refunds).set({ refundNumber }).where(eq(refunds.id, inserted.id))

  await tx.insert(refundItems).values(prepared.lines.map((line) => ({
    refundId: inserted.id,
    orderItemId: line.orderItemId,
    quantity: line.quantity,
    amountCents: line.amountCents,
  })))

  await tx.insert(auditLogs).values({
    userId: scope.userId,
    organizationId: scope.organizationId,
    branchId: prepared.order.branchId,
    action: "REFUND_REQUESTED",
    entity: "Order",
    entityId: String(prepared.order.orderId),
    metadata: {
      tid: prepared.order.tid,
      amountCents: prepared.totalCents,
      reason,
      groupOrderReference: reference,
      items: prepared.lines,
    },
  })

  return { refundId: inserted.id, refundNumber }
}

function skipResult(
  order: { orderId: number; tid: string; branchName: string },
  reason: string,
): GroupRefundOrderResult {
  return {
    status: "skipped",
    orderId: order.orderId,
    tid: order.tid,
    branchName: order.branchName,
    reason,
  }
}

/**
 * Resolve each requested order to either a priced, still-eligible submission or
 * a skip carrying the reason the user should see. Nothing is written here.
 */
function prepareRequestedOrders(
  workspace: GroupRefundWorkspace,
  requested: RequestedRefundOrder[],
): { prepared: PreparedOrder[]; skipped: GroupRefundOrderResult[] } {
  const refundableById = new Map(workspace.refundable.map((order) => [order.orderId, order]))
  const ineligibleById = new Map(workspace.ineligible.map((order) => [order.orderId, order]))

  const prepared: PreparedOrder[] = []
  const skipped: GroupRefundOrderResult[] = []

  for (const request of requested) {
    const refundable = refundableById.get(request.orderId)
    if (!refundable) {
      const ineligible = ineligibleById.get(request.orderId)
      skipped.push(ineligible
        ? skipResult(ineligible, ineligible.reason)
        : skipResult(
          { orderId: request.orderId, tid: `Order ${request.orderId}`, branchName: "Unknown branch" },
          "This order is not part of the selected group order.",
        ))
      continue
    }

    const priced = priceRequestedLines(refundable, request.items)
    if (!priced.ok) {
      skipped.push(skipResult(refundable, priced.reason))
      continue
    }
    prepared.push(priced.prepared)
  }

  return { prepared, skipped }
}

/**
 * A single notification per Super Admin describing the whole submission, rather
 * than one per branch order. The refunds themselves are ordinary rows, so they
 * still appear individually in the existing refund queue either way.
 */
async function notifySuperAdmins(input: { organizationId: number; message: string }): Promise<void> {
  const recipients = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(roles.name, "SUPER_ADMIN"),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))

  if (recipients.length === 0) return

  await db.insert(notifications).values(recipients.map((recipient) => ({
    userId: recipient.id,
    organizationId: input.organizationId,
    type: "REFUND_REQUESTED",
    targetRole: "SUPER_ADMIN",
    message: input.message,
  })))
}

export type GroupRefundNotice = { organizationId: number; message: string }

export type GroupRefundOutcome =
  | { ok: true; submission: GroupRefundSubmission; notice: GroupRefundNotice }
  | { ok: false; status: number; message: string }

function firstSkipReason(skipped: GroupRefundOrderResult[]): string {
  const first = skipped[0]
  return first?.status === "skipped"
    ? first.reason
    : "None of the selected orders can be refunded right now."
}

async function writeOneRequest(
  entry: PreparedOrder,
  context: { scope: RequesterRefundScope; reference: string; reason: string; now: Date; groupOrderId: number },
): Promise<GroupRefundOrderResult> {
  try {
    const written = await db.transaction(async (tx) => {
      await assertStillRefundable(tx, entry, context.now)
      return insertRefundRequest(tx, {
        prepared: entry,
        scope: context.scope,
        reference: context.reference,
        reason: context.reason,
      })
    })

    return {
      status: "requested",
      orderId: entry.order.orderId,
      tid: entry.order.tid,
      branchName: entry.order.branchName,
      refundId: written.refundId,
      refundNumber: written.refundNumber,
      amountCents: entry.totalCents,
      itemCount: entry.lines.length,
    }
  } catch (writeError) {
    // Per-branch failures are reported back to the user, but never verbatim:
    // only the conflict message this module raises itself is passed through, so
    // a driver or constraint message can never reach the browser.
    console.error("[GroupRefunds] Branch refund request failed", {
      orderId: entry.order.orderId,
      groupOrderId: context.groupOrderId,
      error: writeError instanceof Error ? writeError.message : "unknown",
    })
    return skipResult(
      entry.order,
      writeError instanceof Error && writeError.message === CONFLICT_MESSAGE
        ? CONFLICT_MESSAGE
        : "This refund request could not be recorded. Please try again.",
    )
  }
}

/**
 * Submit one group refund request.
 *
 * Each branch order is written in its own transaction, mirroring how the group
 * order itself was created: one branch failing its re-check never discards the
 * requests that succeeded elsewhere, and the caller is told exactly which
 * branches were skipped and why.
 */
export async function createGroupRefundRequests({
  userId,
  organizationId,
  groupOrderId,
  reason,
  requestedOrders,
  now = new Date(),
}: RequesterRefundScope & {
  groupOrderId: number
  reason: string
  requestedOrders: RequestedRefundOrder[]
  now?: Date
}): Promise<GroupRefundOutcome> {
  const scope = { userId, organizationId }
  const workspace = await loadGroupRefundWorkspace({ userId, organizationId, groupOrderId, now })
  if (!workspace) return { ok: false, status: 404, message: "Group order not found" }

  const { prepared, skipped } = prepareRequestedOrders(workspace, requestedOrders)
  if (prepared.length === 0) {
    return { ok: false, status: 400, message: firstSkipReason(skipped) }
  }

  const results: GroupRefundOrderResult[] = [...skipped]
  for (const entry of prepared) {
    results.push(await writeOneRequest(entry, {
      scope,
      reference: workspace.groupOrder.reference,
      reason,
      now,
      groupOrderId,
    }))
  }

  const written = results.filter((result) => result.status === "requested")
  if (written.length === 0) {
    return { ok: false, status: 409, message: CONFLICT_MESSAGE }
  }

  const totalAmountCents = written.reduce(
    (sum, result) => sum + (result.status === "requested" ? result.amountCents : 0),
    0,
  )

  return {
    ok: true,
    submission: {
      reference: workspace.groupOrder.reference,
      requestedOrderCount: written.length,
      skippedOrderCount: results.length - written.length,
      totalAmountCents,
      results,
    },
    notice: {
      organizationId,
      message: `Refund request for group order ${workspace.groupOrder.reference}: PKR ${(totalAmountCents / 100).toFixed(2)} across ${written.length} branch order${written.length === 1 ? "" : "s"}`,
    },
  }
}

/**
 * Announce a recorded submission to the Super Admins. Deliberately separate
 * from the write and deliberately non-throwing: the requests are already in the
 * admin queue, so a notification failure must not turn a successful submission
 * into an error the user is asked to retry.
 */
export async function publishGroupRefundNotice(notice: GroupRefundNotice): Promise<void> {
  try {
    await notifySuperAdmins(notice)
  } catch (notifyError) {
    console.error("[GroupRefunds] Failed to notify super admins", notifyError)
  }
}

export const GROUP_REFUND_HISTORY_PAGE_SIZE_DEFAULT = 10
export const GROUP_REFUND_HISTORY_PAGE_SIZE_MAX = 50

export type GroupRefundHistoryEntry = {
  refundId: number
  refundNumber: string | null
  status: string
  amountCents: number
  reason: string | null
  createdAt: Date | null
  orderId: number
  tid: string
  branchId: number
  branchName: string
  items: Array<{
    orderItemId: number
    productName: string
    unit: string | null
    quantity: number
    amountCents: number
  }>
}

export type GroupRefundHistoryItem = {
  groupOrderId: number
  reference: string
  groupName: string
  createdAt: Date | null
  totalAmountCents: number
  statusCounts: Record<string, number>
  refunds: GroupRefundHistoryEntry[]
}

export type GroupRefundHistoryPage = {
  items: GroupRefundHistoryItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean }
}

async function loadHistoryItems(refundIds: number[]) {
  if (refundIds.length === 0) return new Map<number, GroupRefundHistoryEntry["items"]>()

  const rows = await db
    .select({
      refundId: refundItems.refundId,
      orderItemId: refundItems.orderItemId,
      quantity: refundItems.quantity,
      amountCents: refundItems.amountCents,
      productName: orderItems.productName,
      unit: orderItems.unit,
    })
    .from(refundItems)
    .innerJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
    .where(inArray(refundItems.refundId, refundIds))

  const byRefund = new Map<number, GroupRefundHistoryEntry["items"]>()
  for (const row of rows) {
    const bucket = byRefund.get(row.refundId) ?? []
    bucket.push({
      orderItemId: row.orderItemId,
      productName: row.productName,
      unit: row.unit ?? null,
      quantity: Number(row.quantity || 0),
      amountCents: Number(row.amountCents || 0),
    })
    byRefund.set(row.refundId, bucket)
  }
  return byRefund
}

/**
 * The scope every history read is built on: refunds this user raised, against
 * orders this user created, under group orders this user created, all inside
 * their own tenant.
 *
 * `refunds` carries no group column and does not need one: a refund reaches its
 * envelope through the order it was raised against, which already carries
 * `groupOrderId`. Every clause here re-asserts both the creator and the tenant,
 * so this cannot become a second, weaker route to another user's refund data.
 */
function refundHistoryScope({ userId, organizationId }: RequesterRefundScope) {
  return and(
    eq(refunds.requestedByUserId, userId),
    eq(refunds.organizationId, organizationId),
    eq(orders.createdByUserId, userId),
    eq(orders.organizationId, organizationId),
    eq(groupOrders.createdByUserId, userId),
    eq(groupOrders.organizationId, organizationId),
  )
}

/**
 * One page of group orders that carry at least one of this user's refunds,
 * ordered by their most recent refund.
 *
 * The page is taken over envelopes in the database rather than over refund rows
 * in memory. Paging a capped row scan made both the totals and the page count
 * describe only the rows that happened to fit under the cap, so a user with a
 * long refund history was told there was less of it than there is.
 */
async function loadRefundHistoryEnvelopeIds(
  scope: RequesterRefundScope,
  page: number,
  limit: number,
): Promise<{ ids: number[]; total: number }> {
  const where = refundHistoryScope(scope)

  const [[countRow], pageRows] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(DISTINCT ${groupOrders.id})::int`.mapWith(Number) })
      .from(refunds)
      .innerJoin(orders, eq(refunds.orderId, orders.id))
      .innerJoin(groupOrders, eq(orders.groupOrderId, groupOrders.id))
      .where(where),
    db
      .select({ groupOrderId: groupOrders.id })
      .from(refunds)
      .innerJoin(orders, eq(refunds.orderId, orders.id))
      .innerJoin(groupOrders, eq(orders.groupOrderId, groupOrders.id))
      .where(where)
      .groupBy(groupOrders.id)
      .orderBy(desc(sql`MAX(${refunds.createdAt})`), desc(groupOrders.id))
      .limit(limit)
      .offset((page - 1) * limit),
  ])

  return {
    ids: pageRows.map((row) => row.groupOrderId),
    total: Number(countRow?.total ?? 0),
  }
}

/**
 * The refund requests this user has raised against their own group orders,
 * newest first, rolled up under the group order they belong to.
 *
 * The envelope page is resolved first and the refunds are then read for exactly
 * those envelopes, so each rolled-up total covers every refund on its group
 * order rather than only the ones a row cap happened to reach. The row set is
 * bounded by the page size and by the branch limit one submission may fan out
 * to, so it needs no cap of its own.
 */
export async function listGroupRefundHistory({
  userId,
  organizationId,
  page,
  limit,
}: RequesterRefundScope & { page: number; limit: number }): Promise<GroupRefundHistoryPage> {
  const scope = { userId, organizationId }
  const { ids: envelopeIds, total } = await loadRefundHistoryEnvelopeIds(scope, page, limit)

  const pagination = {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total,
  }
  if (envelopeIds.length === 0) return { items: [], pagination }

  const rows = await db
    .select({
      refundId: refunds.id,
      refundNumber: refunds.refundNumber,
      status: refunds.status,
      amountCents: refunds.amountCents,
      reason: refunds.reason,
      createdAt: refunds.createdAt,
      orderId: orders.id,
      tid: orders.tid,
      branchId: orders.branchId,
      branchName: branches.name,
      groupOrderId: groupOrders.id,
      reference: groupOrders.reference,
      groupName: groups.name,
      groupCreatedAt: groupOrders.createdAt,
    })
    .from(refunds)
    .innerJoin(orders, eq(refunds.orderId, orders.id))
    .innerJoin(groupOrders, eq(orders.groupOrderId, groupOrders.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, and(
      eq(groupOrders.groupId, groups.id),
      eq(groups.organizationId, groupOrders.organizationId),
    ))
    // The ids came from the same scoped query, and the scope is re-asserted
    // here so this read never stands on the id list alone.
    .where(and(refundHistoryScope(scope), inArray(groupOrders.id, envelopeIds)))
    .orderBy(desc(refunds.createdAt))

  const itemsByRefund = await loadHistoryItems(rows.map((row) => row.refundId))

  const grouped = new Map<number, GroupRefundHistoryItem>()
  for (const row of rows) {
    const envelope = grouped.get(row.groupOrderId) ?? {
      groupOrderId: row.groupOrderId,
      reference: row.reference,
      groupName: row.groupName ?? UNGROUPED_BUCKET_NAME,
      createdAt: row.groupCreatedAt,
      totalAmountCents: 0,
      statusCounts: {},
      refunds: [],
    }
    const status = String(row.status || PENDING_STATUS).toUpperCase()
    envelope.totalAmountCents += Number(row.amountCents || 0)
    envelope.statusCounts[status] = (envelope.statusCounts[status] ?? 0) + 1
    envelope.refunds.push({
      refundId: row.refundId,
      refundNumber: row.refundNumber,
      status,
      amountCents: Number(row.amountCents || 0),
      reason: row.reason,
      createdAt: row.createdAt,
      orderId: row.orderId,
      tid: row.tid,
      branchId: row.branchId,
      branchName: row.branchName ?? `Branch ${row.branchId}`,
      items: itemsByRefund.get(row.refundId) ?? [],
    })
    grouped.set(row.groupOrderId, envelope)
  }

  // Rendered in the order the page was resolved in, so the newest refund
  // activity stays first however the rows came back.
  const items = envelopeIds
    .map((envelopeId) => grouped.get(envelopeId))
    .filter((envelope): envelope is GroupRefundHistoryItem => envelope !== undefined)

  return { items, pagination }
}
