import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray, or } from "drizzle-orm"
import sharp from "sharp"

import * as uploadRoute from "@/app/api/v1/upload/image/route"
import * as listRoute from "@/app/api/v1/warehouse/orders/route"
import * as detailRoute from "@/app/api/v1/warehouse/orders/[id]/route"
import * as progressRoute from "@/app/api/v1/warehouse/orders/[id]/progress/route"
import * as timelineRoute from "@/app/api/v1/warehouse/orders/[id]/timeline/route"
import * as invoiceRoute from "@/app/api/v1/warehouse/orders/[id]/invoice/route"
import * as challanRoute from "@/app/api/v1/warehouse/orders/[id]/delivery-challan/route"
import * as challanFileRoute from "@/app/api/v1/warehouse/orders/[id]/delivery-challan/[challanId]/file/route"
import * as workloadRoute from "@/app/api/v1/warehouse/workload/route"
import * as stockRoute from "@/app/api/v1/warehouse/stock/route"
import * as teamBranchesRoute from "@/app/api/v1/warehouse-team/[userId]/branches/route"
import * as teamCitiesRoute from "@/app/api/v1/warehouse-team/[userId]/cities/route"
import {
  auditLogs,
  branchDeliveryAddresses,
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

import { stageDeliveryChallan } from "./helpers/delivery-challan-fixtures"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Trying to make a warehouse user see or touch what it must not.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md (AC1, AC3, AC4) and
 * plans/OF-WAREHOUSE-city-assignments.md.
 *
 * `warehouse-api.test.ts` walks the happy paths and the role matrix; this
 * suite attacks the edges: orders at the warehouse's own branch that are not
 * its work, ids of one order used under another, a delivery address of another
 * branch, LIKE wildcards, paging past the end, tokens that outlive the account,
 * and reach withdrawn mid-session.
 *
 * ```text
 * Tenant A                                      Tenant B
 *   A1  ← "wh" (one by one)                       B1  ← "wh" (through its city)
 *     W  approved, not started                      Z  approved, out for delivery
 *     W2 approved, sent to A2's address (!)
 *     H  fulfilled + delivered, with a challan    B2  — another city, not served
 *     P  pending           J  rejected              V  approved
 *     K  cancelled while out for delivery
 *     R  refunded after delivery, with a challan
 *   A2  — not served
 *     Y  approved, with a challan; its address carries a marker
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
const bucket = vi.hoisted(() => new Map<string, Buffer>())
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return {
    ...actual,
    isImageStorageConfigured: () => true,
    putImage: vi.fn(async (input: { key: string; body: Buffer }) => { bucket.set(input.key, input.body) }),
    getImage: vi.fn(async (key: string) => {
      const body = bucket.get(key)
      if (!body) return null
      return {
        body: { transformToWebStream: () => new Blob([new Uint8Array(body)]).stream() },
        contentType: "application/pdf",
        contentLength: body.length,
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
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
})

function parseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function read(response: Response) {
  const text = await response.text()
  return { status: response.status, body: parseJson(text), text }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse security tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const fileParams = (id: number | string, challanId: number | string) => ({ params: Promise.resolve({ id: String(id), challanId: String(challanId) }) })

describe.skipIf(!hasTestDatabase)("the Warehouse role, under attack", () => {
  const suffix = randomUUID().slice(0, 8)
  /** Planted in everything the warehouse must never be shown. */
  const SECRET = `${suffix}-SECRET`
  /** Planted on every person: no warehouse response names anyone. */
  const PERSON = `${suffix}-PERSON`
  const servedCity = `Itsec Served ${suffix}`
  const actors: Record<string, Actor> = {}
  const ids = {
    orgA: 0, orgB: 0, branchA1: 0, branchA2: 0, branchB1: 0, branchB2: 0, product: 0, addressA2: 0,
    W: 0, W2: 0, H: 0, P: 0, J: 0, K: 0, R: 0, Y: 0, Z: 0, V: 0,
    challanH: 0, challanHReplaced: 0, challanR: 0, challanY: 0,
  }
  let roleIds: Record<string, number> = {}

  // ---- calling the routes -------------------------------------------------
  const list = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await listRoute.GET(request(`http://localhost/api/v1/warehouse/orders${query}`, "GET")))
  }
  const detail = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await detailRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}`, "GET"), params(orderId)))
  }
  const progress = async (actor: Actor | null, orderId: number | string, body: unknown) => {
    signIn(actor)
    return read(await progressRoute.POST(request(`http://localhost/api/v1/warehouse/orders/${orderId}/progress`, "POST", body), params(orderId)))
  }
  const timeline = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await timelineRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}/timeline`, "GET"), params(orderId)))
  }
  const invoice = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await invoiceRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}/invoice`, "GET"), params(orderId)))
  }
  const challans = async (actor: Actor | null, orderId: number | string) => {
    signIn(actor)
    return read(await challanRoute.GET(request(`http://localhost/api/v1/warehouse/orders/${orderId}/delivery-challan`, "GET"), params(orderId)))
  }
  const addChallan = async (actor: Actor | null, orderId: number | string, body: unknown) => {
    signIn(actor)
    return read(await challanRoute.POST(request(`http://localhost/api/v1/warehouse/orders/${orderId}/delivery-challan`, "POST", body), params(orderId)))
  }
  const challanFile = async (actor: Actor | null, orderId: number | string, challanId: number | string) => {
    signIn(actor)
    return read(await challanFileRoute.GET(
      request(`http://localhost/api/v1/warehouse/orders/${orderId}/delivery-challan/${challanId}/file`, "GET"),
      fileParams(orderId, challanId),
    ))
  }
  const workload = async (actor: Actor | null, query = "") => {
    signIn(actor)
    return read(await workloadRoute.GET(request(`http://localhost/api/v1/warehouse/workload${query}`, "GET")))
  }
  const stock = async (actor: Actor | null) => {
    signIn(actor)
    return read(await stockRoute.GET(request(`http://localhost/api/v1/warehouse/stock?q=${suffix}`, "GET")))
  }
  let png: Buffer
  const upload = async (actor: Actor | null, orderId: number) => {
    signIn(actor)
    const form = new FormData()
    form.append("image", new File([new Uint8Array(png)], "challan.png", { type: "image/png" }))
    form.append("purpose", "delivery-challan")
    form.append("orderId", String(orderId))
    return read(await uploadRoute.POST(new NextRequest("http://localhost/api/v1/upload/image", { method: "POST", body: form })))
  }
  const snapshot = async (orderId: number) => {
    const [row] = await db.select({
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      deliveredAt: orders.deliveredAt,
      updatedAt: orders.updatedAt,
    }).from(orders).where(eq(orders.id, orderId)).limit(1)
    return row
  }
  const attachedChallans = async (orderId: number) => db
    .select({ id: orderDeliveryChallans.id })
    .from(orderDeliveryChallans)
    .where(eq(orderDeliveryChallans.orderId, orderId))

  beforeAll(async () => {
    png = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 250, g: 250, b: 250 } } }).png().toBuffer()
    roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT SEC A ${suffix}`, code: `ITSECA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT SEC B ${suffix}`, code: `ITSECB_${suffix}` }).returning({ id: organizations.id })
    ids.orgA = a.id
    ids.orgB = b.id

    const [a1, a2, b1, b2] = await db.insert(branches).values([
      { organizationId: ids.orgA, name: `IT SEC A1 ${suffix}`, city: `Itsec A1 city ${suffix}`, address: "1 Served Road", status: "active" },
      { organizationId: ids.orgA, name: `IT SEC ${SECRET} A2`, city: `${SECRET} city`, address: `${SECRET} road`, status: "active" },
      { organizationId: ids.orgB, name: `IT SEC B1 ${suffix}`, city: servedCity, status: "active" },
      { organizationId: ids.orgB, name: `IT SEC ${SECRET} B2`, city: `${SECRET} other city`, status: "active" },
    ]).returning({ id: branches.id })
    ids.branchA1 = a1.id
    ids.branchA2 = a2.id
    ids.branchB1 = b1.id
    ids.branchB2 = b2.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-sec-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email,
        username: `it-sec-${label}-${suffix}`,
        passwordHash: "x",
        roleId: roleIds[role],
        organizationId,
        branchId,
        fullName: role === "WAREHOUSE" ? `Warehouse ${label} ${suffix}` : `${label} ${PERSON}`,
        phone: role === "WAREHOUSE" ? null : "+923001234567",
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", ids.orgA, null)
    await person("branchAdmin", "BRANCH_ADMIN", ids.orgA, ids.branchA1)
    await person("raiser", "ORDER_PORTAL", ids.orgA, ids.branchA1)
    await person("orderDesk", "ORDER_DESK", null, null)
    await person("executive", "APRICART_EXECUTIVE", null, null)
    await person("wh", "WAREHOUSE", null, null)
    await person("whTwin", "WAREHOUSE", null, null)
    await person("whDemoted", "WAREHOUSE", null, null)
    await person("whDeleted", "WAREHOUSE", null, null)

    await db.insert(warehouseAssignments).values([
      { userId: actors.wh.id, branchId: ids.branchA1 },
      { userId: actors.whTwin.id, branchId: ids.branchA1 },
      { userId: actors.whDemoted.id, branchId: ids.branchA1 },
      { userId: actors.whDeleted.id, branchId: ids.branchA1 },
    ])
    await db.insert(warehouseCityAssignments).values({ userId: actors.wh.id, cityKey: servedCity.toLowerCase() })

    const [address] = await db.insert(branchDeliveryAddresses).values({
      organizationId: ids.orgA,
      branchId: ids.branchA2,
      label: `${SECRET} warehouse dock`,
      labelKey: `${SECRET} warehouse dock`.toLowerCase(),
      address: `${SECRET} 9 Hidden Street`,
      city: `${SECRET} town`,
      contactPerson: `${SECRET} contact`,
      contactPhone: "+923009999999",
      requestedByUserId: actors.headOffice.id,
    }).returning({ id: branchDeliveryAddresses.id })
    ids.addressA2 = address.id

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITSEC-${suffix}`, name: `IT sec product ${suffix}`, basePrice: 2_000, status: "active", unit: "piece", stockQuantity: 40,
    }).returning({ id: globalProducts.id })
    ids.product = product.id

    const place = async (key: string, values: {
      organizationId: number
      branchId: number
      status: string
      fulfillmentStatus?: string
      statusAtRefund?: string
      deliveryAddressId?: number
      deliveredAt?: Date
      fulfilledAt?: Date
      refundAmountCents?: number
    }) => {
      const [row] = await db.insert(orders).values({
        tid: `SEC${suffix}${key}`.slice(0, 26),
        createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL",
        approvedByUserId: actors.branchAdmin.id,
        approvedAt: new Date(),
        subtotalCents: 2_000,
        taxCents: 0,
        totalCents: 2_000,
        notes: `note ${key}`,
        budgetTracked: false,
        receiptData: { invoiceNumber: `INV-SEC-${key}-${suffix}`, buyerName: `buyer ${PERSON}` } as any,
        ...values,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        orderId: row.id, organizationId: values.organizationId, globalProductId: ids.product,
        productName: "Secure item", productCode: `ITSEC-${suffix}`, unit: "piece", quantity: 1, priceCents: 2_000,
      })
      return row.id
    }
    const now = new Date()
    ids.W = await place("W", { organizationId: ids.orgA, branchId: ids.branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
    ids.W2 = await place("W2", { organizationId: ids.orgA, branchId: ids.branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED", deliveryAddressId: ids.addressA2 })
    ids.H = await place("H", { organizationId: ids.orgA, branchId: ids.branchA1, status: "FULFILLED", fulfillmentStatus: "DELIVERED", deliveredAt: now, fulfilledAt: now })
    ids.P = await place("P", { organizationId: ids.orgA, branchId: ids.branchA1, status: "PENDING", fulfillmentStatus: "NOT_STARTED" })
    ids.J = await place("J", { organizationId: ids.orgA, branchId: ids.branchA1, status: "REJECTED", fulfillmentStatus: "NOT_STARTED" })
    ids.K = await place("K", { organizationId: ids.orgA, branchId: ids.branchA1, status: "CANCELLED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
    ids.R = await place("R", {
      organizationId: ids.orgA, branchId: ids.branchA1, status: "REFUNDED", statusAtRefund: "APPROVED",
      fulfillmentStatus: "DELIVERED", deliveredAt: now, refundAmountCents: 2_000,
    })
    ids.Y = await place("Y", { organizationId: ids.orgA, branchId: ids.branchA2, status: "APPROVED", fulfillmentStatus: "DELIVERED", deliveredAt: now })
    ids.Z = await place("Z", { organizationId: ids.orgB, branchId: ids.branchB1, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
    ids.V = await place("V", { organizationId: ids.orgB, branchId: ids.branchB2, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })

    // Attached challans, as a delivery would leave them; H also has a replaced one.
    const attach = async (orderId: number, replaced = false) => {
      const challanId = await stageDeliveryChallan(orderId, actors.superAdmin.id)
      const [row] = await db.update(orderDeliveryChallans)
        .set({ attachedAt: new Date(Date.now() - (replaced ? 60_000 : 0)), ...(replaced ? { replacedAt: new Date(), replacedByUserId: actors.superAdmin.id } : {}) })
        .where(eq(orderDeliveryChallans.id, challanId))
        .returning({ storageKey: orderDeliveryChallans.storageKey })
      bucket.set(row.storageKey, Buffer.from("%PDF-1.4 test"))
      return challanId
    }
    ids.challanHReplaced = await attach(ids.H, true)
    ids.challanH = await attach(ids.H)
    ids.challanR = await attach(ids.R)
    ids.challanY = await attach(ids.Y)
  })

  afterAll(async () => {
    if (!ids.orgA) return
    const organizationIds = [ids.orgA, ids.orgB]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const orderRows = await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds))
    const orderIds = orderRows.map((row) => row.id)
    if (orderIds.length > 0) {
      await db.delete(orderDeliveryChallans).where(inArray(orderDeliveryChallans.orderId, orderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, actorIds))
    await db.delete(branchDeliveryAddresses).where(inArray(branchDeliveryAddresses.organizationId, organizationIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, ids.product))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  // ---------------------------------------------------------------------------
  describe("who may call each warehouse endpoint", () => {
    const endpoints: Array<[string, (actor: Actor | null) => Promise<{ status: number }>]> = [
      ["the queue", (actor) => list(actor)],
      ["the picking sheet", (actor) => detail(actor, ids.W)],
      ["moving a delivery", (actor) => progress(actor, ids.W, { fulfillmentStatus: "IN_PROCESS" })],
      ["the timeline", (actor) => timeline(actor, ids.W)],
      ["the invoice", (actor) => invoice(actor, ids.W)],
      ["the challan list", (actor) => challans(actor, ids.H)],
      ["adding a challan", (actor) => addChallan(actor, ids.H, { deliveryChallanId: ids.challanH })],
      ["the challan file", (actor) => challanFile(actor, ids.H, ids.challanH)],
      ["the workload", (actor) => workload(actor)],
      ["the stock", (actor) => stock(actor)],
    ]

    it.each(endpoints)("%s refuses a caller with no session", async (_label, call) => {
      expect((await call(null)).status).toBe(401)
    })

    it.each(endpoints)("%s refuses every role but the warehouse, Super Admin included", async (_label, call) => {
      for (const label of ["superAdmin", "headOffice", "branchAdmin", "raiser", "orderDesk", "executive"]) {
        expect((await call(actors[label])).status, label).toBe(403)
      }
      // Nothing moved for any of them.
      expect((await snapshot(ids.W)).fulfillmentStatus).toBe("NOT_STARTED")
    })
  })

  // ---------------------------------------------------------------------------
  describe("an order at its own branch that is not its work (AC1)", () => {
    const notWork = () => [
      ["pending", ids.P],
      ["rejected", ids.J],
      ["cancelled while out for delivery", ids.K],
      ["refunded after delivery", ids.R],
    ] as const

    it("never appears in the queue, in any view", async () => {
      for (const view of ["open", "delivered", "all"]) {
        const { status, body } = await list(actors.wh, `?view=${view}&limit=100`)
        expect(status).toBe(200)
        const listed = body.items.map((item: { id: number }) => item.id)
        for (const [label, orderId] of notWork()) expect(listed, `${label} in ${view}`).not.toContain(orderId)
      }
    })

    it("reads as 404 on every route, exactly like an order at another branch", async () => {
      for (const [label, orderId] of [...notWork(), ["at a branch it does not serve", ids.Y] as const]) {
        expect((await detail(actors.wh, orderId)).status, `${label}: detail`).toBe(404)
        expect((await timeline(actors.wh, orderId)).status, `${label}: timeline`).toBe(404)
        expect((await invoice(actors.wh, orderId)).status, `${label}: invoice`).toBe(404)
        expect((await challans(actors.wh, orderId)).status, `${label}: challans`).toBe(404)
        expect((await upload(actors.wh, orderId)).status, `${label}: upload`).toBe(404)
      }
    })

    it("never streams the challan of a refunded order, or of another branch's", async () => {
      expect((await challanFile(actors.wh, ids.R, ids.challanR)).status).toBe(404)
      expect((await challanFile(actors.wh, ids.Y, ids.challanY)).status).toBe(404)
    })

    it("cannot be moved, and the refusal does not name its status", async () => {
      for (const [label, orderId] of notWork()) {
        const before = await snapshot(orderId)
        const next = label.startsWith("cancelled") ? "DELIVERED" : "IN_PROCESS"
        const refused = await progress(actors.wh, orderId, { fulfillmentStatus: next })
        expect(refused.status, label).toBe(404)
        expect(refused.text, label).not.toMatch(/PENDING|REJECTED|CANCELLED|REFUNDED/)
        expect(await snapshot(orderId), label).toEqual(before)
      }
    })

    it("cannot have a challan added", async () => {
      const staged = await stageDeliveryChallan(ids.R, actors.wh.id)
      // R already has one; set it aside for this attempt so only the status can refuse.
      await db.update(orderDeliveryChallans).set({ replacedAt: new Date(), replacedByUserId: actors.superAdmin.id })
        .where(eq(orderDeliveryChallans.id, ids.challanR))
      try {
        expect((await addChallan(actors.wh, ids.R, { deliveryChallanId: staged })).status).toBe(404)
        const [row] = await db.select({ attachedAt: orderDeliveryChallans.attachedAt }).from(orderDeliveryChallans)
          .where(eq(orderDeliveryChallans.id, staged))
        expect(row.attachedAt).toBeNull()
      } finally {
        // Should the attempt have attached it, drop it before restoring R's own.
        await db.delete(orderDeliveryChallans).where(eq(orderDeliveryChallans.id, staged))
        await db.update(orderDeliveryChallans).set({ replacedAt: null, replacedByUserId: null })
          .where(eq(orderDeliveryChallans.id, ids.challanR))
      }
    })

    it("still shows delivered history — the fence is the status, not the branch", async () => {
      expect((await detail(actors.wh, ids.H)).status).toBe(200)
      expect((await invoice(actors.wh, ids.H)).status).toBe(200)
      expect((await challans(actors.wh, ids.H)).status).toBe(200)
      expect((await challanFile(actors.wh, ids.H, ids.challanH)).status).toBe(200)
      const { body } = await list(actors.wh, "?view=delivered")
      expect(body.items.map((item: { id: number }) => item.id)).toContain(ids.H)
    })
  })

  // ---------------------------------------------------------------------------
  describe("ids of one thing used under another", () => {
    it("never serves a challan under an order it does not belong to", async () => {
      // H is in reach; Y's and R's challans are not H's.
      expect((await challanFile(actors.wh, ids.H, ids.challanY)).status).toBe(404)
      expect((await challanFile(actors.wh, ids.H, ids.challanR)).status).toBe(404)
      expect((await challanFile(actors.wh, ids.W, ids.challanH)).status).toBe(404)
    })

    it("never serves or lists a replaced challan", async () => {
      expect((await challanFile(actors.wh, ids.H, ids.challanHReplaced)).status).toBe(404)
      const listed = await challans(actors.wh, ids.H)
      expect(listed.body.items.map((item: { id: number }) => item.id)).toEqual([ids.challanH])
    })

    it("refuses at delivery a challan someone else uploaded, or one uploaded for another order", async () => {
      const bySuperAdmin = await stageDeliveryChallan(ids.Z, actors.superAdmin.id)
      const byTwin = await stageDeliveryChallan(ids.Z, actors.whTwin.id)
      const forAnotherOrder = await stageDeliveryChallan(ids.W, actors.wh.id)
      const before = await snapshot(ids.Z)
      for (const challanId of [bySuperAdmin, byTwin, forAnotherOrder, 2_147_483_647]) {
        const refused = await progress(actors.wh, ids.Z, { fulfillmentStatus: "DELIVERED", deliveryChallanId: challanId })
        expect(refused.status, String(challanId)).toBe(400)
        // The delivery rolled back with the challan.
        expect(await snapshot(ids.Z)).toEqual(before)
      }
      const used = await db.select({ id: orderDeliveryChallans.id }).from(orderDeliveryChallans)
        .where(inArray(orderDeliveryChallans.id, [bySuperAdmin, byTwin, forAnotherOrder]))
      expect(used).toHaveLength(3)
      const attached = await db.select({ attachedAt: orderDeliveryChallans.attachedAt }).from(orderDeliveryChallans)
        .where(inArray(orderDeliveryChallans.id, [bySuperAdmin, byTwin, forAnotherOrder]))
      expect(attached.every((row) => row.attachedAt === null)).toBe(true)
    })

    it("a body cannot name a different order, a status or a stage it may not set", async () => {
      const before = await snapshot(ids.W)
      for (const body of [
        { fulfillmentStatus: "IN_PROCESS", orderId: ids.Y },
        { fulfillmentStatus: "IN_PROCESS", status: "FULFILLED" },
        { fulfillmentStatus: "IN_PROCESS", organizationId: ids.orgB, branchId: ids.branchB2 },
        { fulfillmentStatus: "FULFILLED" },
        { fulfillmentStatus: "NOT_STARTED" },
        { fulfillmentStatus: "in_process; DROP TABLE orders" },
        [{ fulfillmentStatus: "IN_PROCESS" }],
        "not json",
        null,
      ]) {
        const refused = await progress(actors.wh, ids.W, body)
        expect(refused.status, JSON.stringify(body)).toBe(400)
      }
      expect(await snapshot(ids.W)).toEqual(before)
    })

    it.each(["0", "-1", "1.5", "1e3", "abc", "9007199254740993"])("treats the order id %j as not found, on every route", async (raw) => {
      expect((await detail(actors.wh, raw)).status).toBe(404)
      expect((await invoice(actors.wh, raw)).status).toBe(404)
      expect((await timeline(actors.wh, raw)).status).toBe(404)
      expect((await challans(actors.wh, raw)).status).toBe(404)
      expect((await progress(actors.wh, raw, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
      expect((await challanFile(actors.wh, ids.H, raw)).status).toBe(404)
    })
  })

  // ---------------------------------------------------------------------------
  describe("what the responses carry", () => {
    it("shows the branch's own address when an order points at another branch's delivery address", async () => {
      // Nothing in the database ties an order's delivery address to its branch;
      // the read must, or a mis-set id reveals another branch's address.
      const sheet = await detail(actors.wh, ids.W2)
      expect(sheet.status).toBe(200)
      expect(sheet.text).not.toContain(SECRET)
      expect(sheet.body.destination).toMatchObject({ isBranchAddress: true, address: "1 Served Road", contactPhone: null })

      const queue = await list(actors.wh, "?lines=1&limit=100")
      expect(queue.text).not.toContain(SECRET)
    })

    it("names no person behind an order it can see", async () => {
      for (const response of [await detail(actors.wh, ids.W), await list(actors.wh, "?view=all&lines=1&limit=100"), await challans(actors.wh, ids.H)]) {
        expect(response.text).not.toContain(PERSON)
        expect(response.text).not.toContain(actors.raiser.email)
        expect(response.text).not.toContain(actors.branchAdmin.id)
        expect(response.text).not.toContain("+923001234567")
      }
    })

    it("never caches a response in a shared cache", async () => {
      for (const response of [
        await listRoute.GET((signIn(actors.wh), request("http://localhost/api/v1/warehouse/orders", "GET"))),
        await detailRoute.GET((signIn(actors.wh), request(`http://localhost/api/v1/warehouse/orders/${ids.W}`, "GET")), params(ids.W)),
        await invoiceRoute.GET((signIn(actors.wh), request(`http://localhost/api/v1/warehouse/orders/${ids.H}/invoice`, "GET")), params(ids.H)),
      ]) {
        expect(response.headers.get("Cache-Control")).toMatch(/private/)
        expect(response.headers.get("Cache-Control")).toMatch(/no-store/)
      }
    })
  })

  // ---------------------------------------------------------------------------
  describe("filters, search and paging only ever narrow", () => {
    it("offers and counts only the branches it serves, one by one or through a city", async () => {
      const { body } = await list(actors.wh, "?view=all&limit=100")
      expect(body.reach.branches.map((branch: { id: number }) => branch.id).sort()).toEqual([ids.branchA1, ids.branchB1].sort())
      expect(body.reach.organizations.map((organization: { id: number }) => organization.id).sort()).toEqual([ids.orgA, ids.orgB].sort())
      const listed = body.items.map((item: { id: number }) => item.id)
      expect(listed).toEqual(expect.arrayContaining([ids.W, ids.W2, ids.H, ids.Z]))
      expect(listed).not.toContain(ids.V)
      // W and W2 are the only open, not-started orders it serves.
      expect(body.counts.NOT_STARTED).toBe(2)
      expect(body.counts.OUT_FOR_DELIVERY).toBe(1)
      expect(JSON.stringify(body)).not.toContain(SECRET)
    })

    it("returns nothing for a filter naming another branch or organization, never that branch's orders", async () => {
      for (const query of [`?view=all&branchId=${ids.branchB2}`, `?view=all&branchId=${ids.branchA2}`, `?view=all&organizationId=${ids.orgB}&branchId=${ids.branchA1}`]) {
        const { status, body } = await list(actors.wh, query)
        expect(status).toBe(200)
        expect(body.items).toEqual([])
        expect(body.total).toBe(0)
        expect(body.counts).toEqual({ NOT_STARTED: 0, IN_PROCESS: 0, OUT_FOR_DELIVERY: 0, DELIVERED_RECENT: 0 })
      }
    })

    it("treats LIKE wildcards in a search literally", async () => {
      for (const q of ["%", "_", "%%", "\\", "%SEC%"]) {
        const { status, body } = await list(actors.wh, `?view=all&q=${encodeURIComponent(q)}`)
        expect(status, q).toBe(200)
        expect(body.items, q).toEqual([])
      }
      const exact = await list(actors.wh, `?view=all&q=${encodeURIComponent(`SEC${suffix}W2`)}`)
      expect(exact.body.items.map((item: { id: number }) => item.id)).toEqual([ids.W2])
    })

    it("does not find another branch's order by its number, invoice or branch name", async () => {
      for (const q of [`SEC${suffix}Y`, `INV-SEC-V-${suffix}`, SECRET]) {
        const { body } = await list(actors.wh, `?view=all&q=${encodeURIComponent(q)}`)
        expect(body.items, q).toEqual([])
      }
    })

    it("pages within its own orders only, and a page past the end is empty", async () => {
      const first = await list(actors.wh, "?view=all&limit=1&page=1")
      expect(first.body.items).toHaveLength(1)
      const total = first.body.total
      expect(total).toBe(4)
      const seen = new Set<number>()
      for (let page = 1; page <= total; page += 1) {
        const { body } = await list(actors.wh, `?view=all&limit=1&page=${page}`)
        seen.add(body.items[0].id)
      }
      expect([...seen].sort()).toEqual([ids.W, ids.W2, ids.H, ids.Z].sort())
      const past = await list(actors.wh, "?view=all&limit=1&page=9999")
      expect(past.body.items).toEqual([])
      expect(past.body.total).toBe(total)
      const huge = await list(actors.wh, "?view=all&limit=1000000")
      expect(huge.body.limit).toBe(100)
    })

    it("fences the workload and its filter options the same way", async () => {
      const { body } = await workload(actors.wh, `?organizationId=${ids.orgB}`)
      const shown = body.orders.items.map((item: { id: number }) => item.id)
      expect(shown).toContain(ids.Z)
      expect(shown).not.toContain(ids.V)
      expect(body.options.branches.map((branch: { id: number }) => branch.id)).toEqual([ids.branchB1])
      expect(JSON.stringify(body)).not.toContain(SECRET)
    })
  })

  // ---------------------------------------------------------------------------
  describe("a token that outlives the account behind it", () => {
    it("reaches nothing once the account was moved to another role, though the token still says Warehouse", async () => {
      await db.update(users).set({ roleId: roleIds.BRANCH_ADMIN }).where(eq(users.id, actors.whDemoted.id))
      const before = await snapshot(ids.W)
      expect((await list(actors.whDemoted, "?view=all")).body.items).toEqual([])
      expect((await detail(actors.whDemoted, ids.W)).status).toBe(404)
      expect((await invoice(actors.whDemoted, ids.H)).status).toBe(404)
      expect((await challanFile(actors.whDemoted, ids.H, ids.challanH)).status).toBe(404)
      expect((await timeline(actors.whDemoted, ids.W)).status).toBe(404)
      expect((await workload(actors.whDemoted)).body.orders.items).toEqual([])
      expect((await progress(actors.whDemoted, ids.W, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
      expect(await snapshot(ids.W)).toEqual(before)
    })

    it("reaches nothing once the account was deleted", async () => {
      await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, actors.whDeleted.id))
      expect((await list(actors.whDeleted, "?view=all")).body.items).toEqual([])
      expect((await detail(actors.whDeleted, ids.W)).status).toBe(404)
      expect((await upload(actors.whDeleted, ids.Z)).status).toBe(404)
      expect((await progress(actors.whDeleted, ids.W, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
    })
  })

  // ---------------------------------------------------------------------------
  describe("reach withdrawn while the user is signed in", () => {
    it("closes every route at once when Super Admin withdraws the branch and the city", async () => {
      // Sanity: in reach before.
      expect((await detail(actors.whTwin, ids.W)).status).toBe(200)

      signIn(actors.superAdmin)
      const withdrawn = await teamBranchesRoute.PUT(
        request(`http://localhost/api/v1/warehouse-team/${actors.whTwin.id}/branches`, "PUT", { organizationId: ids.orgA, branchIds: [] }),
        { params: Promise.resolve({ userId: actors.whTwin.id }) },
      )
      expect(withdrawn.status).toBe(200)

      const before = await snapshot(ids.W)
      expect((await detail(actors.whTwin, ids.W)).status).toBe(404)
      expect((await invoice(actors.whTwin, ids.H)).status).toBe(404)
      expect((await challans(actors.whTwin, ids.H)).status).toBe(404)
      expect((await challanFile(actors.whTwin, ids.H, ids.challanH)).status).toBe(404)
      expect((await timeline(actors.whTwin, ids.W)).status).toBe(404)
      expect((await progress(actors.whTwin, ids.W, { fulfillmentStatus: "IN_PROCESS" })).status).toBe(404)
      expect(await snapshot(ids.W)).toEqual(before)

      // The same for a city: wh loses Z when its city is withdrawn.
      expect((await detail(actors.wh, ids.Z)).status).toBe(200)
      signIn(actors.superAdmin)
      const cityWithdrawn = await teamCitiesRoute.PUT(
        request(`http://localhost/api/v1/warehouse-team/${actors.wh.id}/cities`, "PUT", { city: servedCity, assigned: false }),
        { params: Promise.resolve({ userId: actors.wh.id }) },
      )
      expect(cityWithdrawn.status).toBe(200)
      expect((await detail(actors.wh, ids.Z)).status).toBe(404)
      expect((await upload(actors.wh, ids.Z)).status).toBe(404)
      // Only the two staged on Z earlier in this suite; the refused upload stored nothing.
      expect(await attachedChallans(ids.Z)).toHaveLength(2)
    })
  })
})
