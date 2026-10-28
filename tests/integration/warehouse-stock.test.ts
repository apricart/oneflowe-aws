import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or, sql } from "drizzle-orm"

import * as adjustmentsRoute from "@/app/api/v1/admin/warehouse-stock/adjustments/route"
import * as stockListRoute from "@/app/api/v1/admin/warehouse-stock/route"
import * as transferRoute from "@/app/api/v1/orders/[id]/fulfillment-warehouse/route"
import {
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branchFulfillmentRoutes,
  branches,
  emailOutbox,
  globalProducts,
  notifications,
  orderItems,
  orders,
  orderWarehouseTransfers,
  organizations,
  roles,
  stockMovements,
  systemLogs,
  users,
  warehouseStock,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"
import {
  assertWarehouseStockAvailable,
  findStockShortfalls,
  loadBranchAvailableStock,
} from "@/lib/server/warehouse-stock"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Per-warehouse stock against a real database, with the switch moved to
 * "warehouse". See plans/OF-STOCK-per-warehouse-stock.md. Every other suite
 * runs with the shipped "global" switch and so keeps proving that nothing
 * changes until it is moved.
 *
 * ```text
 * Warehouses KHI (10 rice on hand) and LHR (3 on hand), each with an operator.
 * Branches  K → KHI (manual route), L → LHR (manual route), U → no warehouse.
 * ```
 */
vi.mock("@/lib/stock-ledger-policy", () => ({
  STOCK_LEDGER_MODES: ["global", "warehouse"],
  STOCK_LEDGER_MODE: "warehouse",
  usesWarehouseStock: () => true,
}))
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email/ses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/ses")>()
  return { ...actual, sendAppEmail: vi.fn(async () => ({ MessageId: "msg" })) }
})

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
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse stock tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("stock counted per warehouse", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  const warehouseIds: number[] = []
  let org: number
  let branchK: number
  let branchL: number
  let branchU: number
  let rice: number
  let khi: number
  let lhr: number
  let sequence = 0

  const onHand = async (warehouseId: number) => {
    const [row] = await db.select({ onHand: warehouseStock.onHandQuantity }).from(warehouseStock)
      .where(and(eq(warehouseStock.warehouseId, warehouseId), eq(warehouseStock.globalProductId, rice)))
    return Number(row?.onHand ?? 0)
  }

  const place = async (input: { branchId: number; quantity: number; status?: string; fulfillmentStatus?: string; fulfillmentWarehouseId?: number | null }) => {
    sequence += 1
    const [row] = await db.insert(orders).values({
      tid: `WS${suffix}${sequence}`.slice(0, 26),
      organizationId: org,
      branchId: input.branchId,
      createdByUserId: actors.raiser.id,
      createdByRole: "ORDER_PORTAL",
      status: input.status ?? "PENDING",
      fulfillmentStatus: input.fulfillmentStatus ?? "NOT_STARTED",
      fulfillmentWarehouseId: input.fulfillmentWarehouseId ?? null,
      approvedAt: input.status === "APPROVED" ? new Date() : null,
      subtotalCents: 1_000 * input.quantity,
      taxCents: 0,
      totalCents: 1_000 * input.quantity,
      budgetTracked: false,
    }).returning({ id: orders.id })
    await db.insert(orderItems).values({
      orderId: row.id, organizationId: org, globalProductId: rice, productName: "Rice", productCode: "RICE", unit: "kg", quantity: input.quantity, priceCents: 1_000, taxCents: 0,
    })
    return row.id
  }

  const close = (orderId: number) => db.update(orders).set({ status: "CANCELLED" }).where(eq(orders.id, orderId))

  const check = (branchId: number, quantity: number, extra: { excludeOrderId?: number; fulfillmentWarehouseId?: number | null } = {}) =>
    db.transaction((tx) => findStockShortfalls(tx, { branchId, lines: [{ globalProductId: rice, quantity, productName: "Rice" }], ...extra }))

  const progress = (orderId: number) => progressOrderFulfillment({
    orderId,
    nextStatus: "IN_PROCESS",
    deliveryChallanId: null,
    challanRequired: false,
    actor: { id: actors.superAdmin.id, role: "SUPER_ADMIN" },
    authorize: async () => true,
  })

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all(["SUPER_ADMIN", "HEAD_OFFICE", "ORDER_PORTAL", "WAREHOUSE"]
      .map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [created] = await db.insert(organizations).values({ name: `IT STOCK ${suffix}`, code: `ITWS_${suffix}` }).returning({ id: organizations.id })
    org = created.id
    const branchRows = await db.insert(branches).values([
      { organizationId: org, name: `IT WS K ${suffix}`, city: "Karachi", status: "active" },
      { organizationId: org, name: `IT WS L ${suffix}`, city: "Lahore", status: "active" },
      { organizationId: org, name: `IT WS U ${suffix}`, city: "Nowhere", status: "active" },
    ]).returning({ id: branches.id })
    ;[branchK, branchL, branchU] = branchRows.map((row) => row.id)

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-ws-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-ws-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", org, null)
    await person("raiser", "ORDER_PORTAL", org, branchK)
    await person("khiOperator", "WAREHOUSE", null, null)
    await person("lhrOperator", "WAREHOUSE", null, null)

    const warehouses = await db.insert(apricartWarehouses).values([
      { code: `KHI${suffix}`.toUpperCase(), name: "Karachi test", city: "Karachi" },
      { code: `LHR${suffix}`.toUpperCase(), name: "Lahore test", city: "Lahore" },
    ]).returning({ id: apricartWarehouses.id })
    ;[khi, lhr] = warehouses.map((row) => row.id)
    warehouseIds.push(khi, lhr)
    await db.insert(apricartWarehouseMemberships).values([
      { warehouseId: khi, userId: actors.khiOperator.id, responsibility: "WAREHOUSE_OPERATOR" },
      { warehouseId: lhr, userId: actors.lhrOperator.id, responsibility: "WAREHOUSE_OPERATOR" },
    ])
    await db.insert(branchFulfillmentRoutes).values([
      { branchId: branchK, warehouseId: khi },
      { branchId: branchL, warehouseId: lhr },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITWS-RICE-${suffix}`, name: `IT WS Rice ${suffix}`, basePrice: 1_000, status: "active", unit: "kg", stockQuantity: 999,
    }).returning({ id: globalProducts.id })
    rice = product.id
    await db.insert(warehouseStock).values([
      { warehouseId: khi, globalProductId: rice, onHandQuantity: 10 },
      { warehouseId: lhr, globalProductId: rice, onHandQuantity: 3 },
    ])
  })

  afterAll(async () => {
    if (!org) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, org))).map((row) => row.id)
    if (orderIds.length > 0) {
      await purgeInvoiceLedger({ organizationIds: [org] })
      await db.delete(orderWarehouseTransfers).where(inArray(orderWarehouseTransfers.orderId, orderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    if (rice) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oneflowe.stock_ledger_test_cleanup', 'on', true)`)
        await tx.delete(stockMovements).where(eq(stockMovements.globalProductId, rice))
      })
      await db.delete(warehouseStock).where(eq(warehouseStock.globalProductId, rice))
    }
    await db.delete(emailOutbox).where(inArray(emailOutbox.recipientUserId, actorIds))
    await db.delete(notifications).where(inArray(notifications.userId, actorIds))
    await db.delete(auditLogs).where(or(eq(auditLogs.organizationId, org), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(eq(systemLogs.organizationId, org), inArray(systemLogs.userId, actorIds)))
    await db.delete(branchFulfillmentRoutes).where(inArray(branchFulfillmentRoutes.branchId, [branchK, branchL, branchU]))
    await db.delete(apricartWarehouseMemberships).where(inArray(apricartWarehouseMemberships.warehouseId, warehouseIds))
    await db.delete(apricartWarehouses).where(inArray(apricartWarehouses.id, warehouseIds))
    if (rice) await db.delete(globalProducts).where(eq(globalProducts.id, rice))
    await db.delete(branches).where(eq(branches.organizationId, org))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(eq(organizations.id, org))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("ten in stock, two customers each ordering ten", () => {
    it("lets the first reserve all ten and refuses the second", async () => {
      expect(await check(branchK, 10)).toEqual([])
      const first = await place({ branchId: branchK, quantity: 10 })
      await expect(db.transaction((tx) => assertWarehouseStockAvailable(tx, {
        branchId: branchK, lines: [{ globalProductId: rice, quantity: 10, productName: "Rice" }],
      }))).rejects.toThrow("Insufficient stock for Rice. Available: 0, Requested: 10")
      // Nothing left the shelf: a reservation is the order itself.
      expect(await onHand(khi)).toBe(10)

      await close(first)
      expect(await check(branchK, 10)).toEqual([])
    })

    it("lets only one of two simultaneous orders for the last ten through", async () => {
      const attempt = () => db.transaction(async (tx) => {
        await assertWarehouseStockAvailable(tx, { branchId: branchK, lines: [{ globalProductId: rice, quantity: 10, productName: "Rice" }] })
        sequence += 1
        const [row] = await tx.insert(orders).values({
          tid: `WSR${suffix}${sequence}`.slice(0, 26), organizationId: org, branchId: branchK, createdByUserId: actors.raiser.id,
          createdByRole: "ORDER_PORTAL", status: "PENDING", subtotalCents: 10_000, taxCents: 0, totalCents: 10_000, budgetTracked: false,
        }).returning({ id: orders.id })
        await tx.insert(orderItems).values({
          orderId: row.id, organizationId: org, globalProductId: rice, productName: "Rice", productCode: "RICE", unit: "kg", quantity: 10, priceCents: 1_000, taxCents: 0,
        })
        await tx.execute(sql`select pg_sleep(0.2)`)
        return row.id
      })
      const results = await Promise.allSettled([attempt(), attempt()])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      for (const result of results) if (result.status === "fulfilled") await close(result.value)
    })

    it("counts an edited order's own reservation as available to it", async () => {
      const order = await place({ branchId: branchK, quantity: 8 })
      expect(await check(branchK, 9)).toHaveLength(1)
      expect(await check(branchK, 10, { excludeOrderId: order })).toEqual([])
      await close(order)
    })
  })

  describe("the reservation follows the warehouse working the order", () => {
    it("counts a transferred order at its new warehouse, not its branch's", async () => {
      const moved = await place({ branchId: branchK, quantity: 2, status: "APPROVED", fulfillmentWarehouseId: lhr })
      expect((await loadBranchAvailableStock(db, branchK, [rice]))?.get(rice)).toBe(10)
      expect((await loadBranchAvailableStock(db, branchL, [rice]))?.get(rice)).toBe(1)
      await close(moved)
    })

    it("checks a branch with no warehouse against every warehouse together, and accepts it", async () => {
      const elsewhere = await place({ branchId: branchK, quantity: 4 })
      // 10 + 3 on hand, 4 reserved anywhere.
      expect((await loadBranchAvailableStock(db, branchU, [rice]))?.get(rice)).toBe(9)
      expect(await check(branchU, 9)).toEqual([])
      expect(await check(branchU, 10)).toHaveLength(1)
      await close(elsewhere)
    })

    it("stops counting an order once it is In Process, rejected or cancelled", async () => {
      const inProcess = await place({ branchId: branchK, quantity: 5, status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })
      const rejected = await place({ branchId: branchK, quantity: 5, status: "REJECTED" })
      expect((await loadBranchAvailableStock(db, branchK, [rice]))?.get(rice)).toBe(10)
      await close(inProcess)
      await close(rejected)
    })
  })

  describe("goods leave the shelf when the order is marked In Process", () => {
    it("takes the order's quantity from its branch's warehouse, once", async () => {
      const order = await place({ branchId: branchK, quantity: 4, status: "APPROVED" })
      const outcome = await progress(order)
      expect(outcome.kind).toBe("updated")
      expect(await onHand(khi)).toBe(6)
      expect(await onHand(lhr)).toBe(3)
      const movements = await db.select().from(stockMovements).where(eq(stockMovements.orderId, order))
      expect(movements).toHaveLength(1)
      expect(movements[0]).toMatchObject({ warehouseId: khi, movementType: "ORDER_ISSUE", quantityDelta: -4, balanceAfter: 6 })
      // Restore the shelf for the cases below.
      await db.update(warehouseStock).set({ onHandQuantity: 10 }).where(and(eq(warehouseStock.warehouseId, khi), eq(warehouseStock.globalProductId, rice)))
    })

    it("takes a transferred order from the warehouse it was moved to", async () => {
      const order = await place({ branchId: branchK, quantity: 2, status: "APPROVED", fulfillmentWarehouseId: lhr })
      expect((await progress(order)).kind).toBe("updated")
      expect(await onHand(lhr)).toBe(1)
      expect(await onHand(khi)).toBe(10)
      await db.update(warehouseStock).set({ onHandQuantity: 3 }).where(and(eq(warehouseStock.warehouseId, lhr), eq(warehouseStock.globalProductId, rice)))
    })

    it("refuses the step when the shelf is short, and records nothing", async () => {
      const order = await place({ branchId: branchL, quantity: 5, status: "APPROVED" })
      const outcome = await progress(order)
      expect(outcome).toEqual({ kind: "stock-short", shortfalls: [{ globalProductId: rice, productName: "Rice", requested: 5, available: 3 }] })
      const [row] = await db.select({ fulfillmentStatus: orders.fulfillmentStatus }).from(orders).where(eq(orders.id, order))
      expect(row.fulfillmentStatus).toBe("NOT_STARTED")
      expect(await onHand(lhr)).toBe(3)
      expect(await db.select().from(stockMovements).where(eq(stockMovements.orderId, order))).toHaveLength(0)
      await close(order)
    })

    it("refuses the step for an order whose branch has no warehouse", async () => {
      const order = await place({ branchId: branchU, quantity: 1, status: "APPROVED" })
      expect(await progress(order)).toEqual({ kind: "no-stock-warehouse" })
      await close(order)
    })
  })

  describe("Super Admin changes a warehouse's figure", () => {
    const adjust = async (actor: Actor | null, body: unknown) => {
      signIn(actor)
      return read(await adjustmentsRoute.POST(request("http://localhost/api/v1/admin/warehouse-stock/adjustments", "POST", body)))
    }

    it("refuses anyone signed out, and every role but Super Admin", async () => {
      const body = { warehouseId: khi, globalProductId: rice, mode: "add", quantity: 1, reason: "Count" }
      expect((await adjust(null, body)).status).toBe(401)
      expect((await adjust(actors.headOffice, body)).status).toBe(403)
      expect((await adjust(actors.khiOperator, body)).status).toBe(403)
      expect(await onHand(khi)).toBe(10)
    })

    it("sets, adds and removes, recording each change and an audit row", async () => {
      expect((await adjust(actors.superAdmin, { warehouseId: khi, globalProductId: rice, mode: "set", quantity: 12, reason: "Stock count" })).status).toBe(200)
      expect((await adjust(actors.superAdmin, { warehouseId: khi, globalProductId: rice, mode: "add", quantity: 3, reason: "Found a carton" })).status).toBe(200)
      expect((await adjust(actors.superAdmin, { warehouseId: khi, globalProductId: rice, mode: "remove", quantity: 5, reason: "Damaged" })).status).toBe(200)
      expect(await onHand(khi)).toBe(10)
      const adjustments = await db.select({ delta: stockMovements.quantityDelta, reason: stockMovements.reason }).from(stockMovements)
        .where(and(eq(stockMovements.warehouseId, khi), eq(stockMovements.movementType, "ADJUSTMENT")))
      expect(adjustments.map((row) => Number(row.delta))).toEqual([2, 3, -5])
      const audits = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.userId, actors.superAdmin.id), eq(auditLogs.action, "ADJUST_WAREHOUSE_STOCK")))
      expect(audits).toHaveLength(3)
    })

    it("refuses to go below zero, an unknown field, and an unknown warehouse", async () => {
      expect((await adjust(actors.superAdmin, { warehouseId: lhr, globalProductId: rice, mode: "remove", quantity: 4, reason: "Too many" })).status).toBe(400)
      expect((await adjust(actors.superAdmin, { warehouseId: lhr, globalProductId: rice, mode: "add", quantity: 1, reason: "x".repeat(3), organizationId: 1 })).status).toBe(400)
      expect((await adjust(actors.superAdmin, { warehouseId: 2_000_000_000, globalProductId: rice, mode: "add", quantity: 1, reason: "Nowhere" })).status).toBe(404)
      expect(await onHand(lhr)).toBe(3)
    })

    it("lists on hand, reserved and available for Super Admin only", async () => {
      const order = await place({ branchId: branchK, quantity: 4 })
      signIn(actors.headOffice)
      expect((await read(await stockListRoute.GET(request(`http://localhost/api/v1/admin/warehouse-stock?warehouseId=${khi}`, "GET")))).status).toBe(403)
      signIn(actors.superAdmin)
      const { status, body } = await read(await stockListRoute.GET(request(`http://localhost/api/v1/admin/warehouse-stock?warehouseId=${khi}&search=${encodeURIComponent(`IT WS Rice ${suffix}`)}`, "GET")))
      expect(status).toBe(200)
      expect(body.items).toEqual([expect.objectContaining({ globalProductId: rice, onHand: 10, reserved: 4, available: 6 })])
      await close(order)
    })
  })

  describe("a transfer to a warehouse short of stock", () => {
    const transfer = async (orderId: number, body: unknown) => {
      signIn(actors.superAdmin)
      return read(await transferRoute.POST(request(`http://localhost/api/v1/orders/${orderId}/fulfillment-warehouse`, "POST", body), params(orderId)))
    }

    it("warns first, then moves the order once confirmed and keeps the shortfall in the audit row", async () => {
      const order = await place({ branchId: branchK, quantity: 5, status: "APPROVED" })
      signIn(actors.superAdmin)
      const panel = await read(await transferRoute.GET(request(`http://localhost/api/v1/orders/${order}/fulfillment-warehouse`, "GET"), params(order)))
      expect(panel.body.targets.find((target: { id: number }) => target.id === lhr).stockShortfalls)
        .toEqual([{ globalProductId: rice, productName: "Rice", requested: 5, available: 3 }])
      expect(panel.body.targets.find((target: { id: number }) => target.id === khi).stockShortfalls).toEqual([])

      const warned = await transfer(order, { targetWarehouseId: lhr, expectedWarehouseId: null, reason: "Karachi van is down" })
      expect(warned.status).toBe(409)
      expect(warned.body.code).toBe("STOCK_SHORTFALL")
      expect((await db.select({ id: orders.fulfillmentWarehouseId }).from(orders).where(eq(orders.id, order)))[0].id).toBeNull()

      const moved = await transfer(order, { targetWarehouseId: lhr, expectedWarehouseId: null, reason: "Karachi van is down", acknowledgeStockShortfall: true })
      expect(moved.status).toBe(200)
      expect((await db.select({ id: orders.fulfillmentWarehouseId }).from(orders).where(eq(orders.id, order)))[0].id).toBe(lhr)
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_WAREHOUSE_TRANSFERRED"), eq(auditLogs.entityId, String(order))))
      expect(JSON.stringify(audit.metadata)).toContain("stockShortfalls")
      // Lahore is now over-committed: its own customers see none available.
      expect((await loadBranchAvailableStock(db, branchL, [rice]))?.get(rice)).toBe(0)
      await close(order)
    })
  })

  it("keeps every movement append-only", async () => {
    const [movement] = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.globalProductId, rice)).limit(1)
    await expect(db.update(stockMovements).set({ reason: "rewritten" }).where(eq(stockMovements.id, movement.id))).rejects.toThrow()
    await expect(db.delete(stockMovements).where(eq(stockMovements.id, movement.id))).rejects.toThrow()
  })
})
