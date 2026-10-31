import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or, sql } from "drizzle-orm"

import * as executiveReturnRoute from "@/app/api/v1/executive/returns/[id]/route"
import * as executiveReturnsRoute from "@/app/api/v1/executive/returns/route"
import * as purchaseOrderRoute from "@/app/api/v1/procurement/purchase-orders/[id]/route"
import * as purchaseOrdersRoute from "@/app/api/v1/procurement/purchase-orders/route"
import * as requisitionsRoute from "@/app/api/v1/procurement/requisitions/route"
import * as adminReturnsRoute from "@/app/api/v1/procurement/returns/route"
import * as settingsRoute from "@/app/api/v1/procurement/settings/route"
import * as shortagesRoute from "@/app/api/v1/procurement/shortages/route"
import * as invoiceRoute from "@/app/api/v1/procurement/supplier-invoices/[id]/route"
import * as invoicesRoute from "@/app/api/v1/procurement/supplier-invoices/route"
import * as suppliersRoute from "@/app/api/v1/procurement/suppliers/route"
import * as warehousePurchaseOrderRoute from "@/app/api/v1/warehouse/procurement/purchase-orders/[id]/route"
import * as warehouseReceiptsRoute from "@/app/api/v1/warehouse/procurement/purchase-orders/[id]/receipts/route"
import * as warehouseRequisitionsRoute from "@/app/api/v1/warehouse/procurement/requisitions/route"
import * as warehouseReturnsRoute from "@/app/api/v1/warehouse/procurement/returns/route"
import {
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branchFulfillmentRoutes,
  branches,
  customerReturns,
  globalProducts,
  goodsReceiptLines,
  goodsReceipts,
  orderItems,
  orders,
  organizations,
  procurementSettings,
  procurementSuppliers,
  purchaseOrders,
  purchaseRequisitions,
  roles,
  stockMovements,
  supplierInvoices,
  systemLogs,
  users,
  warehouseStock,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Purchasing against a real database. See plans/OF-PROCUREMENT-purchasing.md.
 *
 * ```text
 * Warehouses KHI (operator khiOperator, executive khiExecutive) and LHR
 * (operator lhrOperator, executive lhrExecutive). Branch K → KHI.
 * Rice: 5 on hand at KHI.
 * ```
 *
 * The stock switch is mocked and flipped per test, so the global-mode refusal
 * is proved too; every other suite runs with the shipped "global" switch.
 */
const ledger = vi.hoisted(() => ({ on: true }))
vi.mock("@/lib/stock-ledger-policy", () => ({
  STOCK_LEDGER_MODES: ["global", "warehouse"],
  STOCK_LEDGER_MODE: "warehouse",
  usesWarehouseStock: () => ledger.on,
}))
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
}

const request = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by procurement tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const BASE = "http://localhost/api/v1"

describe.skipIf(!hasTestDatabase)("purchasing into Apricart warehouses", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let org: number
  let branchK: number
  let khi: number
  let lhr: number
  let rice: number
  let flour: number
  let supplierId: number
  let previousSettings: { bps: number } | null = null

  const onHand = async (warehouseId: number, productId = rice) => {
    const [row] = await db.select({ onHand: warehouseStock.onHandQuantity }).from(warehouseStock)
      .where(and(eq(warehouseStock.warehouseId, warehouseId), eq(warehouseStock.globalProductId, productId)))
    return Number(row?.onHand ?? 0)
  }

  const as = async <T>(actor: Actor | null, call: () => Promise<Response>): Promise<{ status: number; body: T }> => {
    signIn(actor)
    return read(await call()) as Promise<{ status: number; body: T }>
  }

  const loadOrder = async (id: number) => {
    const { body } = await as<{ order: any }>(actors.procurement, () => purchaseOrderRoute.GET(request(`${BASE}/procurement/purchase-orders/${id}`, "GET"), params(id)))
    return body.order
  }

  const act = (actor: Actor, id: number, body: Record<string, unknown>) =>
    as<any>(actor, () => purchaseOrderRoute.PATCH(request(`${BASE}/procurement/purchase-orders/${id}`, "PATCH", body), params(id)))

  /** Draft → submitted → approved by Super Admin; returns the PO id. */
  const approvedOrder = async (lines: Array<{ globalProductId: number; quantity: number; unitCostCents: number; taxRateBps: number }>) => {
    const created = await as<any>(actors.procurement, () => purchaseOrdersRoute.POST(request(`${BASE}/procurement/purchase-orders`, "POST", {
      supplierId, warehouseId: khi, lines,
    })))
    expect(created.status).toBe(201)
    const id = created.body.id as number
    expect((await act(actors.procurement, id, { action: "submit", expectedUpdatedAt: (await loadOrder(id)).updatedAt })).status).toBe(200)
    expect((await act(actors.superAdmin, id, { action: "approve", expectedUpdatedAt: (await loadOrder(id)).updatedAt })).status).toBe(200)
    return id
  }

  const receive = (actor: Actor, id: number, lines: Array<{ purchaseOrderLineId: number; quantity: number }>) =>
    as<any>(actor, () => warehouseReceiptsRoute.POST(request(`${BASE}/warehouse/procurement/purchase-orders/${id}/receipts`, "POST", { lines }), params(id)))

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(
      ["SUPER_ADMIN", "HEAD_OFFICE", "ORDER_PORTAL", "WAREHOUSE", "PROCUREMENT", "FINANCE", "APRICART_EXECUTIVE"]
        .map(async (name) => [name, await resolveRoleId(name)] as const),
    ))
    const [created] = await db.insert(organizations).values({ name: `IT PROC ${suffix}`, code: `ITPR_${suffix}` }).returning({ id: organizations.id })
    org = created.id
    const [branch] = await db.insert(branches).values({ organizationId: org, name: `IT PR K ${suffix}`, city: "Karachi", status: "active" }).returning({ id: branches.id })
    branchK = branch.id

    const person = async (label: string, role: string, organizationId: number | null = null, branchId: number | null = null) => {
      const email = `it-pr-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-pr-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN")
    await person("procurement", "PROCUREMENT")
    await person("finance", "FINANCE")
    await person("headOffice", "HEAD_OFFICE", org)
    await person("raiser", "ORDER_PORTAL", org, branchK)
    await person("khiOperator", "WAREHOUSE")
    await person("lhrOperator", "WAREHOUSE")
    await person("khiExecutive", "APRICART_EXECUTIVE")
    await person("lhrExecutive", "APRICART_EXECUTIVE")

    const warehouses = await db.insert(apricartWarehouses).values([
      { code: `PK${suffix}`.toUpperCase(), name: "Karachi procurement test", city: "Karachi" },
      { code: `PL${suffix}`.toUpperCase(), name: "Lahore procurement test", city: "Lahore" },
    ]).returning({ id: apricartWarehouses.id })
    ;[khi, lhr] = warehouses.map((row) => row.id)
    await db.insert(apricartWarehouseMemberships).values([
      { warehouseId: khi, userId: actors.khiOperator.id, responsibility: "WAREHOUSE_OPERATOR" },
      { warehouseId: lhr, userId: actors.lhrOperator.id, responsibility: "WAREHOUSE_OPERATOR" },
      { warehouseId: khi, userId: actors.khiExecutive.id, responsibility: "EXECUTIVE" },
      { warehouseId: lhr, userId: actors.lhrExecutive.id, responsibility: "EXECUTIVE" },
    ])
    await db.insert(branchFulfillmentRoutes).values({ branchId: branchK, warehouseId: khi })

    const products = await db.insert(globalProducts).values([
      { productCode: `ITPR-RICE-${suffix}`, name: `IT PR Rice ${suffix}`, basePrice: 1_000, status: "active", unit: "kg", stockQuantity: 0 },
      { productCode: `ITPR-FLOUR-${suffix}`, name: `IT PR Flour ${suffix}`, basePrice: 800, status: "active", unit: "kg", stockQuantity: 0 },
    ]).returning({ id: globalProducts.id })
    ;[rice, flour] = products.map((row) => row.id)
    await db.insert(warehouseStock).values({ warehouseId: khi, globalProductId: rice, onHandQuantity: 5 })

    const [settings] = await db.select({ bps: procurementSettings.overDeliveryToleranceBps }).from(procurementSettings).where(eq(procurementSettings.id, 1))
    previousSettings = settings ?? null
    await db.delete(procurementSettings).where(eq(procurementSettings.id, 1))
  })

  afterAll(async () => {
    if (!org) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const warehouseIds = [khi, lhr].filter(Boolean)
    const orderIds = (await db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(inArray(purchaseOrders.warehouseId, warehouseIds))).map((row) => row.id)
    if (orderIds.length > 0) {
      await db.delete(supplierInvoices).where(inArray(supplierInvoices.purchaseOrderId, orderIds))
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oneflowe.stock_ledger_test_cleanup', 'on', true)`)
        const receiptIds = (await tx.select({ id: goodsReceipts.id }).from(goodsReceipts).where(inArray(goodsReceipts.purchaseOrderId, orderIds))).map((row) => row.id)
        if (receiptIds.length > 0) await tx.delete(goodsReceiptLines).where(inArray(goodsReceiptLines.goodsReceiptId, receiptIds))
        await tx.delete(goodsReceipts).where(inArray(goodsReceipts.purchaseOrderId, orderIds))
      })
      await db.delete(purchaseOrders).where(inArray(purchaseOrders.id, orderIds))
    }
    await db.delete(purchaseRequisitions).where(inArray(purchaseRequisitions.warehouseId, warehouseIds))
    await db.delete(customerReturns).where(inArray(customerReturns.warehouseId, warehouseIds))
    await db.delete(procurementSuppliers).where(sql`${procurementSuppliers.name} LIKE ${`%${suffix}%`}`)
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('oneflowe.stock_ledger_test_cleanup', 'on', true)`)
      await tx.delete(stockMovements).where(inArray(stockMovements.warehouseId, warehouseIds))
    })
    await db.delete(warehouseStock).where(inArray(warehouseStock.warehouseId, warehouseIds))
    const saleOrderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, org))).map((row) => row.id)
    if (saleOrderIds.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, saleOrderIds))
      await db.delete(orders).where(inArray(orders.id, saleOrderIds))
    }
    await db.delete(procurementSettings).where(eq(procurementSettings.id, 1))
    if (previousSettings) await db.insert(procurementSettings).values({ id: 1, overDeliveryToleranceBps: previousSettings.bps })
    await db.delete(auditLogs).where(or(eq(auditLogs.organizationId, org), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(eq(systemLogs.organizationId, org), inArray(systemLogs.userId, actorIds)))
    await db.delete(branchFulfillmentRoutes).where(eq(branchFulfillmentRoutes.branchId, branchK))
    await db.delete(apricartWarehouseMemberships).where(inArray(apricartWarehouseMemberships.warehouseId, warehouseIds))
    await db.delete(apricartWarehouses).where(inArray(apricartWarehouses.id, warehouseIds))
    await db.delete(globalProducts).where(inArray(globalProducts.id, [rice, flour].filter(Boolean)))
    await db.delete(branches).where(eq(branches.organizationId, org))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(eq(organizations.id, org))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    ledger.on = true
  })

  describe("suppliers", () => {
    it("are created by Procurement and Super Admin only, with unique names", async () => {
      const body = { name: `Acme Foods ${suffix}`, phone: "0300 1234567" }
      const post = () => suppliersRoute.POST(request(`${BASE}/procurement/suppliers`, "POST", body))
      expect((await as(null, post)).status).toBe(401)
      for (const label of ["headOffice", "khiOperator", "finance", "khiExecutive"]) {
        expect((await as(actors[label], post)).status, label).toBe(403)
      }
      const created = await as<any>(actors.procurement, post)
      expect(created.status).toBe(201)
      supplierId = created.body.supplier.id
      expect((await as(actors.superAdmin, post)).status).toBe(409)

      const listed = await as<any>(actors.finance, () => suppliersRoute.GET())
      expect(listed.status).toBe(200)
      expect(listed.body.items.some((supplier: any) => supplier.id === supplierId)).toBe(true)
    })

    it("refuse an unknown field rather than ignore it", async () => {
      const response = await as(actors.procurement, () => suppliersRoute.POST(request(`${BASE}/procurement/suppliers`, "POST", {
        name: `Other ${suffix}`, organizationId: org,
      })))
      expect(response.status).toBe(400)
    })
  })

  describe("requisition to purchase order", () => {
    it("lets the warehouse raise for its own warehouse only, and see only its own", async () => {
      const raise = (actor: Actor, warehouseId: number) => as<any>(actor, () => warehouseRequisitionsRoute.POST(request(
        `${BASE}/warehouse/procurement/requisitions`, "POST", { warehouseId, lines: [{ globalProductId: rice, quantity: 10 }] },
      )))
      expect((await raise(actors.khiOperator, lhr)).status).toBe(404)
      const raised = await raise(actors.khiOperator, khi)
      expect(raised.status).toBe(201)

      const mine = await as<any>(actors.khiOperator, () => warehouseRequisitionsRoute.GET())
      expect(mine.body.items.map((item: any) => item.id)).toContain(raised.body.id)
      const theirs = await as<any>(actors.lhrOperator, () => warehouseRequisitionsRoute.GET())
      expect(theirs.body.items.map((item: any) => item.id)).not.toContain(raised.body.id)

      const queue = await as<any>(actors.procurement, () => requisitionsRoute.GET(request(`${BASE}/procurement/requisitions?status=SUBMITTED`, "GET")))
      expect(queue.body.items.map((item: any) => item.id)).toContain(raised.body.id)

      // Converting: the PO names the requisition and must receive into its warehouse.
      const wrongWarehouse = await as<any>(actors.procurement, () => purchaseOrdersRoute.POST(request(`${BASE}/procurement/purchase-orders`, "POST", {
        supplierId, warehouseId: lhr, requisitionId: raised.body.id, lines: [{ globalProductId: rice, quantity: 10, unitCostCents: 500, taxRateBps: 0 }],
      })))
      expect(wrongWarehouse.status).toBe(400)
      const converted = await as<any>(actors.procurement, () => purchaseOrdersRoute.POST(request(`${BASE}/procurement/purchase-orders`, "POST", {
        supplierId, warehouseId: khi, requisitionId: raised.body.id, lines: [{ globalProductId: rice, quantity: 10, unitCostCents: 500, taxRateBps: 0 }],
      })))
      expect(converted.status).toBe(201)
      const [requisition] = await db.select().from(purchaseRequisitions).where(eq(purchaseRequisitions.id, raised.body.id))
      expect(requisition.status).toBe("CONVERTED")
      expect(requisition.purchaseOrderId).toBe(converted.body.id)

      const again = await as<any>(actors.procurement, () => purchaseOrdersRoute.POST(request(`${BASE}/procurement/purchase-orders`, "POST", {
        supplierId, warehouseId: khi, requisitionId: raised.body.id, lines: [{ globalProductId: rice, quantity: 10, unitCostCents: 500, taxRateBps: 0 }],
      })))
      expect(again.status).toBe(409)
    })
  })

  describe("approval", () => {
    it("totals the lines in cents, and is Super Admin's alone, on the version it saw", async () => {
      const created = await as<any>(actors.procurement, () => purchaseOrdersRoute.POST(request(`${BASE}/procurement/purchase-orders`, "POST", {
        supplierId, warehouseId: khi, lines: [
          { globalProductId: rice, quantity: 3, unitCostCents: 33_333, taxRateBps: 1_800 },
          { globalProductId: flour, quantity: 2, unitCostCents: 10_000, taxRateBps: 0 },
        ],
      })))
      expect(created.status).toBe(201)
      const id = created.body.id
      let order = await loadOrder(id)
      // 3 × 333.33 = 999.99; tax 18% = 180.00 (179.998 rounded); flour 200.00.
      expect(order.subtotalCents).toBe(99_999 + 20_000)
      expect(order.taxCents).toBe(18_000)
      expect(order.totalCents).toBe(99_999 + 20_000 + 18_000)

      expect((await act(actors.superAdmin, id, { action: "approve", expectedUpdatedAt: order.updatedAt })).status).toBe(409)
      expect((await act(actors.procurement, id, { action: "submit", expectedUpdatedAt: order.updatedAt })).status).toBe(200)
      expect((await act(actors.procurement, id, { action: "submit", expectedUpdatedAt: order.updatedAt })).status).toBe(409)

      order = await loadOrder(id)
      expect((await act(actors.procurement, id, { action: "approve", expectedUpdatedAt: order.updatedAt })).status).toBe(403)
      signIn(actors.finance)
      expect((await purchaseOrderRoute.PATCH(request(`${BASE}/procurement/purchase-orders/${id}`, "PATCH", {
        action: "approve", expectedUpdatedAt: order.updatedAt,
      }), params(id))).status).toBe(403)
      expect((await act(actors.superAdmin, id, { action: "approve", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" })).status).toBe(409)
      const approved = await act(actors.superAdmin, id, { action: "approve", expectedUpdatedAt: order.updatedAt })
      expect(approved.status).toBe(200)
      expect(approved.body.status).toBe("APPROVED")

      order = await loadOrder(id)
      expect(order.overDeliveryToleranceBps).toBe(2_000)
      expect(order.toleranceIsSnapshot).toBe(true)
      expect(order.approvedBy).toContain("superAdmin")
      const [audit] = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, "APPROVE_PURCHASE_ORDER"), eq(auditLogs.entityId, String(id))))
      expect(audit).toBeDefined()
    })
  })

  describe("receiving", () => {
    it("shows the warehouse its own approved POs without a single cost, and no other warehouse's", async () => {
      const id = await approvedOrder([{ globalProductId: rice, quantity: 10, unitCostCents: 777, taxRateBps: 1_700 }])
      const mine = await as<any>(actors.khiOperator, () => warehousePurchaseOrderRoute.GET(request(`${BASE}/warehouse/procurement/purchase-orders/${id}`, "GET"), params(id)))
      expect(mine.status).toBe(200)
      expect(JSON.stringify(mine.body)).not.toMatch(/Cents|unitCost|taxRate|777/)
      expect(mine.body.order.lines[0]).toMatchObject({ quantity: 10, receivedQuantity: 0 })

      const other = await as<any>(actors.lhrOperator, () => warehousePurchaseOrderRoute.GET(request(`${BASE}/warehouse/procurement/purchase-orders/${id}`, "GET"), params(id)))
      expect(other.status).toBe(404)
      const procurementRead = await as<any>(actors.khiOperator, () => purchaseOrderRoute.GET(request(`${BASE}/procurement/purchase-orders/${id}`, "GET"), params(id)))
      expect(procurementRead.status).toBe(403)
    })

    it("receives in parts up to the 20% allowance, raising only that warehouse's shelf", async () => {
      const id = await approvedOrder([{ globalProductId: rice, quantity: 10, unitCostCents: 500, taxRateBps: 0 }])
      // A later change to the setting does not move an approved PO's allowance.
      expect((await as(actors.superAdmin, () => settingsRoute.PUT(request(`${BASE}/procurement/settings`, "PUT", { overDeliveryTolerancePercent: 5 })))).status).toBe(200)
      const lineId = (await loadOrder(id)).lines[0].id
      const before = { khi: await onHand(khi), lhr: await onHand(lhr) }

      expect((await receive(actors.lhrOperator, id, [{ purchaseOrderLineId: lineId, quantity: 1 }])).status).toBe(404)
      const first = await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 6 }])
      expect(first.status).toBe(201)
      expect(first.body.status).toBe("PARTIALLY_RECEIVED")
      expect(await onHand(khi)).toBe(before.khi + 6)
      expect(await onHand(lhr)).toBe(before.lhr)

      const over = await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 7 }])
      expect(over.status).toBe(400)
      expect(over.body.error).toContain("at most 6 more")
      const last = await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 6 }])
      expect(last.status).toBe(201)
      expect(last.body.status).toBe("RECEIVED")
      expect(await onHand(khi)).toBe(before.khi + 12)
      expect((await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 1 }])).status).toBe(409)

      const movements = await db.select().from(stockMovements)
        .where(and(eq(stockMovements.warehouseId, khi), eq(stockMovements.movementType, "PURCHASE_RECEIPT")))
      expect(movements.filter((movement) => movement.globalProductId === rice).map((movement) => Number(movement.quantityDelta))).toEqual(expect.arrayContaining([6, 6]))

      expect((await as(actors.superAdmin, () => settingsRoute.PUT(request(`${BASE}/procurement/settings`, "PUT", { overDeliveryTolerancePercent: 20 })))).status).toBe(200)
    })

    it("lets only one of two simultaneous receipts past the allowance", async () => {
      const id = await approvedOrder([{ globalProductId: flour, quantity: 10, unitCostCents: 500, taxRateBps: 0 }])
      const lineId = (await loadOrder(id)).lines[0].id
      // One session for both: the mocked session is process-wide. 7 + 7 = 14 > 12.
      signIn(actors.khiOperator)
      const post = () => warehouseReceiptsRoute.POST(
        request(`${BASE}/warehouse/procurement/purchase-orders/${id}/receipts`, "POST", { lines: [{ purchaseOrderLineId: lineId, quantity: 7 }] }),
        params(id),
      )
      const results = await Promise.all([post(), post()])
      expect(results.map((result) => result.status).sort()).toEqual([201, 400])
      expect((await loadOrder(id)).lines[0].receivedQuantity).toBe(7)
    })

    it("refuses any receipt while stock is still counted globally, changing nothing", async () => {
      const id = await approvedOrder([{ globalProductId: rice, quantity: 4, unitCostCents: 500, taxRateBps: 0 }])
      const lineId = (await loadOrder(id)).lines[0].id
      const before = await onHand(khi)
      ledger.on = false
      const refused = await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 4 }])
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("STOCK_LEDGER_GLOBAL")
      expect(await onHand(khi)).toBe(before)
      expect((await loadOrder(id)).status).toBe("APPROVED")
    })

    it("keeps receipts append-only", async () => {
      const [receipt] = await db.select({ id: goodsReceipts.id }).from(goodsReceipts).where(eq(goodsReceipts.warehouseId, khi)).limit(1)
      await expect(db.update(goodsReceipts).set({ notes: "edited" }).where(eq(goodsReceipts.id, receipt.id))).rejects.toThrow()
      await expect(db.delete(goodsReceipts).where(eq(goodsReceipts.id, receipt.id))).rejects.toThrow()
    })

    it("cancels only what has received nothing, and closes the rest short", async () => {
      const id = await approvedOrder([{ globalProductId: rice, quantity: 10, unitCostCents: 500, taxRateBps: 0 }])
      const lineId = (await loadOrder(id)).lines[0].id
      expect((await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 2 }])).status).toBe(201)
      let order = await loadOrder(id)
      expect((await act(actors.procurement, id, { action: "cancel", reason: "No longer needed", expectedUpdatedAt: order.updatedAt })).status).toBe(409)
      const closed = await act(actors.procurement, id, { action: "close", reason: "Supplier out of stock", expectedUpdatedAt: order.updatedAt })
      expect(closed.status).toBe(200)
      order = await loadOrder(id)
      expect(order.status).toBe("CLOSED")
    })
  })

  describe("three-way match", () => {
    it("approves a matching invoice for Finance, and holds an exception for Super Admin with a reason", async () => {
      const id = await approvedOrder([{ globalProductId: rice, quantity: 10, unitCostCents: 1_000, taxRateBps: 1_000 }])
      const lineId = (await loadOrder(id)).lines[0].id
      expect((await receive(actors.khiOperator, id, [{ purchaseOrderLineId: lineId, quantity: 8 }])).status).toBe(201)

      const record = (actor: Actor, invoiceNumber: string, quantity: number, unitCostCents = 1_000) =>
        as<any>(actor, () => invoicesRoute.POST(request(`${BASE}/procurement/supplier-invoices`, "POST", {
          purchaseOrderId: id, invoiceNumber, invoiceDate: "2026-10-28", lines: [{ purchaseOrderLineId: lineId, quantity, unitCostCents }],
        })))
      const decide = (actor: Actor, invoiceId: number, body: Record<string, unknown>) =>
        as<any>(actor, () => invoiceRoute.PATCH(request(`${BASE}/procurement/supplier-invoices/${invoiceId}`, "PATCH", body), params(invoiceId)))

      expect((await record(actors.khiOperator, `INV-W-${suffix}`, 1)).status).toBe(403)
      const matched = await record(actors.finance, `INV-1-${suffix}`, 8)
      expect(matched.status).toBe(201)
      expect(matched.body.matchStatus).toBe("MATCHED")
      const [stored] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, matched.body.id))
      expect(Number(stored.totalCents)).toBe(8_000 + 800)

      expect((await record(actors.procurement, `inv-1-${suffix}`, 1)).status).toBe(409)
      expect((await decide(actors.procurement, matched.body.id, { action: "approve" })).status).toBe(403)
      expect((await decide(actors.finance, matched.body.id, { action: "pay" })).status).toBe(409)
      expect((await decide(actors.finance, matched.body.id, { action: "approve" })).body.status).toBe("APPROVED")
      expect((await decide(actors.finance, matched.body.id, { action: "pay", paymentReference: "CHQ-1" })).body.status).toBe("PAID")

      // Two more than received, and at a higher price.
      const exception = await record(actors.procurement, `INV-2-${suffix}`, 2, 1_100)
      expect(exception.body.matchStatus).toBe("EXCEPTION")
      expect(exception.body.exceptions.join(" ")).toMatch(/received 8/)
      expect((await decide(actors.finance, exception.body.id, { action: "approve" })).status).toBe(403)
      expect((await decide(actors.superAdmin, exception.body.id, { action: "approve" })).status).toBe(400)
      const overridden = await decide(actors.superAdmin, exception.body.id, { action: "approve", reason: "Price rise agreed by phone" })
      expect(overridden.body).toMatchObject({ status: "APPROVED", matchStatus: "EXCEPTION" })

      const listed = await as<any>(actors.finance, () => invoicesRoute.GET(request(`${BASE}/procurement/supplier-invoices?purchaseOrderId=${id}`, "GET")))
      expect(listed.body.items).toHaveLength(2)
    })
  })

  describe("customer returns", () => {
    it("are recorded by the warehouse and decided by that warehouse's executive or Super Admin", async () => {
      const before = await onHand(khi)
      const recorded = await as<any>(actors.khiOperator, () => warehouseReturnsRoute.POST(request(`${BASE}/warehouse/procurement/returns`, "POST", {
        warehouseId: khi, reason: "Wrong item delivered", lines: [
          { globalProductId: rice, quantity: 2, condition: "RESALEABLE" },
          { globalProductId: rice, quantity: 1, condition: "DAMAGED" },
        ],
      })))
      expect(recorded.status).toBe(201)
      const returnId = recorded.body.id
      const otherWarehouse = await as<any>(actors.lhrOperator, () => warehouseReturnsRoute.POST(request(`${BASE}/warehouse/procurement/returns`, "POST", {
        warehouseId: khi, reason: "Not mine", lines: [{ globalProductId: rice, quantity: 1, condition: "RESALEABLE" }],
      })))
      expect(otherWarehouse.status).toBe(404)
      const unknownOrder = await as<any>(actors.khiOperator, () => warehouseReturnsRoute.POST(request(`${BASE}/warehouse/procurement/returns`, "POST", {
        warehouseId: khi, orderReference: "NO-SUCH-ORDER", reason: "Order gone", lines: [{ globalProductId: rice, quantity: 1, condition: "RESALEABLE" }],
      })))
      expect(unknownOrder.status).toBe(400)

      const decide = (actor: Actor, body: Record<string, unknown>) =>
        as<any>(actor, () => executiveReturnRoute.PATCH(request(`${BASE}/executive/returns/${returnId}`, "PATCH", body), params(returnId)))
      expect((await decide(actors.lhrExecutive, { action: "approve" })).status).toBe(404)
      expect((await decide(actors.khiOperator, { action: "approve" })).status).toBe(403)
      const lhrList = await as<any>(actors.lhrExecutive, () => executiveReturnsRoute.GET())
      expect(lhrList.body.items.map((item: any) => item.id)).not.toContain(returnId)

      ledger.on = false
      expect((await decide(actors.khiExecutive, { action: "approve" })).body.code).toBe("STOCK_LEDGER_GLOBAL")
      ledger.on = true
      const approved = await decide(actors.khiExecutive, { action: "approve" })
      expect(approved.status).toBe(200)
      expect(await onHand(khi)).toBe(before + 2)
      expect((await decide(actors.khiExecutive, { action: "approve" })).status).toBe(409)

      const listed = await as<any>(actors.superAdmin, () => adminReturnsRoute.GET(request(`${BASE}/procurement/returns`, "GET")))
      expect(listed.body.items.find((item: any) => item.id === returnId)?.status).toBe("APPROVED")
      expect((await as(actors.procurement, () => adminReturnsRoute.GET(request(`${BASE}/procurement/returns`, "GET")))).status).toBe(403)
    })
  })

  describe("shortages", () => {
    it("show where open orders need more than the shelf, net of what is on order", async () => {
      const [order] = await db.insert(orders).values({
        tid: `PRS${suffix}`.slice(0, 26), organizationId: org, branchId: branchK, createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL", status: "PENDING", subtotalCents: 0, taxCents: 0, totalCents: 0, budgetTracked: false,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: order.id, organizationId: org, globalProductId: rice, productName: "Rice", productCode: "RICE", unit: "kg", quantity: 500, priceCents: 0, taxCents: 0,
      })
      const response = await as<any>(actors.procurement, () => shortagesRoute.GET())
      expect(response.status).toBe(200)
      const row = response.body.items.find((item: any) => item.warehouseId === khi && item.globalProductId === rice)
      expect(row).toBeDefined()
      expect(row.reserved).toBe(500)
      expect(row.shortfall).toBe(Math.max(0, 500 - row.onHand - row.onOrder))
      expect((await as(actors.finance, () => shortagesRoute.GET())).status).toBe(403)
    })
  })

  describe("settings", () => {
    it("are read by purchasing and changed by Super Admin only, within 0–100%", async () => {
      const put = (body: unknown) => settingsRoute.PUT(request(`${BASE}/procurement/settings`, "PUT", body))
      expect((await as(actors.procurement, () => put({ overDeliveryTolerancePercent: 10 }))).status).toBe(403)
      expect((await as(actors.superAdmin, () => put({ overDeliveryTolerancePercent: 101 }))).status).toBe(400)
      expect((await as(actors.superAdmin, () => put({ overDeliveryTolerancePercent: 12.5 }))).status).toBe(200)
      const read = await as<any>(actors.finance, () => settingsRoute.GET())
      expect(read.body.overDeliveryToleranceBps).toBe(1_250)
    })
  })
})
