import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"
import sharp from "sharp"

import * as uploadRoute from "@/app/api/v1/upload/image/route"
import * as superAdminProgressRoute from "@/app/api/v1/orders/[id]/fulfillment-status/route"
import * as listRoute from "@/app/api/v1/warehouse/orders/route"
import * as detailRoute from "@/app/api/v1/warehouse/orders/[id]/route"
import * as progressRoute from "@/app/api/v1/warehouse/orders/[id]/progress/route"
import * as timelineRoute from "@/app/api/v1/warehouse/orders/[id]/timeline/route"
import * as challanRoute from "@/app/api/v1/warehouse/orders/[id]/delivery-challan/route"
import * as challanFileRoute from "@/app/api/v1/warehouse/orders/[id]/delivery-challan/[challanId]/file/route"
import * as workloadRoute from "@/app/api/v1/warehouse/workload/route"
import * as catalogRoute from "@/app/api/v1/warehouse/catalog/route"
import * as invoiceRoute from "@/app/api/v1/warehouse/orders/[id]/invoice/route"
import * as tenantInvoiceRoute from "@/app/api/v1/receipts/[orderId]/download/route"
import * as teamRoute from "@/app/api/v1/warehouse-team/route"
import * as teamBranchesRoute from "@/app/api/v1/warehouse-team/[userId]/branches/route"
import * as teamCitiesRoute from "@/app/api/v1/warehouse-team/[userId]/cities/route"
import {
  auditLogs,
  branches,
  globalProducts,
  orderDeliveryChallans,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The Warehouse role, end to end, against Postgres.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 *
 * Identity, request headers, the rate limiter, the cache and the S3 bucket are
 * faked (the bucket by an in-memory map); every route is the real handler and
 * every constraint the real one.
 *
 * ```text
 * Tenant A                                   Tenant B
 *   branch A1  ← warehouse "wh" serves        branch B1  ← "wh" serves
 *     X approved, not started (2 lines)          Z approved, out for delivery
 *     P pending
 *     T approved, out for delivery, token already handed off
 *     C approved, out for delivery (for the concurrency case)
 *   branch A2  — not assigned to anyone
 *     Y approved, not started
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
const bucket = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>())
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return {
    ...actual,
    isImageStorageConfigured: () => true,
    putImage: vi.fn(async (input: { key: string; body: Buffer; contentType: string }) => {
      bucket.set(input.key, { body: input.body, contentType: input.contentType })
    }),
    getImage: vi.fn(async (key: string) => {
      const object = bucket.get(key)
      if (!object) return null
      return {
        body: { transformToWebStream: () => new Blob([new Uint8Array(object.body)]).stream() },
        contentType: object.contentType,
        contentLength: object.body.length,
      }
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
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("the Warehouse role through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchB1: number
  let productId: number
  let orderX: number
  let orderY: number
  let orderZ: number
  let orderP: number
  let orderT: number
  let orderC: number
  let png: Buffer

  const list = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await listRoute.GET(request(`http://localhost/api/v1/warehouse/orders${query}`, "GET")))
  }
  const detail = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await detailRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}`, "GET"), params(orderId)))
  }
  const progress = async (actor: Actor | null, orderId: number, body: unknown) => {
    signIn(actor)
    return read(await progressRoute.POST(request(`http://localhost/api/v1/warehouse/orders/${orderId}/progress`, "POST", body), params(orderId)))
  }
  const upload = async (actor: Actor | null, orderId: number, purpose: string | null = "delivery-challan") => {
    signIn(actor)
    const form = new FormData()
    form.append("image", new File([new Uint8Array(png)], "challan.png", { type: "image/png" }))
    if (purpose !== null) form.append("purpose", purpose)
    form.append("orderId", String(orderId))
    return read(await uploadRoute.POST(new NextRequest("http://localhost/api/v1/upload/image", { method: "POST", body: form })))
  }
  const assign = async (actor: Actor | null, userId: string, body: unknown) => {
    signIn(actor)
    return read(await teamBranchesRoute.PUT(
      request(`http://localhost/api/v1/warehouse-team/${userId}/branches`, "PUT", body),
      { params: Promise.resolve({ userId }) },
    ))
  }
  const assignCity = async (actor: Actor | null, userId: string, body: unknown) => {
    signIn(actor)
    return read(await teamCitiesRoute.PUT(
      request(`http://localhost/api/v1/warehouse-team/${userId}/cities`, "PUT", body),
      { params: Promise.resolve({ userId }) },
    ))
  }
  const stored = async (orderId: number) => {
    const [row] = await db
      .select({ status: orders.status, fulfillmentStatus: orders.fulfillmentStatus, deliveredAt: orders.deliveredAt })
      .from(orders).where(eq(orders.id, orderId)).limit(1)
    return row
  }

  beforeAll(async () => {
    png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer()

    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT WH A ${suffix}`, code: `ITWHA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT WH B ${suffix}`, code: `ITWHB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id

    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT WH A1 ${suffix}`, city: "Lahore", address: "1 Mall Road", status: "active" },
      { organizationId: orgA, name: `IT WH A2 ${suffix}`, city: "Lahore", status: "active" },
      { organizationId: orgB, name: `IT WH B1 ${suffix}`, city: "Karachi", status: "active" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null, isActive = true) => {
      const email = `it-wh-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-wh-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", orgA, null)
    await person("branchAdmin", "BRANCH_ADMIN", orgA, branchA1)
    await person("raiser", "ORDER_PORTAL", orgA, branchA1)
    await person("orderDesk", "ORDER_DESK", null, null)
    await person("executive", "APRICART_EXECUTIVE", null, null)
    await person("wh", "WAREHOUSE", null, null)
    await person("whNone", "WAREHOUSE", null, null)
    await person("whInactive", "WAREHOUSE", null, null, false)
    await person("whOther", "WAREHOUSE", null, null)
    await person("whCity", "WAREHOUSE", null, null)

    await db.insert(warehouseAssignments).values([
      { userId: actors.wh.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
      { userId: actors.wh.id, branchId: branchB1, createdByUserId: actors.superAdmin.id },
      { userId: actors.whInactive.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
      { userId: actors.whOther.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITWH-RICE-${suffix}`, name: `IT WH Rice ${suffix}`, basePrice: 35_500, status: "active", unit: "kg", stockQuantity: 120,
    }).returning({ id: globalProducts.id })
    productId = product.id

    const place = async (key: string, values: {
      organizationId: number
      branchId: number
      status: string
      fulfillmentStatus?: string
      tokenHandoffAt?: Date
      tokenHandoffByUserId?: string
    }) => {
      const [row] = await db.insert(orders).values({
        tid: `WH${suffix}${key}`.slice(0, 26),
        createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL",
        approvedAt: values.status === "APPROVED" ? new Date() : null,
        subtotalCents: 71_000,
        taxCents: 1_000,
        totalCents: 71_000,
        notes: key === "X" ? "Deliver to the back gate" : null,
        budgetTracked: false,
        receiptData: { invoiceNumber: `INV-${key}-${suffix}` } as any,
        ...values,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values([
        { orderId: row.id, organizationId: values.organizationId, globalProductId: productId, productName: "Basmati rice", productCode: "RICE-5", unit: "kg", quantity: 2, priceCents: 35_500, taxCents: 500 },
      ])
      return row.id
    }
    orderX = await place("X", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
    orderY = await place("Y", { organizationId: orgA, branchId: branchA2, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
    orderZ = await place("Z", { organizationId: orgB, branchId: branchB1, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
    orderP = await place("P", { organizationId: orgA, branchId: branchA1, status: "PENDING" })
    orderC = await place("C", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })
    orderT = await place("T", {
      organizationId: orgA,
      branchId: branchA1,
      status: "APPROVED",
      fulfillmentStatus: "OUT_FOR_DELIVERY",
      tokenHandoffAt: new Date(),
      tokenHandoffByUserId: actors.branchAdmin.id,
    })
  })

  afterAll(async () => {
    if (!orgA) return
    const organizationIds = [orgA, orgB]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const orderRows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds))
    const orderIds = orderRows.map((row) => row.id)
    if (orderIds.length > 0) {
      // Delivering an order issues its tax invoice, which holds its items.
      await purgeInvoiceLedger({ organizationIds })
      await db.delete(orderDeliveryChallans).where(inArray(orderDeliveryChallans.orderId, orderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, actorIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may call the warehouse endpoints", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await list(null)).status).toBe(401)
      expect((await detail(null, orderX)).status).toBe(401)
      expect((await progress(null, orderX, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(401)
    })

    it.each(["superAdmin", "headOffice", "branchAdmin", "raiser", "orderDesk", "executive"])("refuses %s", async (key) => {
      expect((await list(actors[key])).status).toBe(403)
      expect((await detail(actors[key], orderX)).status).toBe(403)
      expect((await progress(actors[key], orderX, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(403)
      signIn(actors[key])
      expect((await catalogRoute.GET(request("http://localhost/api/v1/warehouse/catalog", "GET"))).status).toBe(403)
      expect((await stored(orderX)).fulfillmentStatus).toBe("NOT_STARTED")
    })
  })

  describe("the queue", () => {
    it("lists approved work at the assigned branches only, across organizations", async () => {
      const { status, body } = await list(actors.wh, "?view=all")
      expect(status).toBe(200)
      const ids = body.items.map((item: { id: number }) => item.id)
      expect(ids).toEqual(expect.arrayContaining([orderX, orderZ, orderT, orderC]))
      // Not another branch of the same tenant, and never a pending order.
      expect(ids).not.toContain(orderY)
      expect(ids).not.toContain(orderP)
      expect(body.reach.branches.map((branch: { id: number }) => branch.id).sort()).toEqual([branchA1, branchB1].sort())
      expect(body.reach.organizations.map((organization: { id: number }) => organization.id).sort()).toEqual([orgA, orgB].sort())
    })

    it("carries prices and invoice figures, and lines when asked", async () => {
      const { body } = await list(actors.wh, `?view=all&branchId=${branchA1}&lines=1`)
      const row = body.items.find((item: { id: number }) => item.id === orderX)
      expect(row).toMatchObject({ totalCents: 71_000, invoiceNumber: `INV-X-${suffix}`, paymentStatus: "UNPAID", itemCount: 1, nextStage: "IN_PROCESS" })
      expect(row.lines).toEqual([expect.objectContaining({ productCode: "RICE-5", quantity: 2, priceCents: 35_500, amountCents: 71_000 })])
      // Never the people behind the order.
      expect(JSON.stringify(body)).not.toContain(actors.raiser.email)
      expect(JSON.stringify(body)).not.toContain(actors.raiser.id)
    })

    it("counts each open stage", async () => {
      const { body } = await list(actors.wh, `?organizationId=${orgA}`)
      expect(body.counts).toMatchObject({ NOT_STARTED: 1, IN_PROCESS: 1, OUT_FOR_DELIVERY: 1 })
    })

    it("reads empty for a branch outside the reach, whatever the filter names", async () => {
      const { status, body } = await list(actors.wh, `?view=all&organizationId=${orgA}&branchId=${branchA2}`)
      expect(status).toBe(200)
      expect(body.items).toEqual([])
    })

    it("is empty with no branches, and for a deactivated account", async () => {
      for (const key of ["whNone", "whInactive"]) {
        const { status, body } = await list(actors[key], "?view=all")
        expect(status).toBe(200)
        expect(body.items).toEqual([])
        expect(body.reach.branches).toEqual([])
      }
    })

    it("refuses a malformed filter", async () => {
      expect((await list(actors.wh, "?branchId=1%20OR%201%3D1")).status).toBe(400)
      expect((await list(actors.wh, "?sort=total")).status).toBe(400)
    })
  })

  describe("the picking sheet", () => {
    it("shows lines, destination, notes and invoice for an order in reach", async () => {
      const { status, body } = await detail(actors.wh, orderX)
      expect(status).toBe(200)
      expect(body.order).toMatchObject({ id: orderX, notes: "Deliver to the back gate", stage: "NOT_STARTED", nextStage: "IN_PROCESS" })
      expect(body.destination).toMatchObject({ address: "1 Mall Road", city: "Lahore", isBranchAddress: true })
      expect(body.invoice).toMatchObject({ invoiceNumber: `INV-X-${suffix}`, totalCents: 71_000, taxCents: 1_000, paymentStatus: "UNPAID" })
      expect(body.lines).toHaveLength(1)
    })

    it("is 404 outside the reach, for a pending order, and for an id that does not exist", async () => {
      expect((await detail(actors.wh, orderY)).status).toBe(404)
      expect((await detail(actors.wh, orderP)).status).toBe(404)
      expect((await detail(actors.wh, 2_000_000_000)).status).toBe(404)
      expect((await detail(actors.wh, "abc")).status).toBe(404)
      expect((await detail(actors.whNone, orderX)).status).toBe(404)
    })
  })

  describe("moving a delivery forward", () => {
    it("moves one stage at a time, recording who moved it", async () => {
      const started = await progress(actors.wh, orderX, { fulfillmentStatus: "IN_PROCESS" })
      expect(started.status).toBe(200)
      expect((await stored(orderX)).fulfillmentStatus).toBe("IN_PROCESS")

      const [audit] = await db.select({ metadata: auditLogs.metadata, userId: auditLogs.userId }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_FULFILLMENT_STATUS_UPDATE"), eq(auditLogs.entityId, String(orderX))))
      expect(audit?.userId).toBe(actors.wh.id)
      expect(audit?.metadata).toMatchObject({ from: "NOT_STARTED", to: "IN_PROCESS", actorRole: "WAREHOUSE" })
    })

    it("refuses to skip a stage, to repeat one, or to step back", async () => {
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "DELIVERED" })).status).toBe(409)
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(409)
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "NOT_STARTED" })).status).toBe(400)
      expect((await stored(orderX)).fulfillmentStatus).toBe("IN_PROCESS")
    })

    it("refuses a challan before delivery, and any extra field", async () => {
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "OUT_FOR_DELIVERY", deliveryChallanId: 1 })).status).toBe(400)
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "OUT_FOR_DELIVERY", status: "FULFILLED" })).status).toBe(400)
    })

    it("answers 404 outside the reach and leaves the order alone", async () => {
      expect((await progress(actors.wh, orderY, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
      expect((await progress(actors.whNone, orderX, { fulfillmentStatus: "OUT_FOR_DELIVERY" })).status).toBe(404)
      expect((await progress(actors.whInactive, orderX, { fulfillmentStatus: "OUT_FOR_DELIVERY" })).status).toBe(404)
      expect((await stored(orderY)).fulfillmentStatus).toBe("NOT_STARTED")
      expect((await stored(orderX)).fulfillmentStatus).toBe("IN_PROCESS")
    })

    it("never moves an order that is not approved, and does not reveal its status", async () => {
      // 404, not 409: a pending order is not the warehouse's work, so it reads
      // exactly like one outside the reach (AC1).
      expect((await progress(actors.wh, orderP, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
      expect((await stored(orderP)).fulfillmentStatus).toBe("NOT_STARTED")
    })

    it("lets exactly one of two simultaneous moves win", async () => {
      const outcomes = await Promise.all([
        progress(actors.wh, orderC, { fulfillmentStatus: "OUT_FOR_DELIVERY" }),
        progress(actors.whOther, orderC, { fulfillmentStatus: "OUT_FOR_DELIVERY" }),
      ])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 409])
      expect((await stored(orderC)).fulfillmentStatus).toBe("OUT_FOR_DELIVERY")
      const rows = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_FULFILLMENT_STATUS_UPDATE"), eq(auditLogs.entityId, String(orderC))))
      expect(rows).toHaveLength(1)
    })

    it("marks delivered without a challan, writing delivered_at once", async () => {
      expect((await progress(actors.wh, orderX, { fulfillmentStatus: "OUT_FOR_DELIVERY" })).status).toBe(200)
      const delivered = await progress(actors.wh, orderX, { fulfillmentStatus: "DELIVERED" })
      expect(delivered.status).toBe(200)
      expect(delivered.body).toMatchObject({ fulfilled: false, item: { fulfillmentStatus: "DELIVERED" } })
      const row = await stored(orderX)
      expect(row).toMatchObject({ status: "APPROVED", fulfillmentStatus: "DELIVERED" })
      expect(row.deliveredAt).not.toBeNull()
    })

    it("still requires the challan when Super Admin delivers through its own route", async () => {
      signIn(actors.superAdmin)
      const response = await read(await superAdminProgressRoute.POST(
        request(`http://localhost/api/v1/orders/${orderC}/fulfillment-status`, "POST", { fulfillmentStatus: "DELIVERED" }),
        params(orderC),
      ))
      expect(response.status).toBe(400)
      expect((await stored(orderC)).fulfillmentStatus).toBe("OUT_FOR_DELIVERY")
    })

    it("settles an order whose token was already handed over, exactly as Super Admin's delivery does", async () => {
      const { status, body } = await progress(actors.wh, orderT, { fulfillmentStatus: "DELIVERED" })
      expect(status).toBe(200)
      expect(body.fulfilled).toBe(true)
      expect((await stored(orderT)).status).toBe("FULFILLED")
      const [settled] = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_FULFILLED_ON_DELIVERY"), eq(auditLogs.entityId, String(orderT))))
      expect(settled).toBeTruthy()
    })
  })

  describe("the delivery challan", () => {
    let zChallanId: number

    it("is uploaded by the warehouse only for an order in reach that is out for delivery or delivered", async () => {
      expect((await upload(actors.wh, orderY)).status).toBe(404)
      expect((await upload(actors.whNone, orderZ)).status).toBe(404)
      // A pending order is not its work: 404, like one outside the reach (AC1).
      expect((await upload(actors.wh, orderP)).status).toBe(404)
      const accepted = await upload(actors.wh, orderZ)
      expect(accepted.status).toBe(201)
      zChallanId = accepted.body.deliveryChallan.id
    })

    it("is the only thing the warehouse may upload", async () => {
      expect((await upload(actors.wh, orderZ, null)).status).toBe(403)
      expect((await upload(actors.wh, orderZ, "catalogue")).status).toBe(403)
    })

    it("refuses someone else's upload at delivery and rolls the delivery back", async () => {
      const foreign = await upload(actors.superAdmin, orderZ)
      expect(foreign.status).toBe(201)
      const { status } = await progress(actors.wh, orderZ, { fulfillmentStatus: "DELIVERED", deliveryChallanId: foreign.body.deliveryChallan.id })
      expect(status).toBe(400)
      expect(await stored(orderZ)).toMatchObject({ fulfillmentStatus: "OUT_FOR_DELIVERY", deliveredAt: null })
    })

    it("is attached when named on the delivery, in the same transaction", async () => {
      const { status } = await progress(actors.wh, orderZ, { fulfillmentStatus: "DELIVERED", deliveryChallanId: zChallanId })
      expect(status).toBe(200)
      const [row] = await db.select({ attachedAt: orderDeliveryChallans.attachedAt }).from(orderDeliveryChallans)
        .where(eq(orderDeliveryChallans.id, zChallanId))
      expect(row.attachedAt).not.toBeNull()
    })

    it("can be added later to a delivered order that has none, once", async () => {
      const uploaded = await upload(actors.wh, orderX)
      expect(uploaded.status).toBe(201)
      signIn(actors.wh)
      const added = await read(await challanRoute.POST(
        request(`http://localhost/api/v1/warehouse/orders/${orderX}/delivery-challan`, "POST", { deliveryChallanId: uploaded.body.deliveryChallan.id }),
        params(orderX),
      ))
      expect(added.status).toBe(201)
      const [audit] = await db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ADD_DELIVERY_CHALLAN"), eq(auditLogs.entityId, String(orderX))))
      expect(audit).toBeTruthy()

      const second = await upload(actors.wh, orderX)
      signIn(actors.wh)
      const again = await read(await challanRoute.POST(
        request(`http://localhost/api/v1/warehouse/orders/${orderX}/delivery-challan`, "POST", { deliveryChallanId: second.body.deliveryChallan.id }),
        params(orderX),
      ))
      expect(again.status).toBe(409)
    })

    it("is not added to an order that is not delivered yet", async () => {
      const uploaded = await upload(actors.wh, orderC)
      expect(uploaded.status).toBe(201)
      signIn(actors.wh)
      const refused = await read(await challanRoute.POST(
        request(`http://localhost/api/v1/warehouse/orders/${orderC}/delivery-challan`, "POST", { deliveryChallanId: uploaded.body.deliveryChallan.id }),
        params(orderC),
      ))
      expect(refused.status).toBe(409)
    })

    it("is read and streamed in reach, and 404 outside it", async () => {
      signIn(actors.wh)
      const listed = await read(await challanRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderZ}/delivery-challan`, "GET"), params(orderZ)))
      expect(listed.status).toBe(200)
      expect(listed.body.items.map((item: { id: number }) => item.id)).toEqual([zChallanId])

      signIn(actors.wh)
      const file = await challanFileRoute.GET(
        request(`http://localhost/api/v1/warehouse/orders/${orderZ}/delivery-challan/${zChallanId}/file`, "GET"),
        { params: Promise.resolve({ id: String(orderZ), challanId: String(zChallanId) }) },
      )
      expect(file.status).toBe(200)
      expect(file.headers.get("Cache-Control")).toContain("no-store")
      expect(file.headers.get("X-Content-Type-Options")).toBe("nosniff")

      signIn(actors.whOther)
      const outside = await challanFileRoute.GET(
        request(`http://localhost/api/v1/warehouse/orders/${orderZ}/delivery-challan/${zChallanId}/file`, "GET"),
        { params: Promise.resolve({ id: String(orderZ), challanId: String(zChallanId) }) },
      )
      expect(outside.status).toBe(404)
    })
  })

  describe("workload, timeline and the catalogue", () => {
    it("fences the workload dashboard to the user's branches", async () => {
      signIn(actors.wh)
      const { status, body } = await read(await workloadRoute.GET(request("http://localhost/api/v1/warehouse/workload", "GET")))
      expect(status).toBe(200)
      const ids = body.orders.items.map((item: { id: number }) => item.id)
      // Its own branches' work, delivered or not, and never A2's order.
      expect(ids).toEqual(expect.arrayContaining([orderX, orderC]))
      expect(ids).not.toContain(orderY)
      // Every row it is shown sits at one of its branches.
      expect(body.orders.items.every((item: { branchId: number }) => [branchA1, branchB1].includes(item.branchId))).toBe(true)
      // And it is offered only its own organizations to filter by.
      const offered = body.options.organizations.map((organization: { id: number }) => organization.id)
      expect([...offered].sort()).toEqual([orgA, orgB].sort())

      signIn(actors.wh)
      const narrowed = await read(await workloadRoute.GET(request(`http://localhost/api/v1/warehouse/workload?organizationId=${orgA}`, "GET")))
      expect(narrowed.body.options.branches.map((branch: { id: number }) => branch.id).sort()).toEqual([branchA1])

      signIn(actors.whNone)
      const empty = await read(await workloadRoute.GET(request("http://localhost/api/v1/warehouse/workload", "GET")))
      expect(empty.status).toBe(200)
      expect(empty.body.orders.items).toEqual([])
      expect(empty.body.options.organizations).toEqual([])
    })

    it("shows an order's timeline in reach, naming the warehouse as the actor", async () => {
      signIn(actors.wh)
      const { status, body } = await read(await timelineRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderX}/timeline`, "GET"), params(orderX)))
      expect(status).toBe(200)
      expect(body.events.some((event: { by: string | null }) => event.by === "Warehouse")).toBe(true)

      signIn(actors.wh)
      expect((await timelineRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderY}/timeline`, "GET"), params(orderY))).status).toBe(404)
    })

    it("lists the catalogue read-only, with stock and without prices", async () => {
      signIn(actors.wh)
      const { status, body } = await read(await catalogRoute.GET(request(`http://localhost/api/v1/warehouse/catalog?q=ITWH-RICE-${suffix}`, "GET")))
      expect(status).toBe(200)
      expect(body.items).toEqual([expect.objectContaining({ id: productId, stockQuantity: 120, unit: "kg", low: false })])
      expect(JSON.stringify(body)).not.toMatch(/price|35500/i)
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(catalogRoute).not.toHaveProperty(method)
    })
  })

  describe("the invoice", () => {
    const invoice = async (actor: Actor | null, orderId: number | string) => {
      signIn(actor)
      return invoiceRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}/invoice`, "GET"), params(orderId))
    }

    it("is the PDF of an order at its branch", async () => {
      const response = await invoice(actors.wh, orderX)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe("application/pdf")
      expect(response.headers.get("Content-Disposition")).toContain(`invoice-INV-X-${suffix}.pdf`)
      expect(response.headers.get("Cache-Control")).toContain("no-store")
      const bytes = Buffer.from(await response.arrayBuffer())
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-")
    })

    it("is 404 outside the reach, for an unknown id, and for an account with no branches", async () => {
      expect((await invoice(actors.wh, orderY)).status).toBe(404)
      expect((await invoice(actors.wh, 2_000_000_000)).status).toBe(404)
      expect((await invoice(actors.wh, "abc")).status).toBe(404)
      expect((await invoice(actors.whNone, orderX)).status).toBe(404)
      expect((await invoice(actors.whInactive, orderX)).status).toBe(404)
    })

    it("is not issued before the order is approved, and the order reads as not found", async () => {
      expect((await invoice(actors.wh, orderP)).status).toBe(404)
    })

    it("is refused to everyone but the warehouse here", async () => {
      expect((await invoice(null, orderX)).status).toBe(401)
      for (const key of ["superAdmin", "headOffice", "branchAdmin", "raiser", "orderDesk", "executive"]) {
        expect((await invoice(actors[key], orderX)).status, key).toBe(403)
      }
    })

    it("is the same document the customer's own download still serves", async () => {
      signIn(actors.headOffice)
      const response = await tenantInvoiceRoute.GET(
        request(`http://localhost/api/v1/receipts/${orderX}/download`, "GET"),
        { params: Promise.resolve({ orderId: String(orderX) }) },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toBe("application/pdf")
      expect(response.headers.get("Content-Disposition")).toContain(`invoice-INV-X-${suffix}.pdf`)
    })

    it("is never reached through the tenant invoice download, which the warehouse has no organization for", async () => {
      signIn(actors.wh)
      const response = await tenantInvoiceRoute.GET(
        request(`http://localhost/api/v1/receipts/${orderX}/download`, "GET"),
        { params: Promise.resolve({ orderId: String(orderX) }) },
      )
      expect(response.status).not.toBe(200)
      expect(response.headers.get("Content-Type")).not.toBe("application/pdf")
    })
  })

  describe("Super Admin assigning branches", () => {
    it("is Super Admin's alone", async () => {
      signIn(actors.headOffice)
      expect((await teamRoute.GET()).status).toBe(403)
      expect((await assign(actors.headOffice, actors.whNone.id, { organizationId: orgA, branchIds: [branchA1] })).status).toBe(403)
      expect((await assign(actors.wh, actors.whNone.id, { organizationId: orgA, branchIds: [branchA1] })).status).toBe(403)
    })

    it("lists the team with each member's branches", async () => {
      signIn(actors.superAdmin)
      const { status, body } = await read(await teamRoute.GET())
      expect(status).toBe(200)
      const member = body.members.find((candidate: { id: string }) => candidate.id === actors.wh.id)
      expect(member.branchIds.sort()).toEqual([branchA1, branchB1].sort())
    })

    it("refuses a branch of another organization, and a user who is not a warehouse account", async () => {
      expect((await assign(actors.superAdmin, actors.whNone.id, { organizationId: orgA, branchIds: [branchB1] })).status).toBe(400)
      expect((await assign(actors.superAdmin, actors.headOffice.id, { organizationId: orgA, branchIds: [branchA1] })).status).toBe(404)
      expect((await assign(actors.superAdmin, actors.whNone.id, { organizationId: orgA, branchIds: [branchA1, branchA1] })).status).toBe(400)
    })

    it("replaces one organization's branches only, audited, and the reach follows at once", async () => {
      const added = await assign(actors.superAdmin, actors.wh.id, { organizationId: orgA, branchIds: [branchA1, branchA2] })
      expect(added.status).toBe(200)
      expect((await detail(actors.wh, orderY)).status).toBe(200)
      // The other organization's branch is untouched.
      expect((await detail(actors.wh, orderZ)).status).toBe(200)

      const withdrawn = await assign(actors.superAdmin, actors.wh.id, { organizationId: orgB, branchIds: [] })
      expect(withdrawn.status).toBe(200)
      expect((await detail(actors.wh, orderZ)).status).toBe(404)
      expect((await detail(actors.wh, orderY)).status).toBe(200)

      const audits = await db.select({ metadata: auditLogs.metadata, organizationId: auditLogs.organizationId }).from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_WAREHOUSE_ASSIGNMENTS"), eq(auditLogs.entityId, actors.wh.id)))
      expect(audits).toHaveLength(2)
      expect(audits.map((audit) => audit.organizationId).sort()).toEqual([orgA, orgB].sort())
    })
  })

  describe("Super Admin assigning whole cities", () => {
    // A city no other suite or leftover row can share, spelt several ways.
    const cityLabel = () => `Itwh City ${suffix}`
    let cityA1: number
    let cityB1: number
    let orderQ: number
    let orderR: number

    const approvedAt = async (organizationId: number, branchId: number, key: string) => {
      const [row] = await db.insert(orders).values({
        tid: `WC${suffix}${key}`.slice(0, 26),
        organizationId,
        branchId,
        createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL",
        status: "APPROVED",
        fulfillmentStatus: "NOT_STARTED",
        approvedAt: new Date(),
        subtotalCents: 1_000,
        taxCents: 0,
        totalCents: 1_000,
        budgetTracked: false,
      }).returning({ id: orders.id })
      return row.id
    }

    beforeAll(async () => {
      const [a1, b1] = await db.insert(branches).values([
        { organizationId: orgA, name: `IT WH City A1 ${suffix}`, city: cityLabel(), status: "active" },
        { organizationId: orgB, name: `IT WH City B1 ${suffix}`, city: `  Itwh   City ${suffix} `, status: "active" },
      ]).returning({ id: branches.id })
      cityA1 = a1.id
      cityB1 = b1.id
      orderQ = await approvedAt(orgA, cityA1, "Q")
      orderR = await approvedAt(orgB, cityB1, "R")
    })

    it("is Super Admin's alone", async () => {
      const body = { city: cityLabel(), assigned: true }
      expect((await assignCity(null, actors.whCity.id, body)).status).toBe(401)
      expect((await assignCity(actors.headOffice, actors.whCity.id, body)).status).toBe(403)
      expect((await assignCity(actors.wh, actors.whCity.id, body)).status).toBe(403)
      expect((await assignCity(actors.orderDesk, actors.whCity.id, body)).status).toBe(403)
      expect((await detail(actors.whCity, orderQ)).status).toBe(404)
    })

    it("refuses a city with no branch, a malformed body, and a user who is not a warehouse account", async () => {
      const unknown = await assignCity(actors.superAdmin, actors.whCity.id, { city: `Nowhere ${suffix}`, assigned: true })
      expect(unknown.status).toBe(400)
      expect(unknown.body.error).toBe("No branch is in that city")
      expect((await assignCity(actors.superAdmin, actors.whCity.id, { city: cityLabel() })).status).toBe(400)
      expect((await assignCity(actors.superAdmin, actors.whCity.id, { city: cityLabel(), assigned: true, branchIds: [cityA1] })).status).toBe(400)
      expect((await assignCity(actors.superAdmin, actors.headOffice.id, { city: cityLabel(), assigned: true })).status).toBe(404)
      expect((await assignCity(actors.superAdmin, randomUUID(), { city: cityLabel(), assigned: true })).status).toBe(404)
      const rows = await db.select().from(warehouseCityAssignments).where(eq(warehouseCityAssignments.userId, actors.whCity.id))
      expect(rows).toHaveLength(0)
    })

    it("serves every branch in the city, across organizations and spellings, including one opened later", async () => {
      const key = `itwh city ${suffix}`
      const assigned = await assignCity(actors.superAdmin, actors.whCity.id, { city: `ITWH CITY ${suffix}`, assigned: true })
      expect(assigned.status).toBe(200)
      expect(assigned.body.item).toMatchObject({ city: { key, label: cityLabel() }, assigned: true, branchCount: 2 })

      expect((await detail(actors.whCity, orderQ)).status).toBe(200)
      expect((await detail(actors.whCity, orderR)).status).toBe(200)
      // Branches outside the city stay out of reach.
      expect((await detail(actors.whCity, orderX)).status).toBe(404)
      const listed = await list(actors.whCity)
      expect(listed.body.items.map((item: { id: number }) => item.id).sort()).toEqual([orderQ, orderR].sort())

      // A branch opened in the city afterwards is reached with no further write.
      const [later] = await db.insert(branches).values({
        organizationId: orgA, name: `IT WH City A2 ${suffix}`, city: `itwh city ${suffix}`, status: "active",
      }).returning({ id: branches.id })
      const orderS = await approvedAt(orgA, later.id, "S")
      expect((await detail(actors.whCity, orderS)).status).toBe(200)

      // Moving that branch to another city takes it out of reach at once.
      await db.update(branches).set({ city: `Elsewhere ${suffix}` }).where(eq(branches.id, later.id))
      expect((await detail(actors.whCity, orderS)).status).toBe(404)
    })

    it("writes through the city reach, locked inside the transaction", async () => {
      const moved = await progress(actors.whCity, orderQ, { fulfillmentStatus: "IN_PROCESS" })
      expect(moved.status).toBe(200)
      expect((await stored(orderQ)).fulfillmentStatus).toBe("IN_PROCESS")
    })

    it("lists the cities with their counts and each member's cities", async () => {
      signIn(actors.superAdmin)
      const { status, body } = await read(await teamRoute.GET())
      expect(status).toBe(200)
      const key = `itwh city ${suffix}`
      expect(body.cities.find((city: { key: string }) => city.key === key))
        .toEqual({ key, label: cityLabel(), branchCount: 2, organizationCount: 2 })
      expect(body.members.find((member: { id: string }) => member.id === actors.whCity.id).cityKeys).toEqual([key])
      expect(body.branches.find((branch: { id: number }) => branch.id === cityB1).cityKey).toBe(key)
    })

    it("is idempotent, audited once per change with no organization, and withdrawn at once", async () => {
      const again = await assignCity(actors.superAdmin, actors.whCity.id, { city: cityLabel(), assigned: true })
      expect(again.status).toBe(200)
      const withdrawn = await assignCity(actors.superAdmin, actors.whCity.id, { city: `itwh  city ${suffix}`, assigned: false })
      expect(withdrawn.status).toBe(200)
      expect((await detail(actors.whCity, orderQ)).status).toBe(404)
      expect((await detail(actors.whCity, orderR)).status).toBe(404)
      expect((await assignCity(actors.superAdmin, actors.whCity.id, { city: cityLabel(), assigned: false })).status).toBe(200)

      const audits = await db
        .select({ metadata: auditLogs.metadata, organizationId: auditLogs.organizationId, userId: auditLogs.userId })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_WAREHOUSE_CITY_ASSIGNMENTS"), eq(auditLogs.entityId, actors.whCity.id)))
      expect(audits).toHaveLength(2)
      expect(audits.every((audit) => audit.organizationId === null && audit.userId === actors.superAdmin.id)).toBe(true)
      expect(audits.map((audit) => (audit.metadata as { after: { cityKeys: string[] } }).after.cityKeys))
        .toEqual(expect.arrayContaining([[`itwh city ${suffix}`], []]))
    })

    it("reaches nothing through a city for a deactivated account", async () => {
      await db.insert(warehouseCityAssignments).values({ userId: actors.whInactive.id, cityKey: `itwh city ${suffix}` })
      expect((await detail(actors.whInactive, orderR)).status).toBe(404)
    })
  })
})
