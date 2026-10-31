import "server-only"

import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm"

import {
  apricartWarehouseMemberships,
  apricartWarehouses,
  branches,
  customerReturnLines,
  customerReturns,
  globalProducts,
  goodsReceiptLines,
  goodsReceipts,
  orderItems,
  orders,
  procurementSettings,
  procurementSuppliers,
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequisitionLines,
  purchaseRequisitions,
  roles,
  supplierInvoiceLines,
  supplierInvoices,
  users,
  warehouseStock,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  DEFAULT_OVER_DELIVERY_TOLERANCE_BPS,
  customerReturnReference,
  duplicateProductIds,
  goodsReceiptReference,
  isInvoiceableStatus,
  isReceivableStatus,
  lineMoney,
  outstandingQuantity,
  planGoodsReceipt,
  planSupplierInvoice,
  purchaseOrderActionRefusal,
  purchaseOrderReference,
  purchaseOrderStatusAfter,
  quantityRefusal,
  requisitionReference,
  returnRestockLines,
  sumMoney,
  supplierInvoiceDecisionRefusal,
  toleranceBpsFromPercent,
  type InvoiceMatchStatus,
  type PurchaseOrderAction,
} from "@/lib/procurement"
import { canApproveInvoiceExceptions, canApprovePurchaseOrders } from "@/lib/procurement-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import type { PurchaseOrderActionInput, SupplierInvoiceDecisionInput } from "@/lib/server/procurement-validation"
import { loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { addToWarehouseStock, openStockOrderSql, orderStockWarehouseSql } from "@/lib/server/warehouse-stock"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * Purchasing into Apricart warehouses, against the database.
 * See plans/OF-PROCUREMENT-purchasing.md; the rules are `lib/procurement.ts`
 * and who may call what is `lib/procurement-access.ts`.
 *
 * Every write is one transaction with its audit row. A purchase order is locked
 * FOR UPDATE by every write that touches it — an action, a receipt, an invoice —
 * so two receipts cannot both pass the tolerance, and an approval cannot pass a
 * receipt. Writes on an existing PO name the `updatedAt` they saw; a change in
 * between is a conflict, never a decision on unseen lines.
 *
 * The warehouse-facing reads (`loadWarehouse…`) select no cost column.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type DbClient = typeof db | Tx

export type ProcurementActor = AuditActor & { id: string; role: string }

/** Receipts and approved returns write stock no order reads while the switch is "global". */
export const STOCK_LEDGER_GLOBAL_MESSAGE =
  "Goods cannot be put on a warehouse shelf yet: stock is still counted globally. Switch stock to per-warehouse counting first."

export const PROCUREMENT_LIST_LIMIT = 200
export const PURCHASE_ORDER_PAGE_SIZE = 50

function isUniqueViolation(exception: unknown): boolean {
  const cause = (exception as { cause?: unknown })?.cause ?? exception
  const code = (cause as { code?: string })?.code ?? (exception as { code?: string })?.code
  return code === "23505"
}

const sameInstant = (a: Date, iso: string): boolean => a.getTime() === new Date(iso).getTime()

// ---------------------------------------------------------------------------
// Products and warehouses
// ---------------------------------------------------------------------------

type ProductFacts = { id: number; name: string; productCode: string; unit: string; allowDecimalQuantity: boolean; active: boolean }

async function loadProducts(client: DbClient, ids: readonly number[]): Promise<Map<number, ProductFacts>> {
  if (ids.length === 0) return new Map()
  const rows = await client
    .select({
      id: globalProducts.id,
      name: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      status: globalProducts.status,
      deletedAt: globalProducts.deletedAt,
    })
    .from(globalProducts)
    .where(inArray(globalProducts.id, [...new Set(ids)]))
  return new Map(rows.map((row) => [row.id, {
    id: row.id,
    name: row.name,
    productCode: row.productCode,
    unit: row.unit,
    allowDecimalQuantity: row.allowDecimalQuantity,
    active: row.deletedAt === null && row.status === "active",
  }]))
}

/** Null when every line names an active product once, in a quantity it can be counted in. */
async function linesRefusal(
  client: DbClient,
  lines: ReadonlyArray<{ globalProductId: number; quantity: number }>,
): Promise<string | null> {
  const duplicates = duplicateProductIds(lines)
  if (duplicates.length > 0) return "Each product may appear on one line only."
  const products = await loadProducts(client, lines.map((line) => line.globalProductId))
  for (const line of lines) {
    const product = products.get(line.globalProductId)
    if (!product?.active) return "A product on this document is not in the active catalogue."
    const refusal = quantityRefusal(line.quantity, product.allowDecimalQuantity, product.name)
    if (refusal) return refusal
  }
  return null
}

async function activeWarehouse(client: DbClient, warehouseId: number): Promise<{ id: number; code: string } | null> {
  const [row] = await client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, status: apricartWarehouses.status })
    .from(apricartWarehouses)
    .where(eq(apricartWarehouses.id, warehouseId))
    .limit(1)
  return row && row.status === "ACTIVE" ? { id: row.id, code: row.code } : null
}

/** The product picker: active catalogue products by name or code, bounded. */
export async function searchProcurementProducts(
  client: DbClient,
  query: string,
): Promise<Array<{ id: number; name: string; productCode: string; unit: string; allowDecimalQuantity: boolean }>> {
  const term = query.trim().slice(0, 100)
  const pattern = `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
  return client
    .select({
      id: globalProducts.id,
      name: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
    })
    .from(globalProducts)
    .where(and(
      isNull(globalProducts.deletedAt),
      eq(globalProducts.status, "active"),
      term ? or(ilike(globalProducts.name, pattern), ilike(globalProducts.productCode, pattern)) : undefined,
    ))
    .orderBy(asc(globalProducts.name))
    .limit(25)
}

/** The warehouses an Apricart Executive is an executive member of, read live. */
export async function loadExecutiveWarehouseIds(
  client: DbClient,
  userId: string,
  options: { lock?: boolean } = {},
): Promise<number[]> {
  const query = client
    .select({ warehouseId: apricartWarehouseMemberships.warehouseId })
    .from(apricartWarehouseMemberships)
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(apricartWarehouseMemberships.userId, userId),
      eq(apricartWarehouseMemberships.responsibility, "EXECUTIVE"),
      eq(roles.name, "APRICART_EXECUTIVE"),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
  const rows = options.lock ? await query.for("share", { of: [apricartWarehouseMemberships] }) : await query
  return [...new Set(rows.map((row) => row.warehouseId))].sort((a, b) => a - b)
}

/** Warehouses by id, for labels. */
export async function listWarehousesById(
  client: DbClient,
  ids: readonly number[],
): Promise<Array<{ id: number; code: string; name: string; status: string }>> {
  if (ids.length === 0) return []
  return client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, name: apricartWarehouses.name, status: apricartWarehouses.status })
    .from(apricartWarehouses)
    .where(inArray(apricartWarehouses.id, [...ids]))
    .orderBy(asc(apricartWarehouses.code))
}

function userName(row: { fullName: string | null; username: string | null }): string | null {
  return row.fullName?.trim() || row.username?.trim() || null
}

async function namesByUserId(client: DbClient, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => typeof value === "string"))]
  if (wanted.length === 0) return new Map()
  const rows = await client
    .select({ id: users.id, fullName: users.fullName, username: users.username })
    .from(users)
    .where(inArray(users.id, wanted))
  return new Map(rows.flatMap((row) => {
    const name = userName(row)
    return name ? [[row.id, name] as const] : []
  }))
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function loadProcurementSettings(
  client: DbClient,
): Promise<{ overDeliveryToleranceBps: number; updatedAt: string | null }> {
  const [row] = await client
    .select({ bps: procurementSettings.overDeliveryToleranceBps, updatedAt: procurementSettings.updatedAt })
    .from(procurementSettings)
    .where(eq(procurementSettings.id, 1))
    .limit(1)
  return {
    overDeliveryToleranceBps: row?.bps ?? DEFAULT_OVER_DELIVERY_TOLERANCE_BPS,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  }
}

export async function updateProcurementSettings(input: {
  overDeliveryTolerancePercent: number
  actor: ProcurementActor
}): Promise<{ overDeliveryToleranceBps: number }> {
  const bps = toleranceBpsFromPercent(input.overDeliveryTolerancePercent)
  return db.transaction(async (tx) => {
    const before = await loadProcurementSettings(tx)
    const now = new Date()
    await tx
      .insert(procurementSettings)
      .values({ id: 1, overDeliveryToleranceBps: bps, updatedByUserId: input.actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: procurementSettings.id,
        set: { overDeliveryToleranceBps: bps, updatedByUserId: input.actor.id, updatedAt: now },
      })
    await recordAuditEvent(tx, {
      action: "UPDATE_PROCUREMENT_SETTINGS",
      entity: "procurement_settings",
      entityId: 1,
      actor: input.actor,
      before: { overDeliveryToleranceBps: before.overDeliveryToleranceBps },
      after: { overDeliveryToleranceBps: bps },
    })
    return { overDeliveryToleranceBps: bps }
  })
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const supplierColumns = {
  id: procurementSuppliers.id,
  name: procurementSuppliers.name,
  contactName: procurementSuppliers.contactName,
  phone: procurementSuppliers.phone,
  email: procurementSuppliers.email,
  address: procurementSuppliers.address,
  ntn: procurementSuppliers.ntn,
  status: procurementSuppliers.status,
  createdAt: procurementSuppliers.createdAt,
  updatedAt: procurementSuppliers.updatedAt,
}

export type SupplierInput = {
  name?: string
  contactName?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  ntn?: string | null
  status?: "ACTIVE" | "INACTIVE"
}

function supplierValues(input: SupplierInput) {
  const blankToNull = (value: string | null | undefined) => (value === undefined ? undefined : value?.trim() || null)
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.contactName === undefined ? {} : { contactName: blankToNull(input.contactName) }),
    ...(input.phone === undefined ? {} : { phone: blankToNull(input.phone) }),
    ...(input.email === undefined ? {} : { email: blankToNull(input.email) }),
    ...(input.address === undefined ? {} : { address: blankToNull(input.address) }),
    ...(input.ntn === undefined ? {} : { ntn: blankToNull(input.ntn) }),
    ...(input.status === undefined ? {} : { status: input.status }),
  }
}

export async function listSuppliers(client: DbClient) {
  return client.select(supplierColumns).from(procurementSuppliers).orderBy(asc(procurementSuppliers.name)).limit(500)
}

export async function createSupplier(input: SupplierInput & { name: string; actor: ProcurementActor }) {
  try {
    return await db.transaction(async (tx) => {
      const now = new Date()
      const [supplier] = await tx
        .insert(procurementSuppliers)
        .values({ ...supplierValues(input), name: input.name.trim(), createdByUserId: input.actor.id, createdAt: now, updatedAt: now })
        .returning(supplierColumns)
      await recordAuditEvent(tx, {
        action: "CREATE_PROCUREMENT_SUPPLIER",
        entity: "procurement_supplier",
        entityId: supplier.id,
        actor: input.actor,
        after: supplier,
      })
      return { kind: "created", supplier } as const
    })
  } catch (caught) {
    if (isUniqueViolation(caught)) return { kind: "duplicate" } as const
    throw caught
  }
}

export async function updateSupplier(id: number, input: SupplierInput & { actor: ProcurementActor }) {
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select(supplierColumns).from(procurementSuppliers).where(eq(procurementSuppliers.id, id)).for("update")
      if (!before) return { kind: "not-found" } as const
      const [supplier] = await tx
        .update(procurementSuppliers)
        .set({ ...supplierValues(input), updatedAt: new Date() })
        .where(eq(procurementSuppliers.id, id))
        .returning(supplierColumns)
      await recordAuditEvent(tx, {
        action: "UPDATE_PROCUREMENT_SUPPLIER",
        entity: "procurement_supplier",
        entityId: id,
        actor: input.actor,
        before,
        after: supplier,
      })
      return { kind: "updated", supplier } as const
    })
  } catch (caught) {
    if (isUniqueViolation(caught)) return { kind: "duplicate" } as const
    throw caught
  }
}

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

export type RequisitionRow = {
  id: number
  reference: string
  warehouse: { id: number; code: string; name: string }
  status: string
  note: string | null
  requestedBy: string | null
  decisionReason: string | null
  purchaseOrderId: number | null
  purchaseOrderReference: string | null
  createdAt: string
  lines: Array<{ globalProductId: number; productName: string; productCode: string; unit: string; allowDecimalQuantity: boolean; quantity: number; note: string | null }>
}

/** Requisitions, newest first. `warehouseIds` null reads every warehouse; an array (even empty) is a fence. */
export async function listRequisitions(
  client: DbClient,
  filter: { warehouseIds: readonly number[] | null; status?: string },
): Promise<RequisitionRow[]> {
  if (filter.warehouseIds !== null && filter.warehouseIds.length === 0) return []
  const rows = await client
    .select({
      id: purchaseRequisitions.id,
      warehouseId: purchaseRequisitions.warehouseId,
      warehouseCode: apricartWarehouses.code,
      warehouseName: apricartWarehouses.name,
      status: purchaseRequisitions.status,
      note: purchaseRequisitions.note,
      requestedByUserId: purchaseRequisitions.requestedByUserId,
      decisionReason: purchaseRequisitions.decisionReason,
      purchaseOrderId: purchaseRequisitions.purchaseOrderId,
      createdAt: purchaseRequisitions.createdAt,
    })
    .from(purchaseRequisitions)
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, purchaseRequisitions.warehouseId))
    .where(and(
      filter.warehouseIds === null ? undefined : inArray(purchaseRequisitions.warehouseId, [...filter.warehouseIds]),
      filter.status ? eq(purchaseRequisitions.status, filter.status) : undefined,
    ))
    .orderBy(desc(purchaseRequisitions.id))
    .limit(PROCUREMENT_LIST_LIMIT)
  if (rows.length === 0) return []

  const lines = await client
    .select({
      requisitionId: purchaseRequisitionLines.requisitionId,
      globalProductId: purchaseRequisitionLines.globalProductId,
      productName: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantity: purchaseRequisitionLines.quantity,
      note: purchaseRequisitionLines.note,
    })
    .from(purchaseRequisitionLines)
    .innerJoin(globalProducts, eq(globalProducts.id, purchaseRequisitionLines.globalProductId))
    .where(inArray(purchaseRequisitionLines.requisitionId, rows.map((row) => row.id)))
    .orderBy(asc(purchaseRequisitionLines.id))
  const names = await namesByUserId(client, rows.map((row) => row.requestedByUserId))

  return rows.map((row) => ({
    id: row.id,
    reference: requisitionReference(row.id),
    warehouse: { id: row.warehouseId, code: row.warehouseCode, name: row.warehouseName },
    status: row.status,
    note: row.note,
    requestedBy: row.requestedByUserId ? names.get(row.requestedByUserId) ?? null : null,
    decisionReason: row.decisionReason,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReference: row.purchaseOrderId ? purchaseOrderReference(row.purchaseOrderId) : null,
    createdAt: row.createdAt.toISOString(),
    lines: lines
      .filter((line) => line.requisitionId === row.id)
      .map((line) => ({
        globalProductId: line.globalProductId,
        productName: line.productName,
        productCode: line.productCode,
        unit: line.unit,
        allowDecimalQuantity: line.allowDecimalQuantity,
        quantity: Number(line.quantity),
        note: line.note,
      })),
  }))
}

export type RequisitionCreateOutcome =
  | { kind: "created"; id: number; reference: string }
  | { kind: "warehouse-not-found" }
  | { kind: "refused"; error: string }

/** Raise a requisition. `allowedWarehouseIds` fences a warehouse account to its own warehouses. */
export async function createRequisition(input: {
  warehouseId: number
  note?: string | null
  lines: ReadonlyArray<{ globalProductId: number; quantity: number; note?: string | null }>
  allowedWarehouseIds: readonly number[] | null
  actor: ProcurementActor
}): Promise<RequisitionCreateOutcome> {
  if (input.allowedWarehouseIds !== null && !input.allowedWarehouseIds.includes(input.warehouseId)) {
    return { kind: "warehouse-not-found" }
  }
  return db.transaction(async (tx) => {
    const warehouse = await activeWarehouse(tx, input.warehouseId)
    if (!warehouse) return { kind: "warehouse-not-found" } as const
    const refusal = await linesRefusal(tx, input.lines)
    if (refusal) return { kind: "refused", error: refusal } as const

    const now = new Date()
    const [requisition] = await tx
      .insert(purchaseRequisitions)
      .values({
        warehouseId: warehouse.id,
        note: input.note?.trim() || null,
        requestedByUserId: input.actor.id,
        requestedByRole: input.actor.role,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: purchaseRequisitions.id })
    await tx.insert(purchaseRequisitionLines).values(input.lines.map((line) => ({
      requisitionId: requisition.id,
      globalProductId: line.globalProductId,
      quantity: line.quantity,
      note: line.note?.trim() || null,
    })))
    await recordAuditEvent(tx, {
      action: "CREATE_PURCHASE_REQUISITION",
      entity: "purchase_requisition",
      entityId: requisition.id,
      actor: input.actor,
      after: { warehouseCode: warehouse.code, lines: input.lines.map((line) => ({ globalProductId: line.globalProductId, quantity: line.quantity })) },
    })
    return { kind: "created", id: requisition.id, reference: requisitionReference(requisition.id) } as const
  })
}

/**
 * Reject (Procurement, Super Admin) or cancel (also the warehouse that raised it)
 * a requisition still waiting. `allowedWarehouseIds` fences a warehouse account.
 */
export async function decideRequisition(input: {
  id: number
  action: "reject" | "cancel"
  reason: string
  allowedWarehouseIds: readonly number[] | null
  actor: ProcurementActor
}): Promise<{ kind: "decided"; status: string } | { kind: "not-found" } | { kind: "conflict"; error: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: purchaseRequisitions.id, status: purchaseRequisitions.status, warehouseId: purchaseRequisitions.warehouseId })
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, input.id))
      .for("update")
    if (!row) return { kind: "not-found" } as const
    if (input.allowedWarehouseIds !== null && !input.allowedWarehouseIds.includes(row.warehouseId)) return { kind: "not-found" } as const
    if (row.status !== "SUBMITTED") return { kind: "conflict", error: "This requisition has already been dealt with." } as const

    const status = input.action === "reject" ? "REJECTED" : "CANCELLED"
    const now = new Date()
    await tx
      .update(purchaseRequisitions)
      .set({ status, decidedByUserId: input.actor.id, decidedAt: now, decisionReason: input.reason, updatedAt: now })
      .where(eq(purchaseRequisitions.id, row.id))
    await recordAuditEvent(tx, {
      action: "DECIDE_PURCHASE_REQUISITION",
      entity: "purchase_requisition",
      entityId: row.id,
      actor: input.actor,
      before: { status: row.status },
      after: { status },
      context: { reason: input.reason },
    })
    return { kind: "decided", status } as const
  })
}

// ---------------------------------------------------------------------------
// Purchase orders
// ---------------------------------------------------------------------------

export type PurchaseOrderLineInput = { globalProductId: number; quantity: number; unitCostCents: number; taxRateBps: number }

function pricedLines(lines: readonly PurchaseOrderLineInput[]) {
  const priced = lines.map((line) => ({ ...line, ...lineMoney(line) }))
  return { priced, totals: sumMoney(priced) }
}

async function activeSupplier(client: DbClient, supplierId: number): Promise<{ id: number; name: string } | null> {
  const [row] = await client
    .select({ id: procurementSuppliers.id, name: procurementSuppliers.name, status: procurementSuppliers.status })
    .from(procurementSuppliers)
    .where(eq(procurementSuppliers.id, supplierId))
    .limit(1)
  return row && row.status === "ACTIVE" ? { id: row.id, name: row.name } : null
}

async function writePurchaseOrderLines(tx: Tx, purchaseOrderId: number, lines: readonly PurchaseOrderLineInput[]) {
  const { priced, totals } = pricedLines(lines)
  await tx.insert(purchaseOrderLines).values(priced.map((line) => ({
    purchaseOrderId,
    globalProductId: line.globalProductId,
    quantity: line.quantity,
    unitCostCents: line.unitCostCents,
    taxRateBps: line.taxRateBps,
    lineNetCents: line.netCents,
    lineTaxCents: line.taxCents,
    lineTotalCents: line.totalCents,
  })))
  return totals
}

export type PurchaseOrderCreateOutcome =
  | { kind: "created"; id: number; reference: string }
  | { kind: "refused"; error: string }
  | { kind: "conflict"; error: string }

/** Create a draft PO; naming a requisition converts it in the same transaction. */
export async function createPurchaseOrder(input: {
  supplierId: number
  warehouseId: number
  requisitionId?: number | null
  expectedDeliveryDate?: string | null
  notes?: string | null
  lines: readonly PurchaseOrderLineInput[]
  actor: ProcurementActor
}): Promise<PurchaseOrderCreateOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const supplier = await activeSupplier(tx, input.supplierId)
      if (!supplier) return { kind: "refused", error: "Choose an active supplier." } as const
      const warehouse = await activeWarehouse(tx, input.warehouseId)
      if (!warehouse) return { kind: "refused", error: "Choose an active receiving warehouse." } as const
      const refusal = await linesRefusal(tx, input.lines)
      if (refusal) return { kind: "refused", error: refusal } as const

      if (input.requisitionId) {
        const [requisition] = await tx
          .select({ status: purchaseRequisitions.status, warehouseId: purchaseRequisitions.warehouseId })
          .from(purchaseRequisitions)
          .where(eq(purchaseRequisitions.id, input.requisitionId))
          .for("update")
        if (!requisition) return { kind: "refused", error: "That requisition does not exist." } as const
        if (requisition.status !== "SUBMITTED") return { kind: "conflict", error: "That requisition has already been dealt with." } as const
        if (requisition.warehouseId !== warehouse.id) {
          return { kind: "refused", error: "A purchase order receives into the warehouse its requisition was raised for." } as const
        }
      }

      const now = new Date()
      const [order] = await tx
        .insert(purchaseOrders)
        .values({
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          requisitionId: input.requisitionId ?? null,
          expectedDeliveryDate: input.expectedDeliveryDate ?? null,
          notes: input.notes?.trim() || null,
          createdByUserId: input.actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: purchaseOrders.id })
      const totals = await writePurchaseOrderLines(tx, order.id, input.lines)
      await tx
        .update(purchaseOrders)
        .set({ subtotalCents: totals.subtotalCents, taxCents: totals.taxCents, totalCents: totals.totalCents })
        .where(eq(purchaseOrders.id, order.id))

      if (input.requisitionId) {
        await tx
          .update(purchaseRequisitions)
          .set({ status: "CONVERTED", purchaseOrderId: order.id, decidedByUserId: input.actor.id, decidedAt: now, updatedAt: now })
          .where(eq(purchaseRequisitions.id, input.requisitionId))
      }
      await recordAuditEvent(tx, {
        action: "CREATE_PURCHASE_ORDER",
        entity: "purchase_order",
        entityId: order.id,
        actor: input.actor,
        after: {
          supplierId: supplier.id,
          warehouseCode: warehouse.code,
          requisitionId: input.requisitionId ?? null,
          totalCents: totals.totalCents,
          lines: input.lines,
        },
      })
      return { kind: "created", id: order.id, reference: purchaseOrderReference(order.id) } as const
    })
  } catch (caught) {
    if (isUniqueViolation(caught)) return { kind: "conflict", error: "That requisition has already been converted." }
    throw caught
  }
}

export type PurchaseOrderListRow = {
  id: number
  reference: string
  status: string
  supplier: { id: number; name: string }
  warehouse: { id: number; code: string; name: string }
  expectedDeliveryDate: string | null
  totalCents: number
  createdAt: string
  updatedAt: string
}

export async function listPurchaseOrders(
  client: DbClient,
  filter: { status?: string; warehouseId?: number; supplierId?: number; page: number },
): Promise<{ items: PurchaseOrderListRow[]; total: number; page: number; pageSize: number }> {
  const where = and(
    filter.status ? eq(purchaseOrders.status, filter.status) : undefined,
    filter.warehouseId ? eq(purchaseOrders.warehouseId, filter.warehouseId) : undefined,
    filter.supplierId ? eq(purchaseOrders.supplierId, filter.supplierId) : undefined,
  )
  const [count] = await client.select({ total: sql<number>`count(*)`.mapWith(Number) }).from(purchaseOrders).where(where)
  const rows = await client
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      supplierId: procurementSuppliers.id,
      supplierName: procurementSuppliers.name,
      warehouseId: apricartWarehouses.id,
      warehouseCode: apricartWarehouses.code,
      warehouseName: apricartWarehouses.name,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      totalCents: purchaseOrders.totalCents,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(procurementSuppliers, eq(procurementSuppliers.id, purchaseOrders.supplierId))
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, purchaseOrders.warehouseId))
    .where(where)
    .orderBy(desc(purchaseOrders.id))
    .limit(PURCHASE_ORDER_PAGE_SIZE)
    .offset((filter.page - 1) * PURCHASE_ORDER_PAGE_SIZE)
  return {
    items: rows.map((row) => ({
      id: row.id,
      reference: purchaseOrderReference(row.id),
      status: row.status,
      supplier: { id: row.supplierId, name: row.supplierName },
      warehouse: { id: row.warehouseId, code: row.warehouseCode, name: row.warehouseName },
      expectedDeliveryDate: row.expectedDeliveryDate,
      totalCents: Number(row.totalCents),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total: count?.total ?? 0,
    page: filter.page,
    pageSize: PURCHASE_ORDER_PAGE_SIZE,
  }
}

async function loadReceipts(client: DbClient, purchaseOrderId: number) {
  const receipts = await client
    .select({
      id: goodsReceipts.id,
      supplierDeliveryNote: goodsReceipts.supplierDeliveryNote,
      notes: goodsReceipts.notes,
      receivedByUserId: goodsReceipts.receivedByUserId,
      receivedAt: goodsReceipts.receivedAt,
    })
    .from(goodsReceipts)
    .where(eq(goodsReceipts.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(goodsReceipts.id))
  if (receipts.length === 0) return []
  const lines = await client
    .select({
      goodsReceiptId: goodsReceiptLines.goodsReceiptId,
      purchaseOrderLineId: goodsReceiptLines.purchaseOrderLineId,
      productName: globalProducts.name,
      quantity: goodsReceiptLines.quantity,
    })
    .from(goodsReceiptLines)
    .innerJoin(globalProducts, eq(globalProducts.id, goodsReceiptLines.globalProductId))
    .where(inArray(goodsReceiptLines.goodsReceiptId, receipts.map((receipt) => receipt.id)))
    .orderBy(asc(goodsReceiptLines.id))
  const names = await namesByUserId(client, receipts.map((receipt) => receipt.receivedByUserId))
  return receipts.map((receipt) => ({
    id: receipt.id,
    reference: goodsReceiptReference(receipt.id),
    supplierDeliveryNote: receipt.supplierDeliveryNote,
    notes: receipt.notes,
    receivedBy: receipt.receivedByUserId ? names.get(receipt.receivedByUserId) ?? null : null,
    receivedAt: receipt.receivedAt.toISOString(),
    lines: lines
      .filter((line) => line.goodsReceiptId === receipt.id)
      .map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, productName: line.productName, quantity: Number(line.quantity) })),
  }))
}

async function loadPurchaseOrderLines(client: DbClient, purchaseOrderId: number) {
  return client
    .select({
      id: purchaseOrderLines.id,
      globalProductId: purchaseOrderLines.globalProductId,
      productName: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantity: purchaseOrderLines.quantity,
      unitCostCents: purchaseOrderLines.unitCostCents,
      taxRateBps: purchaseOrderLines.taxRateBps,
      lineNetCents: purchaseOrderLines.lineNetCents,
      lineTaxCents: purchaseOrderLines.lineTaxCents,
      lineTotalCents: purchaseOrderLines.lineTotalCents,
      receivedQuantity: purchaseOrderLines.receivedQuantity,
    })
    .from(purchaseOrderLines)
    .innerJoin(globalProducts, eq(globalProducts.id, purchaseOrderLines.globalProductId))
    .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId))
    .orderBy(asc(purchaseOrderLines.id))
}

async function loadPurchaseOrderHeader(client: DbClient, id: number) {
  const [row] = await client
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      supplierId: procurementSuppliers.id,
      supplierName: procurementSuppliers.name,
      warehouseId: apricartWarehouses.id,
      warehouseCode: apricartWarehouses.code,
      warehouseName: apricartWarehouses.name,
      requisitionId: purchaseOrders.requisitionId,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      notes: purchaseOrders.notes,
      overDeliveryToleranceBps: purchaseOrders.overDeliveryToleranceBps,
      subtotalCents: purchaseOrders.subtotalCents,
      taxCents: purchaseOrders.taxCents,
      totalCents: purchaseOrders.totalCents,
      createdByUserId: purchaseOrders.createdByUserId,
      submittedAt: purchaseOrders.submittedAt,
      approvedByUserId: purchaseOrders.approvedByUserId,
      approvedAt: purchaseOrders.approvedAt,
      decidedByUserId: purchaseOrders.decidedByUserId,
      decidedAt: purchaseOrders.decidedAt,
      decisionReason: purchaseOrders.decisionReason,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(procurementSuppliers, eq(procurementSuppliers.id, purchaseOrders.supplierId))
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, purchaseOrders.warehouseId))
    .where(eq(purchaseOrders.id, id))
    .limit(1)
  return row ?? null
}

/** One PO with its costs, receipts and invoices — the procurement view. */
export async function loadPurchaseOrder(client: DbClient, id: number) {
  const header = await loadPurchaseOrderHeader(client, id)
  if (!header) return null
  const [lines, receipts, invoices, tolerance] = await Promise.all([
    loadPurchaseOrderLines(client, id),
    loadReceipts(client, id),
    client
      .select({
        id: supplierInvoices.id,
        invoiceNumber: supplierInvoices.invoiceNumber,
        invoiceDate: supplierInvoices.invoiceDate,
        totalCents: supplierInvoices.totalCents,
        matchStatus: supplierInvoices.matchStatus,
        status: supplierInvoices.status,
      })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.purchaseOrderId, id))
      .orderBy(asc(supplierInvoices.id)),
    loadProcurementSettings(client),
  ])
  const names = await namesByUserId(client, [header.createdByUserId, header.approvedByUserId, header.decidedByUserId])
  const named = (userId: string | null) => (userId ? names.get(userId) ?? null : null)
  return {
    id: header.id,
    reference: purchaseOrderReference(header.id),
    status: header.status,
    supplier: { id: header.supplierId, name: header.supplierName },
    warehouse: { id: header.warehouseId, code: header.warehouseCode, name: header.warehouseName },
    requisition: header.requisitionId ? { id: header.requisitionId, reference: requisitionReference(header.requisitionId) } : null,
    expectedDeliveryDate: header.expectedDeliveryDate,
    notes: header.notes,
    // Approved POs carry their own snapshot; a draft would be approved at today's setting.
    overDeliveryToleranceBps: header.overDeliveryToleranceBps ?? tolerance.overDeliveryToleranceBps,
    toleranceIsSnapshot: header.overDeliveryToleranceBps !== null,
    subtotalCents: Number(header.subtotalCents),
    taxCents: Number(header.taxCents),
    totalCents: Number(header.totalCents),
    createdBy: named(header.createdByUserId),
    submittedAt: header.submittedAt?.toISOString() ?? null,
    approvedBy: named(header.approvedByUserId),
    approvedAt: header.approvedAt?.toISOString() ?? null,
    decidedBy: named(header.decidedByUserId),
    decidedAt: header.decidedAt?.toISOString() ?? null,
    decisionReason: header.decisionReason,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
    lines: lines.map((line) => ({
      id: line.id,
      globalProductId: line.globalProductId,
      productName: line.productName,
      productCode: line.productCode,
      unit: line.unit,
      allowDecimalQuantity: line.allowDecimalQuantity,
      quantity: Number(line.quantity),
      unitCostCents: Number(line.unitCostCents),
      taxRateBps: line.taxRateBps,
      lineNetCents: Number(line.lineNetCents),
      lineTaxCents: Number(line.lineTaxCents),
      lineTotalCents: Number(line.lineTotalCents),
      receivedQuantity: Number(line.receivedQuantity),
      outstandingQuantity: outstandingQuantity({ quantity: Number(line.quantity), receivedQuantity: Number(line.receivedQuantity) }),
    })),
    receipts,
    invoices: invoices.map((invoice) => ({ ...invoice, totalCents: Number(invoice.totalCents) })),
  }
}

export type PurchaseOrderActionOutcome =
  | { kind: "done"; status: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "conflict"; error: string }

const CHANGED_MESSAGE = "This purchase order changed since you opened it. Reload it and try again."

const ACTION_AUDIT: Readonly<Record<PurchaseOrderAction, string>> = {
  update: "UPDATE_PURCHASE_ORDER",
  submit: "SUBMIT_PURCHASE_ORDER",
  withdraw: "WITHDRAW_PURCHASE_ORDER",
  approve: "APPROVE_PURCHASE_ORDER",
  reject: "REJECT_PURCHASE_ORDER",
  cancel: "CANCEL_PURCHASE_ORDER",
  close: "CLOSE_PURCHASE_ORDER",
}

type LockedPurchaseOrder = { id: number; status: string; supplierId: number; warehouseId: number; requisitionId: number | null }
type ActionResult = { outcome: PurchaseOrderActionOutcome } | { context: Record<string, unknown> }

const refuse = (error: string): ActionResult => ({ outcome: { kind: "refused", error } })

/** Replace a draft's supplier, warehouse, date, notes and lines, and its totals. */
async function updateDraftInTx(
  tx: Tx,
  order: LockedPurchaseOrder,
  body: Extract<PurchaseOrderActionInput, { action: "update" }>,
  now: Date,
): Promise<ActionResult> {
  const supplier = await activeSupplier(tx, body.supplierId)
  if (!supplier) return refuse("Choose an active supplier.")
  const warehouse = await activeWarehouse(tx, body.warehouseId)
  if (!warehouse) return refuse("Choose an active receiving warehouse.")
  if (order.requisitionId && warehouse.id !== order.warehouseId) {
    return refuse("A purchase order receives into the warehouse its requisition was raised for.")
  }
  const linesError = await linesRefusal(tx, body.lines)
  if (linesError) return refuse(linesError)
  await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, order.id))
  const totals = await writePurchaseOrderLines(tx, order.id, body.lines)
  await tx
    .update(purchaseOrders)
    .set({
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      expectedDeliveryDate: body.expectedDeliveryDate ?? null,
      notes: body.notes?.trim() || null,
      ...totals,
      updatedAt: now,
    })
    .where(eq(purchaseOrders.id, order.id))
  return { context: { totalCents: totals.totalCents, lines: body.lines } }
}

/** Apply one allowed action to the locked PO; the caller has checked state and version. */
async function applyPurchaseOrderAction(
  tx: Tx,
  order: LockedPurchaseOrder,
  body: PurchaseOrderActionInput,
  actor: ProcurementActor,
  now: Date,
): Promise<ActionResult> {
  const status = purchaseOrderStatusAfter(body.action)
  const byId = eq(purchaseOrders.id, order.id)
  switch (body.action) {
    case "update":
      return updateDraftInTx(tx, order, body, now)
    case "submit": {
      if (!await activeSupplier(tx, order.supplierId)) return refuse("The supplier is inactive; choose another before submitting.")
      if (!await activeWarehouse(tx, order.warehouseId)) return refuse("The receiving warehouse is inactive; choose another before submitting.")
      await tx.update(purchaseOrders).set({ status, submittedAt: now, updatedAt: now }).where(byId)
      return { context: {} }
    }
    case "withdraw":
      await tx.update(purchaseOrders).set({ status, submittedAt: null, updatedAt: now }).where(byId)
      return { context: {} }
    case "approve": {
      const { overDeliveryToleranceBps } = await loadProcurementSettings(tx)
      await tx
        .update(purchaseOrders)
        .set({ status, overDeliveryToleranceBps, approvedByUserId: actor.id, approvedAt: now, decidedByUserId: actor.id, decidedAt: now, updatedAt: now })
        .where(byId)
      return { context: { overDeliveryToleranceBps } }
    }
    case "cancel": {
      const [received] = await tx
        .select({ any: sql<boolean>`bool_or(${purchaseOrderLines.receivedQuantity} > 0)` })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, order.id))
      if (received?.any) {
        return { outcome: { kind: "conflict", error: "Goods have been received against this purchase order; close it short instead." } }
      }
      break
    }
    case "reject":
    case "close":
      break
  }
  await tx
    .update(purchaseOrders)
    .set({ status, decidedByUserId: actor.id, decidedAt: now, decisionReason: body.reason, updatedAt: now })
    .where(byId)
  return { context: { reason: body.reason } }
}

/** Every change to an existing PO, under its row lock, naming the `updatedAt` it saw. */
export async function actOnPurchaseOrder(input: {
  id: number
  body: PurchaseOrderActionInput
  actor: ProcurementActor
}): Promise<PurchaseOrderActionOutcome> {
  const { body } = input
  if ((body.action === "approve" || body.action === "reject") && !canApprovePurchaseOrders(input.actor.role)) {
    return { kind: "forbidden", error: "Only Super Admin approves or rejects a purchase order." }
  }
  return db.transaction(async (tx): Promise<PurchaseOrderActionOutcome> => {
    const [order] = await tx
      .select({
        id: purchaseOrders.id,
        status: purchaseOrders.status,
        updatedAt: purchaseOrders.updatedAt,
        supplierId: purchaseOrders.supplierId,
        warehouseId: purchaseOrders.warehouseId,
        requisitionId: purchaseOrders.requisitionId,
      })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.id))
      .for("update")
    if (!order) return { kind: "not-found" }
    if (!sameInstant(order.updatedAt, body.expectedUpdatedAt)) return { kind: "conflict", error: CHANGED_MESSAGE }
    const refusal = purchaseOrderActionRefusal(body.action, order.status)
    if (refusal) return { kind: "conflict", error: refusal }

    const result = await applyPurchaseOrderAction(tx, order, body, input.actor, new Date())
    if ("outcome" in result) return result.outcome
    const status = purchaseOrderStatusAfter(body.action)
    await recordAuditEvent(tx, {
      action: ACTION_AUDIT[body.action],
      entity: "purchase_order",
      entityId: order.id,
      actor: input.actor,
      before: { status: order.status },
      after: { status },
      context: result.context,
    })
    return { kind: "done", status }
  })
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

export type GoodsReceiptOutcome =
  | { kind: "received"; id: number; reference: string; status: string }
  | { kind: "not-found" }
  | { kind: "conflict"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "stock-ledger-global" }

/**
 * Record what arrived against an approved PO and put it on the receiving
 * warehouse's shelf, in one transaction. `resolveAllowedWarehouseIds` fences a
 * warehouse account to the POs of its own warehouses, re-read inside the
 * transaction (FOR SHARE on its memberships); anything else is 404.
 */
export async function recordGoodsReceipt(input: {
  purchaseOrderId: number
  supplierDeliveryNote?: string | null
  notes?: string | null
  lines: ReadonlyArray<{ purchaseOrderLineId: number; quantity: number }>
  resolveAllowedWarehouseIds: ((tx: Tx) => Promise<readonly number[]>) | null
  actor: ProcurementActor
}): Promise<GoodsReceiptOutcome> {
  return db.transaction(async (tx): Promise<GoodsReceiptOutcome> => {
    const allowed = input.resolveAllowedWarehouseIds ? await input.resolveAllowedWarehouseIds(tx) : null
    if (allowed !== null && allowed.length === 0) return { kind: "not-found" }
    const [order] = await tx
      .select({ id: purchaseOrders.id, status: purchaseOrders.status, warehouseId: purchaseOrders.warehouseId, toleranceBps: purchaseOrders.overDeliveryToleranceBps })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, input.purchaseOrderId))
      .for("update")
    if (!order) return { kind: "not-found" }
    if (allowed !== null && !allowed.includes(order.warehouseId)) return { kind: "not-found" }
    if (!isReceivableStatus(order.status) || order.toleranceBps === null) {
      return { kind: "conflict", error: "Goods can be received only against an approved purchase order that is still open." }
    }
    if (!usesWarehouseStock()) return { kind: "stock-ledger-global" }

    const poLines = (await loadPurchaseOrderLines(tx, order.id)).map((line) => ({
      id: line.id,
      globalProductId: line.globalProductId,
      productName: line.productName,
      quantity: Number(line.quantity),
      receivedQuantity: Number(line.receivedQuantity),
      allowDecimalQuantity: line.allowDecimalQuantity,
    }))
    const plan = planGoodsReceipt({ poLines, toleranceBps: order.toleranceBps, receipt: input.lines })
    if (!plan.ok) return { kind: "refused", error: plan.error }

    const now = new Date()
    const [receipt] = await tx
      .insert(goodsReceipts)
      .values({
        purchaseOrderId: order.id,
        warehouseId: order.warehouseId,
        supplierDeliveryNote: input.supplierDeliveryNote?.trim() || null,
        notes: input.notes?.trim() || null,
        receivedByUserId: input.actor.id,
        receivedByRole: input.actor.role,
        receivedAt: now,
      })
      .returning({ id: goodsReceipts.id })
    await tx.insert(goodsReceiptLines).values(plan.lines.map((line) => ({
      goodsReceiptId: receipt.id,
      purchaseOrderLineId: line.purchaseOrderLineId,
      globalProductId: line.globalProductId,
      quantity: line.quantity,
    })))
    for (const line of plan.lines) {
      await tx
        .update(purchaseOrderLines)
        .set({ receivedQuantity: line.receivedAfter })
        .where(eq(purchaseOrderLines.id, line.purchaseOrderLineId))
    }
    const status = plan.fullyReceived ? "RECEIVED" : "PARTIALLY_RECEIVED"
    await tx.update(purchaseOrders).set({ status, updatedAt: now }).where(eq(purchaseOrders.id, order.id))

    const stock = await addToWarehouseStock(tx, {
      warehouseId: order.warehouseId,
      lines: plan.lines.map((line) => ({ globalProductId: line.globalProductId, quantity: line.quantity })),
      source: { kind: "goods-receipt", goodsReceiptId: receipt.id },
      reason: `Received against ${purchaseOrderReference(order.id)}`,
      actor: input.actor,
    })
    await recordAuditEvent(tx, {
      action: "RECORD_GOODS_RECEIPT",
      entity: "goods_receipt",
      entityId: receipt.id,
      actor: input.actor,
      before: { status: order.status },
      after: { status },
      context: {
        purchaseOrderId: order.id,
        warehouseId: order.warehouseId,
        lines: plan.lines.map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity })),
        onHandAfter: stock,
      },
    })
    return { kind: "received", id: receipt.id, reference: goodsReceiptReference(receipt.id), status }
  })
}

// ---------------------------------------------------------------------------
// Warehouse-facing reads (no cost)
// ---------------------------------------------------------------------------

const WAREHOUSE_VISIBLE_PO_STATUSES = ["APPROVED", "PARTIALLY_RECEIVED", "RECEIVED", "CLOSED"]

/** Approved POs receiving into the warehouse's own warehouses. No cost column is read. */
export async function listWarehousePurchaseOrders(client: DbClient, warehouseIds: readonly number[]) {
  if (warehouseIds.length === 0) return []
  const rows = await client
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      supplierName: procurementSuppliers.name,
      warehouseId: apricartWarehouses.id,
      warehouseCode: apricartWarehouses.code,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      approvedAt: purchaseOrders.approvedAt,
      orderedQuantity: sql<number>`(SELECT COALESCE(SUM(${purchaseOrderLines.quantity}), 0) FROM ${purchaseOrderLines} WHERE ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`.mapWith(Number),
      receivedQuantity: sql<number>`(SELECT COALESCE(SUM(${purchaseOrderLines.receivedQuantity}), 0) FROM ${purchaseOrderLines} WHERE ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`.mapWith(Number),
    })
    .from(purchaseOrders)
    .innerJoin(procurementSuppliers, eq(procurementSuppliers.id, purchaseOrders.supplierId))
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, purchaseOrders.warehouseId))
    .where(and(inArray(purchaseOrders.warehouseId, [...warehouseIds]), inArray(purchaseOrders.status, WAREHOUSE_VISIBLE_PO_STATUSES)))
    .orderBy(desc(purchaseOrders.id))
    .limit(PROCUREMENT_LIST_LIMIT)
  return rows.map((row) => ({
    id: row.id,
    reference: purchaseOrderReference(row.id),
    status: row.status,
    supplierName: row.supplierName,
    warehouse: { id: row.warehouseId, code: row.warehouseCode },
    expectedDeliveryDate: row.expectedDeliveryDate,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    orderedQuantity: row.orderedQuantity,
    receivedQuantity: row.receivedQuantity,
  }))
}

/** One approved PO for receiving: quantities, never costs. Null outside the warehouses. */
export async function loadWarehousePurchaseOrder(client: DbClient, id: number, warehouseIds: readonly number[]) {
  if (warehouseIds.length === 0) return null
  const [header] = await client
    .select({
      id: purchaseOrders.id,
      status: purchaseOrders.status,
      supplierName: procurementSuppliers.name,
      warehouseId: apricartWarehouses.id,
      warehouseCode: apricartWarehouses.code,
      warehouseName: apricartWarehouses.name,
      expectedDeliveryDate: purchaseOrders.expectedDeliveryDate,
      notes: purchaseOrders.notes,
      overDeliveryToleranceBps: purchaseOrders.overDeliveryToleranceBps,
    })
    .from(purchaseOrders)
    .innerJoin(procurementSuppliers, eq(procurementSuppliers.id, purchaseOrders.supplierId))
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, purchaseOrders.warehouseId))
    .where(and(
      eq(purchaseOrders.id, id),
      inArray(purchaseOrders.warehouseId, [...warehouseIds]),
      inArray(purchaseOrders.status, WAREHOUSE_VISIBLE_PO_STATUSES),
    ))
    .limit(1)
  if (!header) return null
  const [lines, receipts] = await Promise.all([
    client
      .select({
        id: purchaseOrderLines.id,
        globalProductId: purchaseOrderLines.globalProductId,
        productName: globalProducts.name,
        productCode: globalProducts.productCode,
        unit: globalProducts.unit,
        allowDecimalQuantity: globalProducts.allowDecimalQuantity,
        quantity: purchaseOrderLines.quantity,
        receivedQuantity: purchaseOrderLines.receivedQuantity,
      })
      .from(purchaseOrderLines)
      .innerJoin(globalProducts, eq(globalProducts.id, purchaseOrderLines.globalProductId))
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.id)),
    loadReceipts(client, id),
  ])
  return {
    id: header.id,
    reference: purchaseOrderReference(header.id),
    status: header.status,
    supplierName: header.supplierName,
    warehouse: { id: header.warehouseId, code: header.warehouseCode, name: header.warehouseName },
    expectedDeliveryDate: header.expectedDeliveryDate,
    notes: header.notes,
    overDeliveryToleranceBps: header.overDeliveryToleranceBps ?? DEFAULT_OVER_DELIVERY_TOLERANCE_BPS,
    stockLedgerOn: usesWarehouseStock(),
    lines: lines.map((line) => ({
      id: line.id,
      globalProductId: line.globalProductId,
      productName: line.productName,
      productCode: line.productCode,
      unit: line.unit,
      allowDecimalQuantity: line.allowDecimalQuantity,
      quantity: Number(line.quantity),
      receivedQuantity: Number(line.receivedQuantity),
      outstandingQuantity: outstandingQuantity({ quantity: Number(line.quantity), receivedQuantity: Number(line.receivedQuantity) }),
    })),
    receipts,
  }
}

// ---------------------------------------------------------------------------
// Supplier invoices and the three-way match
// ---------------------------------------------------------------------------

async function invoicedByLine(tx: DbClient, purchaseOrderId: number, excludeInvoiceId?: number): Promise<Map<number, number>> {
  const rows = await tx
    .select({
      purchaseOrderLineId: supplierInvoiceLines.purchaseOrderLineId,
      quantity: sql<number>`COALESCE(SUM(${supplierInvoiceLines.quantity}), 0)`.mapWith(Number),
    })
    .from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.supplierInvoiceId))
    .where(and(
      eq(supplierInvoices.purchaseOrderId, purchaseOrderId),
      ne(supplierInvoices.status, "REJECTED"),
      excludeInvoiceId === undefined ? undefined : ne(supplierInvoices.id, excludeInvoiceId),
    ))
    .groupBy(supplierInvoiceLines.purchaseOrderLineId)
  return new Map(rows.map((row) => [row.purchaseOrderLineId, row.quantity]))
}

async function matchPoLines(tx: DbClient, purchaseOrderId: number) {
  return (await loadPurchaseOrderLines(tx, purchaseOrderId)).map((line) => ({
    id: line.id,
    productName: line.productName,
    unitCostCents: Number(line.unitCostCents),
    taxRateBps: line.taxRateBps,
    receivedQuantity: Number(line.receivedQuantity),
    allowDecimalQuantity: line.allowDecimalQuantity,
  }))
}

export type SupplierInvoiceRecordOutcome =
  | { kind: "recorded"; id: number; matchStatus: InvoiceMatchStatus; exceptions: string[] }
  | { kind: "not-found" }
  | { kind: "conflict"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "duplicate" }

export async function recordSupplierInvoice(input: {
  purchaseOrderId: number
  invoiceNumber: string
  invoiceDate: string
  lines: ReadonlyArray<{ purchaseOrderLineId: number; quantity: number; unitCostCents: number }>
  actor: ProcurementActor
}): Promise<SupplierInvoiceRecordOutcome> {
  try {
    return await db.transaction(async (tx): Promise<SupplierInvoiceRecordOutcome> => {
      const [order] = await tx
        .select({ id: purchaseOrders.id, status: purchaseOrders.status, supplierId: purchaseOrders.supplierId })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, input.purchaseOrderId))
        .for("update")
      if (!order) return { kind: "not-found" }
      if (!isInvoiceableStatus(order.status)) return { kind: "conflict", error: "An invoice can be recorded only against an approved purchase order." }

      const plan = planSupplierInvoice({
        poLines: await matchPoLines(tx, order.id),
        alreadyInvoicedByLine: await invoicedByLine(tx, order.id),
        lines: input.lines,
      })
      if (!plan.ok) return { kind: "refused", error: plan.error }

      const now = new Date()
      const [invoice] = await tx
        .insert(supplierInvoices)
        .values({
          supplierId: order.supplierId,
          purchaseOrderId: order.id,
          invoiceNumber: input.invoiceNumber.trim(),
          invoiceDate: input.invoiceDate,
          ...plan.totals,
          matchStatus: plan.matchStatus,
          recordedByUserId: input.actor.id,
          recordedByRole: input.actor.role,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: supplierInvoices.id })
      await tx.insert(supplierInvoiceLines).values(plan.lines.map((line) => ({
        supplierInvoiceId: invoice.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        quantity: line.quantity,
        unitCostCents: line.unitCostCents,
        lineNetCents: line.netCents,
        lineTaxCents: line.taxCents,
        lineTotalCents: line.totalCents,
      })))
      await recordAuditEvent(tx, {
        action: "RECORD_SUPPLIER_INVOICE",
        entity: "supplier_invoice",
        entityId: invoice.id,
        actor: input.actor,
        after: { purchaseOrderId: order.id, invoiceNumber: input.invoiceNumber.trim(), totalCents: plan.totals.totalCents, matchStatus: plan.matchStatus },
        context: { exceptions: plan.exceptions },
      })
      return { kind: "recorded", id: invoice.id, matchStatus: plan.matchStatus, exceptions: plan.exceptions }
    })
  } catch (caught) {
    if (isUniqueViolation(caught)) return { kind: "duplicate" }
    throw caught
  }
}

export type SupplierInvoiceListRow = {
  id: number
  invoiceNumber: string
  invoiceDate: string
  supplier: { id: number; name: string }
  purchaseOrderId: number
  purchaseOrderReference: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  matchStatus: string
  status: string
  decisionReason: string | null
  paymentReference: string | null
  createdAt: string
  lines: Array<{
    purchaseOrderLineId: number
    productName: string
    quantity: number
    unitCostCents: number
    poUnitCostCents: number
    receivedQuantity: number
    lineTotalCents: number
  }>
}

export async function listSupplierInvoices(client: DbClient, filter: { status?: string; purchaseOrderId?: number }): Promise<SupplierInvoiceListRow[]> {
  const rows = await client
    .select({
      id: supplierInvoices.id,
      invoiceNumber: supplierInvoices.invoiceNumber,
      invoiceDate: supplierInvoices.invoiceDate,
      supplierId: procurementSuppliers.id,
      supplierName: procurementSuppliers.name,
      purchaseOrderId: supplierInvoices.purchaseOrderId,
      subtotalCents: supplierInvoices.subtotalCents,
      taxCents: supplierInvoices.taxCents,
      totalCents: supplierInvoices.totalCents,
      matchStatus: supplierInvoices.matchStatus,
      status: supplierInvoices.status,
      decisionReason: supplierInvoices.decisionReason,
      paymentReference: supplierInvoices.paymentReference,
      createdAt: supplierInvoices.createdAt,
    })
    .from(supplierInvoices)
    .innerJoin(procurementSuppliers, eq(procurementSuppliers.id, supplierInvoices.supplierId))
    .where(and(
      filter.status ? eq(supplierInvoices.status, filter.status) : undefined,
      filter.purchaseOrderId ? eq(supplierInvoices.purchaseOrderId, filter.purchaseOrderId) : undefined,
    ))
    .orderBy(desc(supplierInvoices.id))
    .limit(PROCUREMENT_LIST_LIMIT)
  if (rows.length === 0) return []
  const lines = await client
    .select({
      supplierInvoiceId: supplierInvoiceLines.supplierInvoiceId,
      purchaseOrderLineId: supplierInvoiceLines.purchaseOrderLineId,
      productName: globalProducts.name,
      quantity: supplierInvoiceLines.quantity,
      unitCostCents: supplierInvoiceLines.unitCostCents,
      poUnitCostCents: purchaseOrderLines.unitCostCents,
      receivedQuantity: purchaseOrderLines.receivedQuantity,
      lineTotalCents: supplierInvoiceLines.lineTotalCents,
    })
    .from(supplierInvoiceLines)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, supplierInvoiceLines.purchaseOrderLineId))
    .innerJoin(globalProducts, eq(globalProducts.id, purchaseOrderLines.globalProductId))
    .where(inArray(supplierInvoiceLines.supplierInvoiceId, rows.map((row) => row.id)))
    .orderBy(asc(supplierInvoiceLines.id))
  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    invoiceDate: row.invoiceDate,
    supplier: { id: row.supplierId, name: row.supplierName },
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReference: purchaseOrderReference(row.purchaseOrderId),
    subtotalCents: Number(row.subtotalCents),
    taxCents: Number(row.taxCents),
    totalCents: Number(row.totalCents),
    matchStatus: row.matchStatus,
    status: row.status,
    decisionReason: row.decisionReason,
    paymentReference: row.paymentReference,
    createdAt: row.createdAt.toISOString(),
    lines: lines
      .filter((line) => line.supplierInvoiceId === row.id)
      .map((line) => ({
        purchaseOrderLineId: line.purchaseOrderLineId,
        productName: line.productName,
        quantity: Number(line.quantity),
        unitCostCents: Number(line.unitCostCents),
        poUnitCostCents: Number(line.poUnitCostCents),
        receivedQuantity: Number(line.receivedQuantity),
        lineTotalCents: Number(line.lineTotalCents),
      })),
  }))
}

export type SupplierInvoiceDecisionOutcome =
  | { kind: "decided"; status: string; matchStatus: string }
  | { kind: "not-found" }
  | { kind: "forbidden"; error: string }
  | { kind: "conflict"; error: string }
  | { kind: "refused"; error: string }

/**
 * Approve (the match is re-run against what has been received now), reject, or
 * mark paid. An exception is approved by Super Admin only, with a reason.
 */
export async function decideSupplierInvoice(input: {
  id: number
  body: SupplierInvoiceDecisionInput
  actor: ProcurementActor
}): Promise<SupplierInvoiceDecisionOutcome> {
  const { body } = input
  return db.transaction(async (tx): Promise<SupplierInvoiceDecisionOutcome> => {
    const [invoice] = await tx
      .select({ id: supplierInvoices.id, status: supplierInvoices.status, matchStatus: supplierInvoices.matchStatus, purchaseOrderId: supplierInvoices.purchaseOrderId })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.id, input.id))
      .for("update")
    if (!invoice) return { kind: "not-found" }
    const refusal = supplierInvoiceDecisionRefusal(body.action, invoice.status)
    if (refusal) return { kind: "conflict", error: refusal }

    const now = new Date()
    let matchStatus = invoice.matchStatus
    let status: string
    const context: Record<string, unknown> = {}

    if (body.action === "approve") {
      // The PO's lock serializes this with a receipt or another invoice on it.
      await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, invoice.purchaseOrderId)).for("update")
      const lines = await tx
        .select({ purchaseOrderLineId: supplierInvoiceLines.purchaseOrderLineId, quantity: supplierInvoiceLines.quantity, unitCostCents: supplierInvoiceLines.unitCostCents })
        .from(supplierInvoiceLines)
        .where(eq(supplierInvoiceLines.supplierInvoiceId, invoice.id))
      const plan = planSupplierInvoice({
        poLines: await matchPoLines(tx, invoice.purchaseOrderId),
        alreadyInvoicedByLine: await invoicedByLine(tx, invoice.purchaseOrderId, invoice.id),
        lines: lines.map((line) => ({ ...line, quantity: Number(line.quantity), unitCostCents: Number(line.unitCostCents) })),
      })
      if (!plan.ok) return { kind: "refused", error: plan.error }
      matchStatus = plan.matchStatus
      if (matchStatus === "EXCEPTION") {
        if (!canApproveInvoiceExceptions(input.actor.role)) {
          return { kind: "forbidden", error: `This invoice does not match (${plan.exceptions.join(" ")}). Only Super Admin may approve it.` }
        }
        if (!body.reason) return { kind: "refused", error: "Give a reason for approving an invoice that does not match." }
      }
      status = "APPROVED"
      Object.assign(context, { exceptions: plan.exceptions, reason: body.reason ?? null })
      await tx
        .update(supplierInvoices)
        .set({ status, matchStatus, decidedByUserId: input.actor.id, decidedAt: now, decisionReason: body.reason ?? null, updatedAt: now })
        .where(eq(supplierInvoices.id, invoice.id))
    } else if (body.action === "reject") {
      status = "REJECTED"
      context.reason = body.reason
      await tx
        .update(supplierInvoices)
        .set({ status, decidedByUserId: input.actor.id, decidedAt: now, decisionReason: body.reason, updatedAt: now })
        .where(eq(supplierInvoices.id, invoice.id))
    } else {
      status = "PAID"
      context.paymentReference = body.paymentReference ?? null
      await tx
        .update(supplierInvoices)
        .set({ status, paidByUserId: input.actor.id, paidAt: now, paymentReference: body.paymentReference?.trim() || null, updatedAt: now })
        .where(eq(supplierInvoices.id, invoice.id))
    }

    const auditAction = { approve: "APPROVE_SUPPLIER_INVOICE", reject: "REJECT_SUPPLIER_INVOICE", pay: "PAY_SUPPLIER_INVOICE" }[body.action]
    await recordAuditEvent(tx, {
      action: auditAction,
      entity: "supplier_invoice",
      entityId: invoice.id,
      actor: input.actor,
      before: { status: invoice.status, matchStatus: invoice.matchStatus },
      after: { status, matchStatus },
      context,
    })
    return { kind: "decided", status, matchStatus }
  })
}

// ---------------------------------------------------------------------------
// Shortages
// ---------------------------------------------------------------------------

export type ShortageRow = {
  warehouseId: number | null
  warehouseCode: string | null
  globalProductId: number
  productName: string
  productCode: string
  unit: string
  onHand: number
  reserved: number
  onOrder: number
  shortfall: number
}

/**
 * Where open orders need more than the shelf holds, and what is already on
 * order to cover it. Orders at a branch with no warehouse are reported under
 * no warehouse. Read-only and bounded.
 */
export async function loadShortages(client: DbClient): Promise<ShortageRow[]> {
  const warehouseExpr = orderStockWarehouseSql()
  const reservedRows = await client
    .select({
      warehouseId: sql<number | null>`${warehouseExpr}`,
      globalProductId: orderItems.globalProductId,
      quantity: sql<number>`SUM(${orderItems.quantity})`.mapWith(Number),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .where(openStockOrderSql)
    .groupBy(sql`1`, orderItems.globalProductId)

  const onOrderRows = await client
    .select({
      warehouseId: purchaseOrders.warehouseId,
      globalProductId: purchaseOrderLines.globalProductId,
      quantity: sql<number>`SUM(GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.receivedQuantity}, 0))`.mapWith(Number),
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.purchaseOrderId))
    .where(inArray(purchaseOrders.status, ["APPROVED", "PARTIALLY_RECEIVED"]))
    .groupBy(purchaseOrders.warehouseId, purchaseOrderLines.globalProductId)

  const key = (warehouseId: number | null, productId: number) => `${warehouseId ?? "none"}:${productId}`
  const reserved = new Map(reservedRows.map((row) => [key(row.warehouseId, row.globalProductId), row]))
  const onOrder = new Map(onOrderRows.map((row) => [key(row.warehouseId, row.globalProductId), row.quantity]))
  const pairs = new Map<string, { warehouseId: number | null; globalProductId: number }>()
  for (const row of reservedRows) pairs.set(key(row.warehouseId, row.globalProductId), row)
  for (const row of onOrderRows) pairs.set(key(row.warehouseId, row.globalProductId), row)
  if (pairs.size === 0) return []

  const productIds = [...new Set([...pairs.values()].map((pair) => pair.globalProductId))]
  const warehouseIds = [...new Set([...pairs.values()].flatMap((pair) => (pair.warehouseId === null ? [] : [pair.warehouseId])))]
  const [products, stockRows, warehouses] = await Promise.all([
    loadProducts(client, productIds),
    warehouseIds.length === 0
      ? Promise.resolve([] as Array<{ warehouseId: number; globalProductId: number; onHand: number }>)
      : client
          .select({ warehouseId: warehouseStock.warehouseId, globalProductId: warehouseStock.globalProductId, onHand: warehouseStock.onHandQuantity })
          .from(warehouseStock)
          .where(and(inArray(warehouseStock.warehouseId, warehouseIds), inArray(warehouseStock.globalProductId, productIds))),
    listWarehousesById(client, warehouseIds),
  ])
  const onHand = new Map(stockRows.map((row) => [key(row.warehouseId, row.globalProductId), Number(row.onHand)]))
  const codes = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.code]))

  const rows: ShortageRow[] = []
  for (const [pairKey, pair] of pairs) {
    const product = products.get(pair.globalProductId)
    if (!product) continue
    const reservedQuantity = reserved.get(pairKey)?.quantity ?? 0
    const onHandQuantity = onHand.get(pairKey) ?? 0
    const onOrderQuantity = onOrder.get(pairKey) ?? 0
    if (reservedQuantity <= onHandQuantity && onOrderQuantity <= 0) continue
    rows.push({
      warehouseId: pair.warehouseId,
      warehouseCode: pair.warehouseId === null ? null : codes.get(pair.warehouseId) ?? null,
      globalProductId: pair.globalProductId,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
      onHand: onHandQuantity,
      reserved: reservedQuantity,
      onOrder: onOrderQuantity,
      shortfall: Math.max(0, Math.round((reservedQuantity - onHandQuantity - onOrderQuantity) * 1000) / 1000),
    })
  }
  return rows
    .sort((a, b) => b.shortfall - a.shortfall || a.productName.localeCompare(b.productName))
    .slice(0, 500)
}

// ---------------------------------------------------------------------------
// Customer returns
// ---------------------------------------------------------------------------

export type CustomerReturnRow = {
  id: number
  reference: string
  warehouse: { id: number; code: string; name: string }
  orderId: number | null
  orderTid: string | null
  status: string
  reason: string
  recordedBy: string | null
  decidedBy: string | null
  decidedAt: string | null
  decisionReason: string | null
  createdAt: string
  lines: Array<{ globalProductId: number; productName: string; productCode: string; unit: string; quantity: number; condition: string }>
}

/** Returns, newest first. `warehouseIds` null reads every warehouse; an array (even empty) is a fence. */
export async function listCustomerReturns(
  client: DbClient,
  filter: { warehouseIds: readonly number[] | null; status?: string },
): Promise<CustomerReturnRow[]> {
  if (filter.warehouseIds !== null && filter.warehouseIds.length === 0) return []
  const rows = await client
    .select({
      id: customerReturns.id,
      warehouseId: apricartWarehouses.id,
      warehouseCode: apricartWarehouses.code,
      warehouseName: apricartWarehouses.name,
      orderId: customerReturns.orderId,
      orderTid: orders.tid,
      status: customerReturns.status,
      reason: customerReturns.reason,
      recordedByUserId: customerReturns.recordedByUserId,
      decidedByUserId: customerReturns.decidedByUserId,
      decidedAt: customerReturns.decidedAt,
      decisionReason: customerReturns.decisionReason,
      createdAt: customerReturns.createdAt,
    })
    .from(customerReturns)
    .innerJoin(apricartWarehouses, eq(apricartWarehouses.id, customerReturns.warehouseId))
    .leftJoin(orders, eq(orders.id, customerReturns.orderId))
    .where(and(
      filter.warehouseIds === null ? undefined : inArray(customerReturns.warehouseId, [...filter.warehouseIds]),
      filter.status ? eq(customerReturns.status, filter.status) : undefined,
    ))
    .orderBy(desc(customerReturns.id))
    .limit(PROCUREMENT_LIST_LIMIT)
  if (rows.length === 0) return []
  const lines = await client
    .select({
      customerReturnId: customerReturnLines.customerReturnId,
      globalProductId: customerReturnLines.globalProductId,
      productName: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      quantity: customerReturnLines.quantity,
      condition: customerReturnLines.condition,
    })
    .from(customerReturnLines)
    .innerJoin(globalProducts, eq(globalProducts.id, customerReturnLines.globalProductId))
    .where(inArray(customerReturnLines.customerReturnId, rows.map((row) => row.id)))
    .orderBy(asc(customerReturnLines.id))
  const names = await namesByUserId(client, rows.flatMap((row) => [row.recordedByUserId, row.decidedByUserId]))
  const named = (userId: string | null) => (userId ? names.get(userId) ?? null : null)
  return rows.map((row) => ({
    id: row.id,
    reference: customerReturnReference(row.id),
    warehouse: { id: row.warehouseId, code: row.warehouseCode, name: row.warehouseName },
    orderId: row.orderId,
    orderTid: row.orderTid ?? null,
    status: row.status,
    reason: row.reason,
    recordedBy: named(row.recordedByUserId),
    decidedBy: named(row.decidedByUserId),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    createdAt: row.createdAt.toISOString(),
    lines: lines
      .filter((line) => line.customerReturnId === row.id)
      .map((line) => ({
        globalProductId: line.globalProductId,
        productName: line.productName,
        productCode: line.productCode,
        unit: line.unit,
        quantity: Number(line.quantity),
        condition: line.condition,
      })),
  }))
}

/**
 * The order a return names, by TID (any case) or numeric id. A warehouse
 * account finds only orders it works (`loadWarehouseOrderInReach`); Super Admin
 * finds any.
 */
async function resolveReturnOrder(tx: Tx, reference: string, actor: ProcurementActor, fencedToWarehouse: boolean): Promise<number | null> {
  const trimmed = reference.trim()
  const conditions: SQL[] = [sql`lower(${orders.tid}) = lower(${trimmed})`]
  if (/^\d{1,9}$/.test(trimmed)) conditions.push(eq(orders.id, Number(trimmed)))
  const [order] = await tx.select({ id: orders.id }).from(orders).where(or(...conditions)).limit(1)
  if (!order) return null
  if (!fencedToWarehouse) return order.id
  return (await loadWarehouseOrderInReach(tx, actor.id, order.id)) ? order.id : null
}

export type CustomerReturnRecordOutcome =
  | { kind: "recorded"; id: number; reference: string }
  | { kind: "warehouse-not-found" }
  | { kind: "refused"; error: string }

export async function recordCustomerReturn(input: {
  warehouseId: number
  orderReference?: string | null
  reason: string
  lines: ReadonlyArray<{ globalProductId: number; quantity: number; condition: "RESALEABLE" | "DAMAGED" }>
  allowedWarehouseIds: readonly number[] | null
  actor: ProcurementActor
}): Promise<CustomerReturnRecordOutcome> {
  if (input.allowedWarehouseIds !== null && !input.allowedWarehouseIds.includes(input.warehouseId)) {
    return { kind: "warehouse-not-found" }
  }
  return db.transaction(async (tx): Promise<CustomerReturnRecordOutcome> => {
    const [warehouse] = await tx
      .select({ id: apricartWarehouses.id, code: apricartWarehouses.code })
      .from(apricartWarehouses)
      .where(eq(apricartWarehouses.id, input.warehouseId))
      .limit(1)
    if (!warehouse) return { kind: "warehouse-not-found" }

    const seen = new Set<string>()
    for (const line of input.lines) {
      const lineKey = `${line.globalProductId}:${line.condition}`
      if (seen.has(lineKey)) return { kind: "refused", error: "Each product and condition may appear on one line only." }
      seen.add(lineKey)
    }
    const products = await loadProducts(tx, input.lines.map((line) => line.globalProductId))
    for (const line of input.lines) {
      const product = products.get(line.globalProductId)
      if (!product) return { kind: "refused", error: "A product on this return does not exist." }
      const refusal = quantityRefusal(line.quantity, product.allowDecimalQuantity, product.name)
      if (refusal) return { kind: "refused", error: refusal }
    }

    let orderId: number | null = null
    if (input.orderReference?.trim()) {
      orderId = await resolveReturnOrder(tx, input.orderReference, input.actor, input.allowedWarehouseIds !== null)
      if (orderId === null) return { kind: "refused", error: "No order with that reference was found among the orders you work." }
    }

    const now = new Date()
    const [entry] = await tx
      .insert(customerReturns)
      .values({
        warehouseId: warehouse.id,
        orderId,
        reason: input.reason.trim(),
        recordedByUserId: input.actor.id,
        recordedByRole: input.actor.role,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: customerReturns.id })
    await tx.insert(customerReturnLines).values(input.lines.map((line) => ({
      customerReturnId: entry.id,
      globalProductId: line.globalProductId,
      quantity: line.quantity,
      condition: line.condition,
    })))
    await recordAuditEvent(tx, {
      action: "RECORD_CUSTOMER_RETURN",
      entity: "customer_return",
      entityId: entry.id,
      actor: input.actor,
      after: { warehouseCode: warehouse.code, orderId, lines: input.lines },
    })
    return { kind: "recorded", id: entry.id, reference: customerReturnReference(entry.id) }
  })
}

export type CustomerReturnDecisionOutcome =
  | { kind: "decided"; status: string }
  | { kind: "not-found" }
  | { kind: "conflict"; error: string }
  | { kind: "stock-ledger-global" }

/**
 * Approve (resaleable goods go back on the shelf) or reject a pending return.
 * `allowedWarehouseIds` fences an executive to the warehouses it is an
 * executive member of, re-read under FOR SHARE by the caller's loader.
 */
export async function decideCustomerReturn(input: {
  id: number
  action: "approve" | "reject"
  reason?: string
  resolveAllowedWarehouseIds: ((tx: Tx) => Promise<readonly number[]>) | null
  actor: ProcurementActor
}): Promise<CustomerReturnDecisionOutcome> {
  return db.transaction(async (tx): Promise<CustomerReturnDecisionOutcome> => {
    const allowed = input.resolveAllowedWarehouseIds ? await input.resolveAllowedWarehouseIds(tx) : null
    const [entry] = await tx
      .select({ id: customerReturns.id, status: customerReturns.status, warehouseId: customerReturns.warehouseId })
      .from(customerReturns)
      .where(eq(customerReturns.id, input.id))
      .for("update")
    if (!entry) return { kind: "not-found" }
    if (allowed !== null && !allowed.includes(entry.warehouseId)) return { kind: "not-found" }
    if (entry.status !== "PENDING") return { kind: "conflict", error: "This return has already been decided." }

    const now = new Date()
    const status = input.action === "approve" ? "APPROVED" : "REJECTED"
    let stock: Array<{ globalProductId: number; onHandAfter: number }> = []
    if (input.action === "approve") {
      if (!usesWarehouseStock()) return { kind: "stock-ledger-global" }
      const lines = await tx
        .select({ globalProductId: customerReturnLines.globalProductId, quantity: customerReturnLines.quantity, condition: customerReturnLines.condition })
        .from(customerReturnLines)
        .where(eq(customerReturnLines.customerReturnId, entry.id))
      stock = await addToWarehouseStock(tx, {
        warehouseId: entry.warehouseId,
        lines: returnRestockLines(lines.map((line) => ({ ...line, quantity: Number(line.quantity) }))),
        source: { kind: "customer-return", customerReturnId: entry.id },
        reason: `Customer return ${customerReturnReference(entry.id)}`,
        actor: input.actor,
      })
    }
    await tx
      .update(customerReturns)
      .set({ status, decidedByUserId: input.actor.id, decidedByRole: input.actor.role, decidedAt: now, decisionReason: input.reason ?? null, updatedAt: now })
      .where(eq(customerReturns.id, entry.id))
    await recordAuditEvent(tx, {
      action: input.action === "approve" ? "APPROVE_CUSTOMER_RETURN" : "REJECT_CUSTOMER_RETURN",
      entity: "customer_return",
      entityId: entry.id,
      actor: input.actor,
      before: { status: entry.status },
      after: { status },
      context: { reason: input.reason ?? null, onHandAfter: stock },
    })
    return { kind: "decided", status }
  })
}
