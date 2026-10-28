import "server-only"

import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm"

import {
  apricartWarehouses,
  branches,
  globalProducts,
  orderItems,
  orders,
  stockMovements,
  users,
  warehouseStock,
} from "@/db/schema"
import type { db } from "@/lib/db"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { branchWarehouseSql, loadBranchWarehouses } from "@/lib/server/branch-warehouse"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"
import {
  availableQuantity,
  planOrderIssue,
  planStockAdjustment,
  planStockShortfalls,
  stockShortfallMessage,
  type StockAdjustmentMode,
  type StockLine,
  type StockShortfall,
} from "@/lib/warehouse-stock"

/**
 * Per-warehouse stock, against the database. Every read and write of
 * `warehouse_stock` and `stock_movements` in the application goes through this
 * module (the opening script is the one other writer).
 * See plans/OF-STOCK-per-warehouse-stock.md and `lib/warehouse-stock.ts`.
 *
 * Locks: an availability check, an issue and an adjustment each take the
 * `warehouse_stock` rows they read FOR UPDATE, ordered by (warehouse, product),
 * so two orders for the last units of a product cannot both pass. Order
 * creation has already locked the product rows by then, which serializes it
 * with itself as before.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbClient = typeof db | Tx

export const STOCK_ADJUSTMENT_AUDIT_ACTION = "ADJUST_WAREHOUSE_STOCK"

/** Where an order's stock is counted: one warehouse, or every active warehouse together. */
export type StockScope = { kind: "warehouse"; warehouseId: number } | { kind: "pool" }

/** An order still holding its reservation: pending, or approved and not yet In Process. */
export const openStockOrderSql: SQL = sql`(UPPER(${orders.status}) = 'PENDING' OR (UPPER(${orders.status}) = 'APPROVED' AND COALESCE(UPPER(${orders.fulfillmentStatus}), 'NOT_STARTED') = 'NOT_STARTED'))`

/** The warehouse an order is counted at now — the transfer's, else its branch's. Needs `branches` joined. */
export function orderStockWarehouseSql(): SQL<number | null> {
  return sql<number | null>`COALESCE(${orders.fulfillmentWarehouseId}, ${branchWarehouseSql()})`
}

/** The scope of an order (or a new one) at `branchId`, transferred to `fulfillmentWarehouseId` or not. */
export async function resolveStockScope(
  client: DbClient,
  input: { branchId: number; fulfillmentWarehouseId?: number | null },
): Promise<StockScope> {
  if (input.fulfillmentWarehouseId != null) return { kind: "warehouse", warehouseId: input.fulfillmentWarehouseId }
  const warehouseId = (await loadBranchWarehouses(client, [input.branchId])).get(input.branchId) ?? null
  return warehouseId === null ? { kind: "pool" } : { kind: "warehouse", warehouseId }
}

async function activeWarehouseIds(client: DbClient): Promise<number[]> {
  const rows = await client
    .select({ id: apricartWarehouses.id })
    .from(apricartWarehouses)
    .where(eq(apricartWarehouses.status, "ACTIVE"))
    .orderBy(asc(apricartWarehouses.id))
  return rows.map((row) => row.id)
}

/** On hand per product in a scope; with `lock`, the rows are taken FOR UPDATE. */
export async function loadOnHand(
  client: DbClient,
  scope: StockScope,
  productIds: readonly number[],
  options: { lock?: boolean } = {},
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Map()
  const warehouseIds = scope.kind === "warehouse" ? [scope.warehouseId] : await activeWarehouseIds(client)
  if (warehouseIds.length === 0) return new Map()
  const query = client
    .select({ productId: warehouseStock.globalProductId, onHand: warehouseStock.onHandQuantity })
    .from(warehouseStock)
    .where(and(inArray(warehouseStock.warehouseId, warehouseIds), inArray(warehouseStock.globalProductId, ids)))
    .orderBy(asc(warehouseStock.warehouseId), asc(warehouseStock.globalProductId))
  const rows = options.lock ? await query.for("update") : await query
  const onHand = new Map<number, number>()
  for (const row of rows) onHand.set(row.productId, availableQuantity((onHand.get(row.productId) ?? 0) + Number(row.onHand), 0))
  return onHand
}

/** What open orders hold per product in a scope, leaving out `excludeOrderId`. */
export async function loadReservedQuantities(
  client: DbClient,
  scope: StockScope,
  productIds: readonly number[],
  excludeOrderId?: number,
): Promise<Map<number, number>> {
  const ids = [...new Set(productIds)]
  if (ids.length === 0) return new Map()
  const rows = await client
    .select({
      productId: orderItems.globalProductId,
      quantity: sql<string>`sum(${orderItems.quantity})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(and(
      inArray(orderItems.globalProductId, ids),
      openStockOrderSql,
      excludeOrderId === undefined ? undefined : ne(orders.id, excludeOrderId),
      scope.kind === "warehouse" ? sql`${orderStockWarehouseSql()} = ${scope.warehouseId}` : undefined,
    ))
    .groupBy(orderItems.globalProductId)
  return new Map(rows.map((row) => [row.productId, Number(row.quantity)]))
}

/**
 * Every product these lines ask for more of than the order's scope has
 * available, with the stock rows locked. `excludeOrderId` is the order being
 * edited: what it already holds counts as available to it.
 */
export async function findStockShortfalls(
  tx: Tx,
  input: { branchId: number; fulfillmentWarehouseId?: number | null; lines: readonly StockLine[]; excludeOrderId?: number },
): Promise<StockShortfall[]> {
  const scope = await resolveStockScope(tx, input)
  const productIds = input.lines.map((line) => line.globalProductId)
  const onHand = await loadOnHand(tx, scope, productIds, { lock: true })
  const reserved = await loadReservedQuantities(tx, scope, productIds, input.excludeOrderId)
  return planStockShortfalls(input.lines, onHand, reserved)
}

/** As `findStockShortfalls`, throwing the customer-facing "Insufficient stock" message on the first. */
export async function assertWarehouseStockAvailable(
  tx: Tx,
  input: { branchId: number; fulfillmentWarehouseId?: number | null; lines: readonly StockLine[]; excludeOrderId?: number },
): Promise<void> {
  const [shortfall] = await findStockShortfalls(tx, input)
  if (shortfall) throw new Error(stockShortfallMessage(shortfall))
}

export class StockIssueRefusal extends Error {
  constructor(
    readonly reason: "no-warehouse" | "short",
    readonly shortfalls: StockShortfall[] = [],
  ) {
    super(reason === "no-warehouse" ? "STOCK_ISSUE_NO_WAREHOUSE" : "STOCK_ISSUE_SHORT")
    this.name = "StockIssueRefusal"
  }
}

/**
 * Take an order's goods off its warehouse's shelf, inside the transaction that
 * marks it In Process. The warehouse is the one working the order at that
 * moment — the transfer's, else its branch's. Refused (rolling the step back)
 * when it has no warehouse or the shelf is short; done at most once per order.
 */
export async function issueOrderStock(
  tx: Tx,
  input: { orderId: number; actor: { id: string; role: string } },
): Promise<{ kind: "issued"; warehouseId: number } | { kind: "already-issued" }> {
  const [existing] = await tx
    .select({ id: stockMovements.id })
    .from(stockMovements)
    .where(and(eq(stockMovements.orderId, input.orderId), eq(stockMovements.movementType, "ORDER_ISSUE")))
    .limit(1)
  if (existing) return { kind: "already-issued" }

  const [order] = await tx
    .select({ id: orders.id, branchId: orders.branchId, fulfillmentWarehouseId: orders.fulfillmentWarehouseId })
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1)
  if (!order) throw new Error("STOCK_ISSUE_ORDER_MISSING")
  const scope = await resolveStockScope(tx, order)
  if (scope.kind !== "warehouse") throw new StockIssueRefusal("no-warehouse")

  const lines = (await tx
    .select({ globalProductId: orderItems.globalProductId, quantity: orderItems.quantity, productName: orderItems.productName })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id)))
    .map((line) => ({ ...line, quantity: Number(line.quantity) }))
  const onHand = await loadOnHand(tx, scope, lines.map((line) => line.globalProductId), { lock: true })
  const plan = planOrderIssue(lines, onHand)
  if (!plan.ok) throw new StockIssueRefusal("short", plan.shortfalls)

  const now = new Date()
  for (const move of plan.moves) {
    await tx
      .update(warehouseStock)
      .set({ onHandQuantity: move.balanceAfter, updatedAt: now, updatedByUserId: input.actor.id })
      .where(and(eq(warehouseStock.warehouseId, scope.warehouseId), eq(warehouseStock.globalProductId, move.globalProductId)))
    await tx.insert(stockMovements).values({
      warehouseId: scope.warehouseId,
      globalProductId: move.globalProductId,
      movementType: "ORDER_ISSUE",
      quantityDelta: -move.quantity,
      balanceAfter: move.balanceAfter,
      orderId: order.id,
      actorUserId: input.actor.id,
      actorRole: input.actor.role,
      createdAt: now,
    })
  }
  return { kind: "issued", warehouseId: scope.warehouseId }
}

export type StockAdjustmentOutcome =
  | { kind: "adjusted"; onHandBefore: number; onHandAfter: number; movementId: number }
  | { kind: "warehouse-not-found" }
  | { kind: "product-not-found" }
  | { kind: "refused"; error: string }

/** Super Admin sets, adds to or takes from one warehouse's figure, with a reason, audited. */
export async function adjustWarehouseStock(
  tx: Tx,
  input: {
    warehouseId: number
    globalProductId: number
    mode: StockAdjustmentMode
    quantity: number
    reason: string
    actor: AuditActor & { id: string }
  },
): Promise<StockAdjustmentOutcome> {
  const [warehouse] = await tx
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code })
    .from(apricartWarehouses)
    .where(eq(apricartWarehouses.id, input.warehouseId))
    .limit(1)
  if (!warehouse) return { kind: "warehouse-not-found" }
  const [product] = await tx
    .select({ id: globalProducts.id, productCode: globalProducts.productCode, allowDecimalQuantity: globalProducts.allowDecimalQuantity })
    .from(globalProducts)
    .where(and(eq(globalProducts.id, input.globalProductId), isNull(globalProducts.deletedAt)))
    .limit(1)
  if (!product) return { kind: "product-not-found" }

  await tx
    .insert(warehouseStock)
    .values({ warehouseId: warehouse.id, globalProductId: product.id, onHandQuantity: 0 })
    .onConflictDoNothing({ target: [warehouseStock.warehouseId, warehouseStock.globalProductId] })
  const [row] = await tx
    .select({ onHand: warehouseStock.onHandQuantity })
    .from(warehouseStock)
    .where(and(eq(warehouseStock.warehouseId, warehouse.id), eq(warehouseStock.globalProductId, product.id)))
    .for("update")
  const onHandBefore = Number(row?.onHand ?? 0)
  const plan = planStockAdjustment({
    mode: input.mode,
    quantity: input.quantity,
    onHand: onHandBefore,
    allowDecimalQuantity: product.allowDecimalQuantity,
  })
  if (!plan.ok) return { kind: "refused", error: plan.error }

  const now = new Date()
  await tx
    .update(warehouseStock)
    .set({ onHandQuantity: plan.onHandAfter, updatedAt: now, updatedByUserId: input.actor.id })
    .where(and(eq(warehouseStock.warehouseId, warehouse.id), eq(warehouseStock.globalProductId, product.id)))
  const [movement] = await tx
    .insert(stockMovements)
    .values({
      warehouseId: warehouse.id,
      globalProductId: product.id,
      movementType: "ADJUSTMENT",
      quantityDelta: plan.delta,
      balanceAfter: plan.onHandAfter,
      reason: input.reason,
      actorUserId: input.actor.id,
      actorRole: input.actor.role ?? null,
      createdAt: now,
    })
    .returning({ id: stockMovements.id })
  await recordAuditEvent(tx, {
    action: STOCK_ADJUSTMENT_AUDIT_ACTION,
    entity: "warehouse_stock",
    entityId: `${warehouse.id}:${product.id}`,
    actor: input.actor,
    before: { onHand: onHandBefore },
    after: { onHand: plan.onHandAfter },
    context: {
      warehouseCode: warehouse.code,
      productCode: product.productCode,
      mode: input.mode,
      quantity: input.quantity,
      reason: input.reason,
      movementId: movement.id,
    },
  })
  return { kind: "adjusted", onHandBefore, onHandAfter: plan.onHandAfter, movementId: movement.id }
}

/**
 * What a branch can order now, per product, never below zero — for the
 * catalogues. Null while stock is counted globally, so callers keep the global
 * figure exactly as before.
 */
export async function loadBranchAvailableStock(
  client: DbClient,
  branchId: number,
  productIds: readonly number[],
): Promise<Map<number, number> | null> {
  if (!usesWarehouseStock()) return null
  return availableInScope(client, await resolveStockScope(client, { branchId }), productIds)
}

/**
 * The least any of these branches can order, per product — a group submission
 * places one order per branch, each against its own warehouse. Null while
 * stock is counted globally.
 */
export async function loadLeastAvailableStock(
  client: DbClient,
  branchIds: readonly number[],
  productIds: readonly number[],
): Promise<Map<number, number> | null> {
  if (!usesWarehouseStock()) return null
  const warehouses = await loadBranchWarehouses(client, branchIds)
  const scopes = new Map<string, StockScope>()
  for (const warehouseId of warehouses.values()) {
    const scope: StockScope = warehouseId === null ? { kind: "pool" } : { kind: "warehouse", warehouseId }
    scopes.set(warehouseId === null ? "pool" : String(warehouseId), scope)
  }
  const least = new Map<number, number>()
  for (const scope of scopes.values()) {
    const available = await availableInScope(client, scope, productIds)
    for (const productId of new Set(productIds)) {
      const value = available.get(productId) ?? 0
      least.set(productId, least.has(productId) ? Math.min(least.get(productId)!, value) : value)
    }
  }
  return least
}

async function availableInScope(client: DbClient, scope: StockScope, productIds: readonly number[]): Promise<Map<number, number>> {
  const [onHand, reserved] = await Promise.all([
    loadOnHand(client, scope, productIds),
    loadReservedQuantities(client, scope, productIds),
  ])
  const available = new Map<number, number>()
  for (const productId of new Set(productIds)) {
    available.set(productId, Math.max(0, availableQuantity(onHand.get(productId) ?? 0, reserved.get(productId) ?? 0)))
  }
  return available
}

/**
 * The stock figure a product list shows: the global figure while stock is
 * counted globally, else everything on hand at the active warehouses. For
 * selects whose FROM is `global_products` itself, unaliased.
 */
export function productStockDisplaySql(): SQL<number> {
  if (!usesWarehouseStock()) return sql<number>`${globalProducts.stockQuantity}`.mapWith(Number)
  return sql<number>`(SELECT COALESCE(SUM(ws."on_hand_quantity"), 0) FROM "warehouse_stock" ws
    JOIN "apricart_warehouses" aw ON aw."id" = ws."warehouse_id" AND aw."status" = 'ACTIVE'
    WHERE ws."global_product_id" = "global_products"."id")`.mapWith(Number)
}

/**
 * The lines of a not-yet-issued order that `target` (a warehouse, or null for
 * its branch's own) could not cover — for the transfer warning. Empty while
 * stock is counted globally, or once the order's goods have been issued.
 */
export async function loadTransferStockShortfalls(
  client: DbClient,
  input: { orderId: number; branchId: number; status: string | null; fulfillmentStatus: string | null; targetWarehouseId: number | null },
): Promise<StockShortfall[]> {
  if (!usesWarehouseStock()) return []
  const status = String(input.status ?? "").toUpperCase()
  const stage = String(input.fulfillmentStatus ?? "NOT_STARTED").toUpperCase()
  if (!(status === "PENDING" || (status === "APPROVED" && stage === "NOT_STARTED"))) return []
  const scope = await resolveStockScope(client, { branchId: input.branchId, fulfillmentWarehouseId: input.targetWarehouseId })
  const lines = (await client
    .select({ globalProductId: orderItems.globalProductId, quantity: orderItems.quantity, productName: orderItems.productName })
    .from(orderItems)
    .where(eq(orderItems.orderId, input.orderId)))
    .map((line) => ({ ...line, quantity: Number(line.quantity) }))
  const productIds = lines.map((line) => line.globalProductId)
  const [onHand, reserved] = await Promise.all([
    loadOnHand(client, scope, productIds),
    loadReservedQuantities(client, scope, productIds, input.orderId),
  ])
  return planStockShortfalls(lines, onHand, reserved)
}

export type WarehouseStockRow = {
  globalProductId: number
  productCode: string
  name: string
  unit: string
  status: string
  allowDecimalQuantity: boolean
  onHand: number
  reserved: number
  available: number
  updatedAt: string | null
}

export const WAREHOUSE_STOCK_PAGE_SIZE_MAX = 100

/** One warehouse's figures for Super Admin, a page of products at a time. */
export async function listWarehouseStock(
  client: DbClient,
  input: { warehouseId: number; search: string; page: number; pageSize: number },
): Promise<{ items: WarehouseStockRow[]; total: number }> {
  const pageSize = Math.min(Math.max(1, input.pageSize), WAREHOUSE_STOCK_PAGE_SIZE_MAX)
  const page = Math.max(1, input.page)
  const search = input.search.trim()
  const where = and(
    isNull(globalProducts.deletedAt),
    search ? or(ilike(globalProducts.name, `%${search}%`), ilike(globalProducts.productCode, `%${search}%`)) : undefined,
  )
  const stockOn = and(eq(warehouseStock.globalProductId, globalProducts.id), eq(warehouseStock.warehouseId, input.warehouseId))
  const [rows, [{ total }]] = await Promise.all([
    client
      .select({
        globalProductId: globalProducts.id,
        productCode: globalProducts.productCode,
        name: globalProducts.name,
        unit: globalProducts.unit,
        status: globalProducts.status,
        allowDecimalQuantity: globalProducts.allowDecimalQuantity,
        onHand: warehouseStock.onHandQuantity,
        updatedAt: warehouseStock.updatedAt,
      })
      .from(globalProducts)
      .leftJoin(warehouseStock, stockOn)
      .where(where)
      .orderBy(asc(globalProducts.name), asc(globalProducts.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    client.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(globalProducts).where(where),
  ])
  const reserved = await loadReservedQuantities(
    client,
    { kind: "warehouse", warehouseId: input.warehouseId },
    rows.map((row) => row.globalProductId),
  )
  return {
    total,
    items: rows.map((row) => {
      const onHand = Number(row.onHand ?? 0)
      const held = reserved.get(row.globalProductId) ?? 0
      return {
        globalProductId: row.globalProductId,
        productCode: row.productCode,
        name: row.name,
        unit: row.unit,
        status: row.status,
        allowDecimalQuantity: row.allowDecimalQuantity,
        onHand,
        reserved: held,
        available: availableQuantity(onHand, held),
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      }
    }),
  }
}

export const STOCK_MOVEMENT_HISTORY_LIMIT = 100

/** The latest changes to one warehouse's figure for one product. */
export async function listStockMovements(
  client: DbClient,
  input: { warehouseId: number; globalProductId: number },
): Promise<Array<{
  id: number
  movementType: string
  quantityDelta: number
  balanceAfter: number
  orderId: number | null
  orderTid: string | null
  reason: string | null
  actorName: string | null
  createdAt: string
}>> {
  const rows = await client
    .select({
      id: stockMovements.id,
      movementType: stockMovements.movementType,
      quantityDelta: stockMovements.quantityDelta,
      balanceAfter: stockMovements.balanceAfter,
      orderId: stockMovements.orderId,
      orderTid: orders.tid,
      reason: stockMovements.reason,
      actorFullName: users.fullName,
      actorUsername: users.username,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .leftJoin(orders, eq(orders.id, stockMovements.orderId))
    .leftJoin(users, eq(users.id, stockMovements.actorUserId))
    .where(and(eq(stockMovements.warehouseId, input.warehouseId), eq(stockMovements.globalProductId, input.globalProductId)))
    .orderBy(desc(stockMovements.id))
    .limit(STOCK_MOVEMENT_HISTORY_LIMIT)
  return rows.map((row) => ({
    id: row.id,
    movementType: row.movementType,
    quantityDelta: Number(row.quantityDelta),
    balanceAfter: Number(row.balanceAfter),
    orderId: row.orderId,
    orderTid: row.orderTid ?? null,
    reason: row.reason,
    actorName: row.actorFullName?.trim() || row.actorUsername?.trim() || null,
    createdAt: row.createdAt.toISOString(),
  }))
}

/** Every warehouse, for the Warehouse Stock page's selector. */
export async function listStockWarehouses(client: DbClient): Promise<Array<{ id: number; code: string; name: string; status: string }>> {
  return client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, name: apricartWarehouses.name, status: apricartWarehouses.status })
    .from(apricartWarehouses)
    .orderBy(asc(apricartWarehouses.code))
}

/** How many open orders, and lines, are at branches in no warehouse — reserved against every warehouse together. */
export async function countUnassignedOpenOrders(client: DbClient): Promise<{ orders: number }> {
  const [row] = await client
    .select({ orders: sql<number>`count(DISTINCT ${orders.id})`.mapWith(Number) })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(and(openStockOrderSql, sql`${orderStockWarehouseSql()} IS NULL`))
  return { orders: row?.orders ?? 0 }
}
