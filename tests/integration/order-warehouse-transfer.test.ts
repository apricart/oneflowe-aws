import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as transferRoute from "@/app/api/v1/orders/[id]/fulfillment-warehouse/route"
import * as warehouseMembersRoute from "@/app/api/v1/apricart-warehouses/[id]/members/route"
import * as warehouseRoute from "@/app/api/v1/apricart-warehouses/[id]/route"
import * as listRoute from "@/app/api/v1/warehouse/orders/route"
import * as detailRoute from "@/app/api/v1/warehouse/orders/[id]/route"
import * as progressRoute from "@/app/api/v1/warehouse/orders/[id]/progress/route"
import * as workloadRoute from "@/app/api/v1/warehouse/workload/route"
import * as noticesRoute from "@/app/api/v1/warehouse/notifications/route"
import {
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branches,
  emailOutbox,
  globalProducts,
  notifications,
  orderItems,
  orders,
  orderWarehouseTransfers,
  organizations,
  roles,
  systemLogs,
  users,
  warehouseAssignments,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Moving one order from one Apricart warehouse to another, end to end.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 *
 * ```text
 * Tenant A, branch A1 (Karachi) ← served by warehouse account "khi" (branch assignment)
 *   X approved, not started     — the order that moves
 *   K approved, not started     — never moves: stays with "khi" throughout
 *   O approved, out for delivery
 *
 * Warehouses: LHE (operator "lhe"), EMPTY (no operator), OFF (inactive, operator "off")
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})
const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string }>)
vi.mock("@/lib/email/ses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/ses")>()
  return {
    ...actual,
    sendAppEmail: vi.fn(async (input: { to: string; subject: string }) => {
      sent.push({ to: input.to, subject: input.subject })
      return { MessageId: `msg-${sent.length}` }
    }),
  }
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
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse transfer tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("transferring an order to another warehouse", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  const warehouseIds: number[] = []
  let orgA: number
  let branchA1: number
  let productId: number
  let lhe: number
  let empty: number
  let off: number
  let orderX: number
  let orderK: number
  let orderO: number
  let tidX: string

  const panel = async (actor: Actor | null, orderId: number) => {
    signIn(actor)
    return read(await transferRoute.GET(request(`http://localhost/api/v1/orders/${orderId}/fulfillment-warehouse`, "GET"), params(orderId)))
  }
  const transfer = async (actor: Actor | null, orderId: number, body: unknown) => {
    signIn(actor)
    return read(await transferRoute.POST(request(`http://localhost/api/v1/orders/${orderId}/fulfillment-warehouse`, "POST", body), params(orderId)))
  }
  const queue = async (actor: Actor) => {
    signIn(actor)
    const { body } = await read(await listRoute.GET(request("http://localhost/api/v1/warehouse/orders?view=all&limit=100", "GET")))
    return (body?.items ?? []).map((item: { id: number }) => item.id) as number[]
  }
  const detail = async (actor: Actor, orderId: number) => {
    signIn(actor)
    return read(await detailRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}`, "GET"), params(orderId)))
  }
  const progress = async (actor: Actor, orderId: number, fulfillmentStatus: string) => {
    signIn(actor)
    return read(await progressRoute.POST(
      request(`http://localhost/api/v1/warehouse/orders/${orderId}/progress`, "POST", { fulfillmentStatus }),
      params(orderId),
    ))
  }
  const stored = async (orderId: number) => {
    const [row] = await db
      .select({
        branchId: orders.branchId,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        fulfillmentWarehouseId: orders.fulfillmentWarehouseId,
        approvedAt: orders.approvedAt,
        updatedAt: orders.updatedAt,
      })
      .from(orders).where(eq(orders.id, orderId)).limit(1)
    return row
  }
  const noticesOf = async (userId: string, orderId: number) => (await db
    .select({ type: notifications.type })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.orderId, orderId))))
    .map((row) => row.type)

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "ORDER_PORTAL", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT XFER A ${suffix}`, code: `ITXFA_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    const [a1] = await db.insert(branches).values({ organizationId: orgA, name: `IT XFER A1 ${suffix}`, city: "Karachi", status: "active" })
      .returning({ id: branches.id })
    branchA1 = a1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-xfer-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-xfer-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", orgA, null)
    await person("raiser", "ORDER_PORTAL", orgA, branchA1)
    await person("orderDesk", "ORDER_DESK", null, null)
    await person("executive", "APRICART_EXECUTIVE", null, null)
    await person("khi", "WAREHOUSE", null, null)
    await person("lhe", "WAREHOUSE", null, null)
    await person("off", "WAREHOUSE", null, null)

    await db.insert(warehouseAssignments).values({ userId: actors.khi.id, branchId: branchA1, createdByUserId: actors.superAdmin.id })

    const created = await db.insert(apricartWarehouses).values([
      { code: `LHE${suffix}`.slice(0, 20).toUpperCase(), name: "Lahore warehouse", city: "Lahore" },
      { code: `EMP${suffix}`.slice(0, 20).toUpperCase(), name: "Empty warehouse" },
      { code: `OFF${suffix}`.slice(0, 20).toUpperCase(), name: "Closed warehouse", status: "INACTIVE" },
    ]).returning({ id: apricartWarehouses.id })
    ;[lhe, empty, off] = created.map((row) => row.id)
    warehouseIds.push(lhe, empty, off)
    await db.insert(apricartWarehouseMemberships).values([
      { warehouseId: lhe, userId: actors.lhe.id, responsibility: "WAREHOUSE_OPERATOR" },
      { warehouseId: off, userId: actors.off.id, responsibility: "WAREHOUSE_OPERATOR" },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITXF-RICE-${suffix}`, name: `IT XFER Rice ${suffix}`, basePrice: 35_500, status: "active", unit: "kg", stockQuantity: 50,
    }).returning({ id: globalProducts.id })
    productId = product.id

    const place = async (key: string, fulfillmentStatus: string) => {
      const [row] = await db.insert(orders).values({
        tid: `XF${suffix}${key}`.slice(0, 26),
        organizationId: orgA,
        branchId: branchA1,
        createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL",
        status: "APPROVED",
        fulfillmentStatus,
        approvedAt: new Date(),
        subtotalCents: 71_000,
        taxCents: 1_000,
        totalCents: 71_000,
        budgetTracked: false,
      }).returning({ id: orders.id, tid: orders.tid })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId: orgA, globalProductId: productId, productName: "Basmati rice", productCode: "RICE-5", unit: "kg", quantity: 2, priceCents: 35_500, taxCents: 500,
      })
      return row
    }
    const x = await place("X", "NOT_STARTED")
    orderX = x.id
    tidX = x.tid
    orderK = (await place("K", "NOT_STARTED")).id
    orderO = (await place("O", "OUT_FOR_DELIVERY")).id
  })

  afterAll(async () => {
    if (!orgA) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, orgA))).map((row) => row.id)
    if (orderIds.length > 0) {
      await purgeInvoiceLedger({ organizationIds: [orgA] })
      await db.delete(orderWarehouseTransfers).where(inArray(orderWarehouseTransfers.orderId, orderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(emailOutbox).where(inArray(emailOutbox.recipientUserId, actorIds))
    await db.delete(notifications).where(inArray(notifications.userId, actorIds))
    await db.delete(auditLogs).where(or(eq(auditLogs.organizationId, orgA), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(eq(systemLogs.organizationId, orgA), inArray(systemLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(apricartWarehouseMemberships).where(inArray(apricartWarehouseMemberships.warehouseId, warehouseIds))
    await db.delete(apricartWarehouses).where(inArray(apricartWarehouses.id, warehouseIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(branches).where(eq(branches.organizationId, orgA))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(eq(organizations.id, orgA))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    sent.length = 0
  })

  describe("who may", () => {
    const body = () => ({ targetWarehouseId: lhe, expectedWarehouseId: null, reason: "Dispatch from Lahore" })

    it("refuses an unauthenticated caller", async () => {
      expect((await panel(null, orderX)).status).toBe(401)
      expect((await transfer(null, orderX, body())).status).toBe(401)
    })

    it.each(["headOffice", "raiser", "orderDesk", "executive", "khi", "lhe"])("refuses %s", async (key) => {
      expect((await panel(actors[key], orderX)).status).toBe(403)
      expect((await transfer(actors[key], orderX, body())).status).toBe(403)
      expect((await stored(orderX)).fulfillmentWarehouseId).toBeNull()
    })

    it("answers an order that does not exist as 404", async () => {
      expect((await panel(actors.superAdmin, 2_000_000_000)).status).toBe(404)
      expect((await transfer(actors.superAdmin, 2_000_000_000, body())).status).toBe(404)
    })
  })

  describe("what is refused", () => {
    it("validates the body strictly", async () => {
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: lhe, expectedWarehouseId: null })).status).toBe(400)
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: lhe, expectedWarehouseId: null, reason: "  " })).status).toBe(400)
      expect((await transfer(actors.superAdmin, orderX, {
        targetWarehouseId: lhe, expectedWarehouseId: null, reason: "ok reason", branchId: 1,
      })).status).toBe(400)
    })

    it("refuses an order that has left the warehouse", async () => {
      const response = await transfer(actors.superAdmin, orderO, { targetWarehouseId: lhe, expectedWarehouseId: null, reason: "Too late" })
      expect(response.status).toBe(409)
      expect((await stored(orderO)).fulfillmentWarehouseId).toBeNull()
    })

    it("refuses a warehouse with no operator, an inactive one, and one that does not exist", async () => {
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: empty, expectedWarehouseId: null, reason: "No one there" })).status).toBe(409)
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: off, expectedWarehouseId: null, reason: "Closed" })).status).toBe(409)
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: 2_000_000_000, expectedWarehouseId: null, reason: "Ghost" })).status).toBe(404)
      expect((await stored(orderX)).fulfillmentWarehouseId).toBeNull()
    })

    it("refuses to hand an untransferred order back to its branch (it is already there)", async () => {
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: null, expectedWarehouseId: null, reason: "Back" })).status).toBe(409)
    })
  })

  describe("moving the order", () => {
    it("is worked by the branch's account before any transfer", async () => {
      const { status, body } = await panel(actors.superAdmin, orderX)
      expect(status).toBe(200)
      expect(body.currentWarehouse).toBeNull()
      expect(body.refusal).toBeNull()
      expect(body.workedBy.map((account: { id: string }) => account.id)).toEqual([actors.khi.id])
      expect(body.targets.find((target: { id: number }) => target.id === lhe)?.operatorCount).toBe(1)
      expect(body.targets.some((target: { id: number }) => target.id === off)).toBe(false)

      expect(await queue(actors.khi)).toEqual(expect.arrayContaining([orderX, orderK]))
      expect(await queue(actors.lhe)).not.toContain(orderX)
      expect((await detail(actors.lhe, orderX)).status).toBe(404)
    })

    it("moves only the order named, and only its warehouse", async () => {
      const before = await stored(orderX)
      const response = await transfer(actors.superAdmin, orderX, { targetWarehouseId: lhe, expectedWarehouseId: null, reason: "Out of stock in Karachi" })
      expect(response.status).toBe(200)
      expect(response.body.item).toMatchObject({ orderId: orderX, fromWarehouseId: null, toWarehouseId: lhe })

      const after = await stored(orderX)
      expect(after.fulfillmentWarehouseId).toBe(lhe)
      // Branch, status, stage, delivery clock and the executive's optimistic token are untouched.
      expect(after.branchId).toBe(before.branchId)
      expect(after.status).toBe(before.status)
      expect(after.fulfillmentStatus).toBe(before.fulfillmentStatus)
      expect(after.approvedAt?.toISOString()).toBe(before.approvedAt?.toISOString())
      expect(after.updatedAt?.toISOString()).toBe(before.updatedAt?.toISOString())
      expect((await stored(orderK)).fulfillmentWarehouseId).toBeNull()

      const history = await db.select().from(orderWarehouseTransfers).where(eq(orderWarehouseTransfers.orderId, orderX))
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ fromWarehouseId: null, toWarehouseId: lhe, reason: "Out of stock in Karachi", transferredByUserId: actors.superAdmin.id })

      const [audit] = await db.select({ metadata: auditLogs.metadata, branchId: auditLogs.branchId }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_WAREHOUSE_TRANSFERRED"), eq(auditLogs.entityId, String(orderX))))
      expect(audit.branchId).toBe(branchA1)
      expect(audit.metadata).toMatchObject({ reason: "Out of stock in Karachi", tid: tidX })
    })

    it("leaves the branch's account and reaches the target warehouse's operator at once", async () => {
      const khiQueue = await queue(actors.khi)
      expect(khiQueue).not.toContain(orderX)
      expect(khiQueue).toContain(orderK)
      expect((await detail(actors.khi, orderX)).status).toBe(404)
      expect((await progress(actors.khi, orderX, "IN_PROCESS")).status).toBe(404)

      const lheQueue = await queue(actors.lhe)
      expect(lheQueue).toContain(orderX)
      expect(lheQueue).not.toContain(orderK)
      const sheet = await detail(actors.lhe, orderX)
      expect(sheet.status).toBe(200)
      expect(sheet.body.order.transferredToWarehouse).toMatchObject({ name: "Lahore warehouse" })
      expect((await detail(actors.lhe, orderK)).status).toBe(404)

      signIn(actors.lhe)
      const workload = await read(await workloadRoute.GET(request("http://localhost/api/v1/warehouse/workload", "GET")))
      expect(workload.status).toBe(200)
      expect(JSON.stringify(workload.body)).toContain(tidX)
    })

    it("tells both sides, and each only what concerns it", async () => {
      expect(await noticesOf(actors.khi.id, orderX)).toEqual(["WAREHOUSE_ORDER_TRANSFERRED_OUT"])
      expect(await noticesOf(actors.lhe.id, orderX)).toEqual(["WAREHOUSE_ORDER_TRANSFERRED_IN"])

      signIn(actors.lhe)
      const lheBell = await read(await noticesRoute.GET())
      expect(lheBell.body.items.find((item: { event: string }) => item.event === "TRANSFERRED_IN")?.href).toBe("/warehouse#orders")
      signIn(actors.khi)
      const khiBell = await read(await noticesRoute.GET())
      const moved = khiBell.body.items.find((item: { event: string }) => item.event === "TRANSFERRED_OUT")
      expect(moved).toBeDefined()
      expect(moved.href).toBeNull()
    })

    it("lets the new warehouse move the order forward", async () => {
      expect((await progress(actors.lhe, orderX, "IN_PROCESS")).status).toBe(200)
      expect((await stored(orderX)).fulfillmentStatus).toBe("IN_PROCESS")
    })

    it("refuses a transfer based on a stale view, and a no-op", async () => {
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: null, expectedWarehouseId: null, reason: "Stale screen" })).status).toBe(409)
      expect((await transfer(actors.superAdmin, orderX, { targetWarehouseId: lhe, expectedWarehouseId: lhe, reason: "Again" })).status).toBe(409)
      expect((await stored(orderX)).fulfillmentWarehouseId).toBe(lhe)
    })

    it("will not let the warehouse be stranded while it holds the order", async () => {
      signIn(actors.superAdmin)
      const removal = await read(await warehouseMembersRoute.PUT(
        request(`http://localhost/api/v1/apricart-warehouses/${lhe}/members`, "PUT", { userId: actors.lhe.id, assigned: false }),
        params(lhe),
      ))
      expect(removal.status).toBe(409)
      const deactivate = await read(await warehouseRoute.PATCH(
        request(`http://localhost/api/v1/apricart-warehouses/${lhe}`, "PATCH", { status: "INACTIVE" }),
        params(lhe),
      ))
      expect(deactivate.status).toBe(409)
      expect(await queue(actors.lhe)).toContain(orderX)
    })

    it("hands the order back to the branch's account", async () => {
      const response = await transfer(actors.superAdmin, orderX, { targetWarehouseId: null, expectedWarehouseId: lhe, reason: "Karachi restocked" })
      expect(response.status).toBe(200)
      expect((await stored(orderX)).fulfillmentWarehouseId).toBeNull()
      expect(await queue(actors.khi)).toContain(orderX)
      expect(await queue(actors.lhe)).not.toContain(orderX)

      const { body } = await panel(actors.superAdmin, orderX)
      expect(body.history.map((entry: { to: { id: number } | null }) => entry.to?.id ?? null)).toEqual([null, lhe])
      expect(await noticesOf(actors.khi.id, orderX)).toEqual(expect.arrayContaining(["WAREHOUSE_ORDER_TRANSFERRED_IN"]))
    })
  })
})
