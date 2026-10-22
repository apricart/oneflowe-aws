import "server-only"

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"

import {
  branchDeliveryAddresses,
  branches,
  orderDeliveryChallans,
  orderItems,
  orders,
  organizations,
} from "@/db/schema"
import { db } from "@/lib/db"
import { DELIVERY_HEALTH_LABELS, assessDelivery } from "@/lib/delivery-sla"
import { FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { FULFILLED_ORDER_STATUSES } from "@/lib/order-delivery-status"
import { escapeLikePattern } from "@/lib/utils"
import { lineAmountCents, parseRouteId, warehouseNextStage, type WarehouseOrderListQuery } from "@/lib/warehouse-orders"
import { listDeliveryChallans } from "@/lib/server/delivery-challan"
import { loadWarehouseOrderInReach, loadWarehouseReach } from "@/lib/server/warehouse-scope"

/**
 * The warehouse's reads: its queue and one order's picking sheet.
 *
 * The fence is the user's branch reach, re-read on every call
 * (`loadWarehouseReach`), plus the branch belonging to the order's own
 * organization. Prices and invoice figures are included — the warehouse may
 * see them (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md, revision
 * 2026-10-07) — but no person behind the order: no creator, approver or
 * phone of a requester.
 */

const orderStatus = sql`UPPER(${orders.status})`
const stage = sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`
const fulfilledStatuses = sql.join(FULFILLED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)
const invoiceNumber = sql<string | null>`${orders.receiptData}->>'invoiceNumber'`

/** Approved work, open or done: never a pending, rejected, cancelled or refunded order. */
const workStatus = sql`(${orderStatus} = 'APPROVED' OR ${orderStatus} IN (${fulfilledStatuses}))`
const isDelivered = sql`(${stage} = 'DELIVERED' OR ${orderStatus} IN (${fulfilledStatuses}))`

const DAY_MS = 24 * 60 * 60 * 1000

function reachConditions(branchIds: number[]): SQL {
  return and(
    inArray(orders.branchId, branchIds),
    // The branch row must belong to the order's own tenant, as everywhere else.
    eq(branches.organizationId, orders.organizationId),
    workStatus,
  )!
}

function filterConditions(query: WarehouseOrderListQuery, now: Date): SQL[] {
  const conditions: SQL[] = []
  if (query.view === "open") conditions.push(sql`(${orderStatus} = 'APPROVED' AND NOT ${isDelivered})`)
  if (query.view === "delivered") {
    const since = new Date(now.getTime() - query.deliveredWithinDays * DAY_MS)
    conditions.push(sql`(${isDelivered} AND COALESCE(${orders.deliveredAt}, ${orders.fulfilledAt}) >= ${since})`)
  }
  if (query.stage !== null) conditions.push(sql`${stage} = ${query.stage}`)
  if (query.paymentStatus !== null) conditions.push(eq(orders.paymentStatus, query.paymentStatus))
  if (query.organizationId !== null) conditions.push(eq(orders.organizationId, query.organizationId))
  if (query.branchId !== null) conditions.push(eq(orders.branchId, query.branchId))
  if (query.search) {
    const pattern = `%${escapeLikePattern(query.search)}%`
    const searchedOrderId = parseRouteId(query.search)
    conditions.push(or(
      ...(searchedOrderId === null ? [] : [eq(orders.id, searchedOrderId)]),
      ilike(orders.tid, pattern),
      sql`${invoiceNumber} ILIKE ${pattern}`,
      ilike(branches.name, pattern),
    )!)
  }
  return conditions
}

function orderBy(query: WarehouseOrderListQuery) {
  if (query.view === "delivered") return [sql`COALESCE(${orders.deliveredAt}, ${orders.fulfilledAt}) DESC NULLS LAST`, desc(orders.id)]
  // Newest order first in every view; the Workload tab is where the warehouse
  // reads its work by deadline.
  return [desc(orders.approvedAt), desc(orders.id)]
}

function destinationLabel(row: {
  deliveryAddressLabel: string | null
  deliveryAddressCity: string | null
  branchCity: string | null
}): string {
  if (row.deliveryAddressLabel) {
    return row.deliveryAddressCity ? `${row.deliveryAddressLabel}, ${row.deliveryAddressCity}` : row.deliveryAddressLabel
  }
  return row.branchCity ?? "Branch address"
}

/** Only the order's own approved address, of its own branch, is joined. */
const deliveryAddressJoin = and(
  eq(branchDeliveryAddresses.id, orders.deliveryAddressId),
  eq(branchDeliveryAddresses.branchId, orders.branchId),
)

const listColumns = {
  id: orders.id,
  tid: orders.tid,
  invoiceNumber,
  organizationId: sql<number>`${orders.organizationId}`.mapWith(Number),
  organizationName: organizations.name,
  branchId: orders.branchId,
  branchName: branches.name,
  branchCity: branches.city,
  deliveryAddressLabel: branchDeliveryAddresses.label,
  deliveryAddressCity: branchDeliveryAddresses.city,
  status: orders.status,
  fulfillmentStatus: orders.fulfillmentStatus,
  paymentStatus: orders.paymentStatus,
  totalCents: orders.totalCents,
  refundAmountCents: orders.refundAmountCents,
  notes: orders.notes,
  approvedAt: orders.approvedAt,
  deliveredAt: orders.deliveredAt,
  itemCount: sql<number>`(SELECT COUNT(*) FROM ${orderItems} WHERE ${orderItems.orderId} = ${orders.id})`.mapWith(Number),
  hasChallan: sql<boolean>`EXISTS (
    SELECT 1 FROM ${orderDeliveryChallans}
    WHERE ${orderDeliveryChallans.orderId} = ${orders.id}
      AND ${orderDeliveryChallans.attachedAt} IS NOT NULL
      AND ${orderDeliveryChallans.replacedAt} IS NULL
  )`,
}

type LineRow = {
  orderId: number
  id: number
  productCode: string | null
  productName: string
  unit: string
  quantity: number
  priceCents: number
  taxRateBp: number | null
  taxCents: number
}

async function loadLines(orderIds: number[]): Promise<Map<number, LineRow[]>> {
  const byOrder = new Map<number, LineRow[]>()
  if (orderIds.length === 0) return byOrder
  const rows = await db
    .select({
      orderId: orderItems.orderId,
      id: orderItems.id,
      productCode: orderItems.productCode,
      productName: orderItems.productName,
      unit: orderItems.unit,
      quantity: orderItems.quantity,
      priceCents: orderItems.priceCents,
      taxRateBp: orderItems.taxRateBp,
      taxCents: orderItems.taxCents,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .orderBy(asc(orderItems.orderId), asc(orderItems.id))
  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? []
    list.push(row)
    byOrder.set(row.orderId, list)
  }
  return byOrder
}

function presentLine(line: LineRow) {
  return {
    id: line.id,
    productCode: line.productCode,
    productName: line.productName,
    unit: line.unit,
    quantity: Number(line.quantity),
    priceCents: Number(line.priceCents),
    taxRateBp: line.taxRateBp,
    taxCents: Number(line.taxCents),
    amountCents: lineAmountCents({ priceCents: Number(line.priceCents), quantity: Number(line.quantity) }),
  }
}

function presentDelivery(row: {
  status: string | null
  fulfillmentStatus: string | null
  approvedAt: Date | null
  deliveredAt: Date | null
}, now: Date) {
  const stageKey = normalizeFulfillmentStatus(row.fulfillmentStatus)
  const assessment = assessDelivery(row, now)
  return {
    stage: stageKey,
    stageLabel: FULFILLMENT_STATUS_LABELS[stageKey],
    nextStage: warehouseNextStage(row),
    health: assessment?.health ?? null,
    healthLabel: assessment ? DELIVERY_HEALTH_LABELS[assessment.health] : null,
    promisedAt: assessment?.promisedAt.toISOString() ?? null,
    hoursRemaining: assessment?.hoursRemaining ?? null,
    hoursOverdue: assessment?.hoursOverdue ?? null,
  }
}

export type WarehouseReachOptions = {
  organizations: Array<{ id: number; name: string }>
  branches: Array<{ id: number; name: string; organizationId: number }>
}

async function loadReachOptions(branchIds: number[]): Promise<WarehouseReachOptions> {
  if (branchIds.length === 0) return { organizations: [], branches: [] }
  const rows = await db
    .select({
      id: branches.id,
      name: branches.name,
      organizationId: branches.organizationId,
      organizationName: organizations.name,
    })
    .from(branches)
    .innerJoin(organizations, eq(organizations.id, branches.organizationId))
    .where(inArray(branches.id, branchIds))
    .orderBy(asc(organizations.name), asc(branches.name))
  const organizationsById = new Map<number, string>()
  for (const row of rows) organizationsById.set(row.organizationId, row.organizationName)
  return {
    organizations: [...organizationsById].map(([id, name]) => ({ id, name })),
    branches: rows.map((row) => ({ id: row.id, name: row.name, organizationId: row.organizationId })),
  }
}

export async function listWarehouseOrders(userId: string, query: WarehouseOrderListQuery, now: Date) {
  const branchIds = await loadWarehouseReach(db, userId)
  const reach = await loadReachOptions(branchIds)
  const emptyCounts = { NOT_STARTED: 0, IN_PROCESS: 0, OUT_FOR_DELIVERY: 0, DELIVERED_RECENT: 0 }
  if (branchIds.length === 0) {
    return { items: [], total: 0, page: query.page, limit: query.limit, counts: emptyCounts, reach }
  }

  const base = reachConditions(branchIds)
  const where = and(base, ...filterConditions(query, now))
  const since = new Date(now.getTime() - query.deliveredWithinDays * DAY_MS)

  const [rows, [{ total }], [counts]] = await Promise.all([
    db
      .select(listColumns)
      .from(orders)
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .innerJoin(organizations, eq(organizations.id, orders.organizationId))
      .leftJoin(branchDeliveryAddresses, deliveryAddressJoin)
      .where(where)
      .orderBy(...orderBy(query))
      .limit(query.limit)
      .offset((query.page - 1) * query.limit),
    db
      .select({ total: sql<number>`COUNT(*)`.mapWith(Number) })
      .from(orders)
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(where),
    // The tab counts follow the organization and branch filters but not the
    // view or stage, so every tab shows what it would hold.
    db
      .select({
        NOT_STARTED: sql<number>`COUNT(*) FILTER (WHERE ${orderStatus} = 'APPROVED' AND NOT ${isDelivered} AND ${stage} = 'NOT_STARTED')`.mapWith(Number),
        IN_PROCESS: sql<number>`COUNT(*) FILTER (WHERE ${orderStatus} = 'APPROVED' AND NOT ${isDelivered} AND ${stage} = 'IN_PROCESS')`.mapWith(Number),
        OUT_FOR_DELIVERY: sql<number>`COUNT(*) FILTER (WHERE ${orderStatus} = 'APPROVED' AND NOT ${isDelivered} AND ${stage} = 'OUT_FOR_DELIVERY')`.mapWith(Number),
        DELIVERED_RECENT: sql<number>`COUNT(*) FILTER (WHERE ${isDelivered} AND COALESCE(${orders.deliveredAt}, ${orders.fulfilledAt}) >= ${since})`.mapWith(Number),
      })
      .from(orders)
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(and(
        base,
        query.organizationId === null ? undefined : eq(orders.organizationId, query.organizationId),
        query.branchId === null ? undefined : eq(orders.branchId, query.branchId),
      )),
  ])

  const lines = query.includeLines ? await loadLines(rows.map((row) => row.id)) : null

  return {
    items: rows.map((row) => ({
      id: row.id,
      tid: row.tid,
      invoiceNumber: row.invoiceNumber,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      branchId: row.branchId,
      branchName: row.branchName,
      destination: destinationLabel(row),
      status: row.status,
      paymentStatus: row.paymentStatus,
      totalCents: Number(row.totalCents),
      refundAmountCents: row.refundAmountCents === null ? 0 : Number(row.refundAmountCents),
      notes: row.notes,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      itemCount: row.itemCount,
      hasChallan: Boolean(row.hasChallan),
      ...presentDelivery(row, now),
      ...(lines ? { lines: (lines.get(row.id) ?? []).map(presentLine) } : {}),
    })),
    total,
    page: query.page,
    limit: query.limit,
    counts: counts ?? emptyCounts,
    reach,
  }
}

type ReceiptSnapshot = {
  invoiceNumber?: string
  date?: string
  poNumber?: string
  discount?: number
  deliveryCharges?: number
} | null

/**
 * One order's picking sheet, or null when it is not approved work at a branch
 * this user serves — the caller answers null as 404.
 */
export async function loadWarehouseOrder(userId: string, orderId: number, now: Date) {
  const branchIds = await loadWarehouseReach(db, userId)
  if (branchIds.length === 0) return null

  const [row] = await db
    .select({
      ...listColumns,
      poNumber: orders.poNumber,
      subtotalCents: orders.subtotalCents,
      taxCents: orders.taxCents,
      paidAt: orders.paidAt,
      fulfilledAt: orders.fulfilledAt,
      createdAt: orders.createdAt,
      receiptData: orders.receiptData,
      branchAddress: branches.address,
      branchProvince: branches.province,
      deliveryAddress: branchDeliveryAddresses.address,
      deliveryAddressProvince: branchDeliveryAddresses.province,
      deliveryContactPerson: branchDeliveryAddresses.contactPerson,
      deliveryContactPhone: branchDeliveryAddresses.contactPhone,
    })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .innerJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branchDeliveryAddresses, deliveryAddressJoin)
    .where(and(eq(orders.id, orderId), reachConditions(branchIds)))
    .limit(1)
  if (!row) return null

  const [lines, challans] = await Promise.all([
    loadLines([row.id]),
    listDeliveryChallans({ orderId: row.id, includeReplaced: false }),
  ])
  const receipt = row.receiptData as ReceiptSnapshot
  const toCents = (amount: number | undefined) => (typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount * 100) : 0)

  return {
    order: {
      id: row.id,
      tid: row.tid,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      branchId: row.branchId,
      branchName: row.branchName,
      status: row.status,
      notes: row.notes,
      poNumber: row.poNumber,
      createdAt: row.createdAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
      ...presentDelivery(row, now),
    },
    destination: {
      label: row.deliveryAddressLabel ?? null,
      address: row.deliveryAddress ?? row.branchAddress ?? null,
      city: row.deliveryAddressCity ?? row.branchCity ?? null,
      province: row.deliveryAddressProvince ?? row.branchProvince ?? null,
      contactPerson: row.deliveryContactPerson ?? null,
      contactPhone: row.deliveryContactPhone ?? null,
      isBranchAddress: row.deliveryAddressLabel === null,
    },
    invoice: {
      invoiceNumber: row.invoiceNumber,
      invoiceDate: receipt?.date ?? null,
      subtotalCents: Number(row.subtotalCents),
      taxCents: Number(row.taxCents),
      discountCents: toCents(receipt?.discount),
      deliveryChargesCents: toCents(receipt?.deliveryCharges),
      totalCents: Number(row.totalCents),
      refundAmountCents: row.refundAmountCents === null ? 0 : Number(row.refundAmountCents),
      paymentStatus: row.paymentStatus,
      paidAt: row.paidAt?.toISOString() ?? null,
    },
    lines: (lines.get(row.id) ?? []).map(presentLine),
    challans: challans.map((challan) => ({
      id: challan.id,
      fileName: challan.fileName,
      contentType: challan.contentType,
      sizeBytes: challan.sizeBytes,
      uploadedAt: challan.uploadedAt.toISOString(),
      uploadedByRole: challan.uploadedByRole,
      attachedAt: challan.attachedAt?.toISOString() ?? null,
    })),
  }
}

/**
 * Why the warehouse may not upload a challan for this order now, or null when
 * it may: the order must be at a branch it serves, and out for delivery or
 * already delivered. Out of reach is 404, like every other warehouse read.
 */
export async function warehouseChallanUploadRefusal(
  userId: string,
  orderId: number,
): Promise<{ status: number; error: string } | null> {
  const ref = await loadWarehouseOrderInReach(db, userId, orderId)
  if (!ref) return { status: 404, error: "Order not found" }
  const [order] = await db
    .select({ fulfillmentStatus: orders.fulfillmentStatus })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
  const current = normalizeFulfillmentStatus(order?.fulfillmentStatus)
  if (current !== "OUT_FOR_DELIVERY" && current !== "DELIVERED") {
    return { status: 409, error: "A delivery challan is uploaded once the order is out for delivery" }
  }
  return null
}

/** Every challan read for the warehouse goes through this: current ones only. */
export async function hasCurrentDeliveryChallan(orderId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: orderDeliveryChallans.id })
    .from(orderDeliveryChallans)
    .where(and(
      eq(orderDeliveryChallans.orderId, orderId),
      isNotNull(orderDeliveryChallans.attachedAt),
      isNull(orderDeliveryChallans.replacedAt),
    ))
    .limit(1)
  return Boolean(row)
}
