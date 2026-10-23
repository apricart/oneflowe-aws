import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { eq, inArray } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as intakeScreenshotRoute from "@/app/api/v1/orders/[id]/intake-screenshot/route"
import * as executiveApproveRoute from "@/app/api/v1/executive/approvals/[id]/approve/route"
import * as warehouseOrderRoute from "@/app/api/v1/warehouse/orders/[id]/route"
import * as warehouseIntakeScreenshotRoute from "@/app/api/v1/warehouse/orders/[id]/intake-screenshot/route"
import { orders, roles, users, warehouseAssignments } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { getImage } from "@/lib/server/image-storage"

import {
  createOrderDeskFixtures,
  destroyOrderDeskFixtures,
  hasTestDatabase,
  ORDER_DESK_FIXTURE_PRICE_CENTS,
  stageIntakeAttachment,
  type OrderDeskFixtures,
} from "./helpers/order-desk-fixtures"

/**
 * The customer's screenshot on an Order Desk order, shown to everyone who can
 * read the order: the order readers through `GET /api/v1/orders/{id}/intake-screenshot`
 * (the order detail's own rule, `canReadOrderDetail`) and the warehouse
 * through its own route (its branch reach, approved work only). Real routes
 * against Postgres; only identity, request headers, the rate limiter, the
 * cache, outbound email and the S3 read are faked.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: vi.fn(async () => {}),
  sendRefundRequestEmail: vi.fn(async () => true),
}))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})
vi.mock("@/lib/server/order-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/order-notifications")>()
  return { ...actual, attemptImmediateOrderEmailDelivery: vi.fn(async () => undefined) }
})
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return { ...actual, putImage: vi.fn(async () => undefined), getImage: vi.fn() }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

const jsonRequest = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const get = (url: string) => new NextRequest(url)
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

let keyCounter = 0
const idempotencyKey = () => `itis-${Date.now().toString(36)}-${(keyCounter += 1)}`

async function read(response: Response) {
  const text = await response.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body, text, headers: response.headers }
}

async function resolveRoleId(name: string): Promise<number> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (row) return row.id
  const [created] = await db.insert(roles).values({ name, description: "Created by intake screenshot integration tests" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("the customer's screenshot on an Order Desk order", () => {
  let f: OrderDeskFixtures
  const local: Record<"branchAdminA1" | "branchAdminA2" | "branchAdminB1" | "warehouseA1" | "warehouseB1", Actor> = {} as any

  const fixtureActor = (kind: "super" | "head" | "desk" | "portal" | "viewer" | "executive"): Actor => ({
    super: { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null },
    head: { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationA, branchId: null },
    desk: { id: f.deskId, role: "ORDER_DESK", organizationId: null, branchId: null },
    portal: { id: f.portalId, role: "ORDER_PORTAL", organizationId: f.organizationA, branchId: f.branchA1 },
    viewer: { id: f.viewerId, role: "VIEWER", organizationId: f.organizationA, branchId: f.branchA1 },
    executive: { id: f.executiveId, role: "APRICART_EXECUTIVE", organizationId: null, branchId: null },
  })[kind]

  const signIn = (actor: Actor | null) => {
    vi.mocked(getServerSession).mockResolvedValue(
      actor === null
        ? null
        : ({ user: { ...actor, email: `${actor.id}@example.test`, fullName: actor.role, mustChangePassword: false } } as any),
    )
  }

  const createOrder = async (body: unknown) =>
    read(await ordersRoute.POST(jsonRequest("http://localhost/api/v1/orders", "POST", body, { "Idempotency-Key": idempotencyKey() })))

  /** A desk order at A1 (or B1 with `atB`), still pending. */
  const deskOrder = async (options: { atB?: boolean } = {}) => {
    signIn(fixtureActor("desk"))
    const created = await createOrder({
      organizationId: options.atB ? f.organizationB : f.organizationA,
      branchId: options.atB ? f.branchB1 : f.branchA1,
      items: [{
        globalProductId: f.productId,
        quantity: 1,
        unitPriceCents: options.atB ? ORDER_DESK_FIXTURE_PRICE_CENTS.base : ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA,
      }],
      intakeChannel: "WHATSAPP",
      intakeReference: `Intake screenshot ${f.suffix}`,
      intakeAttachmentKey: await stageIntakeAttachment(f.deskId),
    })
    expect(created.status, "desk order").toBe(200)
    return created.body.order.id as number
  }

  /** Approved by the Apricart Executive, so it is warehouse work. */
  const approveDeskOrder = async (orderId: number) => {
    const [row] = await db.select({ updatedAt: orders.updatedAt }).from(orders).where(eq(orders.id, orderId))
    signIn(fixtureActor("executive"))
    const approved = await read(await executiveApproveRoute.POST(
      jsonRequest(`http://localhost/api/v1/executive/approvals/${orderId}/approve`, "POST", {
        expectedUpdatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      }),
      params(orderId),
    ))
    expect(approved.status, "executive approval").toBe(200)
  }

  const storedKey = async (orderId: number) =>
    (await db.select({ key: orders.intakeAttachmentKey }).from(orders).where(eq(orders.id, orderId)))[0].key

  const screenshot = async (orderId: number | string) => read(await intakeScreenshotRoute.GET(
    get(`http://localhost/api/v1/orders/${orderId}/intake-screenshot`),
    params(orderId),
  ))
  const warehouseScreenshot = async (orderId: number | string) => read(await warehouseIntakeScreenshotRoute.GET(
    get(`http://localhost/api/v1/warehouse/orders/${orderId}/intake-screenshot`),
    params(orderId),
  ))

  beforeAll(async () => {
    process.env.S3_UPLOADS_BUCKET = "it-intake-screenshot"
    process.env.S3_UPLOADS_REGION = "ap-south-1"
    f = await createOrderDeskFixtures()

    const person = async (label: keyof typeof local, role: string, organizationId: number | null, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `itis-${label}-${f.suffix}@example.test`,
        username: `itis-${label}-${f.suffix}`,
        passwordHash: "x",
        roleId: await resolveRoleId(role),
        organizationId,
        branchId,
        fullName: `${label} ${f.suffix}`,
        isActive: true,
      }).returning({ id: users.id })
      local[label] = { id: row.id, role, organizationId, branchId }
    }
    await person("branchAdminA1", "BRANCH_ADMIN", f.organizationA, f.branchA1)
    await person("branchAdminA2", "BRANCH_ADMIN", f.organizationA, f.branchA2)
    await person("branchAdminB1", "BRANCH_ADMIN", f.organizationB, f.branchB1)
    await person("warehouseA1", "WAREHOUSE", null, null)
    await person("warehouseB1", "WAREHOUSE", null, null)
    await db.insert(warehouseAssignments).values([
      { userId: local.warehouseA1.id, branchId: f.branchA1, createdByUserId: f.superAdminId },
      { userId: local.warehouseB1.id, branchId: f.branchB1, createdByUserId: f.superAdminId },
    ])
  })

  afterAll(async () => {
    delete process.env.S3_UPLOADS_BUCKET
    delete process.env.S3_UPLOADS_REGION
    if (f) {
      const localIds = Object.values(local).map((actor) => actor.id)
      if (localIds.length > 0) await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, localIds))
      await destroyOrderDeskFixtures(f, localIds)
    }
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    vi.mocked(getImage).mockResolvedValue({
      body: { transformToWebStream: () => new Response(new Uint8Array([1, 2, 3])).body } as any,
      contentType: "image/png",
      contentLength: 3,
    })
  })

  afterEach(() => {
    vi.mocked(getImage).mockReset()
  })

  describe("the order readers' route", () => {
    it("refuses a caller with no session, and the roles that read no order detail", async () => {
      const orderId = await deskOrder()
      signIn(null)
      expect((await screenshot(orderId)).status).toBe(401)
      // The desk and the executive have their own routes; the warehouse too.
      for (const actor of [fixtureActor("desk"), fixtureActor("executive"), local.warehouseA1]) {
        signIn(actor)
        expect((await screenshot(orderId)).status, actor.role).toBe(403)
      }
      // A Viewer pinned to a branch reads no order detail at all.
      signIn(fixtureActor("viewer"))
      expect((await screenshot(orderId)).status).toBe(403)
      expect(vi.mocked(getImage)).not.toHaveBeenCalled()
    })

    it("serves the screenshot to Super Admin, the tenant's Head Office and the branch's Financial Approver, never cached", async () => {
      const orderId = await deskOrder()
      const key = await storedKey(orderId)
      for (const actor of [fixtureActor("super"), fixtureActor("head"), local.branchAdminA1]) {
        signIn(actor)
        const shown = await screenshot(orderId)
        expect(shown.status, actor.role).toBe(200)
        expect(shown.headers.get("content-type")).toBe("image/png")
        expect(shown.headers.get("cache-control")).toContain("no-store")
        expect(shown.headers.get("x-content-type-options")).toBe("nosniff")
        expect(shown.headers.get("content-security-policy")).toContain("sandbox")
      }
      expect(vi.mocked(getImage)).toHaveBeenCalledWith(key)
    })

    it("answers 404 outside the reader's branch or tenant, and to an Order Portal user who did not raise it", async () => {
      const atA1 = await deskOrder()
      const atB1 = await deskOrder({ atB: true })

      signIn(local.branchAdminA2)
      expect((await screenshot(atA1)).status).toBe(404)
      signIn(local.branchAdminB1)
      expect((await screenshot(atA1)).status).toBe(404)
      signIn(fixtureActor("head"))
      expect((await screenshot(atB1)).status).toBe(404)
      // The order page reads an Order Portal user only its own orders.
      signIn(fixtureActor("portal"))
      expect((await screenshot(atA1)).status).toBe(404)
      expect(vi.mocked(getImage)).not.toHaveBeenCalled()
    })

    it("answers 404 for an order the desk did not enter, a desk order with no screenshot, and a malformed id", async () => {
      signIn(fixtureActor("portal"))
      const portalOrder = await createOrder({ items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
      expect(portalOrder.status).toBe(200)
      const withoutScreenshot = await deskOrder()
      await db.update(orders).set({ intakeAttachmentKey: null }).where(eq(orders.id, withoutScreenshot))

      signIn(fixtureActor("head"))
      expect((await screenshot(portalOrder.body.order.id)).status).toBe(404)
      expect((await screenshot(withoutScreenshot)).status).toBe(404)
      expect((await screenshot("abc")).status).toBe(404)
      expect((await screenshot(0)).status).toBe(404)
      expect(vi.mocked(getImage)).not.toHaveBeenCalled()
    })

    it("flags the screenshot on the order list and detail without ever sending its key", async () => {
      const deskId = await deskOrder()
      signIn(fixtureActor("portal"))
      const portalOrder = await createOrder({ items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
      const portalId = portalOrder.body.order.id as number

      signIn(fixtureActor("head"))
      const detail = await read(await orderRoute.GET(get(`http://localhost/api/v1/orders/${deskId}`), params(deskId)))
      expect(detail.status).toBe(200)
      expect(detail.body.item.hasIntakeScreenshot).toBe(true)
      expect(detail.text).not.toContain("order-intake/")
      expect(detail.body.item).not.toHaveProperty("intakeAttachmentKey")

      const portalDetail = await read(await orderRoute.GET(get(`http://localhost/api/v1/orders/${portalId}`), params(portalId)))
      expect(portalDetail.body.item.hasIntakeScreenshot).toBe(false)

      const listed = await read(await ordersRoute.GET(get("http://localhost/api/v1/orders?limit=100")))
      expect(listed.status).toBe(200)
      expect(listed.text).not.toContain("order-intake/")
      const rows = listed.body.items as Array<{ id: number; hasIntakeScreenshot: boolean }>
      expect(rows.find((row) => row.id === deskId)?.hasIntakeScreenshot).toBe(true)
      expect(rows.find((row) => row.id === portalId)?.hasIntakeScreenshot).toBe(false)
    })
  })

  describe("the warehouse's route", () => {
    it("refuses every other role", async () => {
      const orderId = await deskOrder()
      await approveDeskOrder(orderId)
      signIn(null)
      expect((await warehouseScreenshot(orderId)).status).toBe(401)
      for (const actor of [fixtureActor("super"), fixtureActor("head"), fixtureActor("desk")]) {
        signIn(actor)
        expect((await warehouseScreenshot(orderId)).status, actor.role).toBe(403)
      }
    })

    it("serves an approved desk order at its branches, and shows it on the picking sheet", async () => {
      const orderId = await deskOrder()
      const key = await storedKey(orderId)

      // Pending is not warehouse work yet: the same 404 as out of reach.
      signIn(local.warehouseA1)
      expect((await warehouseScreenshot(orderId)).status).toBe(404)

      await approveDeskOrder(orderId)
      signIn(local.warehouseA1)
      const shown = await warehouseScreenshot(orderId)
      expect(shown.status).toBe(200)
      expect(shown.headers.get("cache-control")).toContain("no-store")
      expect(vi.mocked(getImage)).toHaveBeenCalledWith(key)

      const sheet = await read(await warehouseOrderRoute.GET(get(`http://localhost/api/v1/warehouse/orders/${orderId}`), params(orderId)))
      expect(sheet.status).toBe(200)
      expect(sheet.body.order.hasIntakeScreenshot).toBe(true)
      expect(sheet.text).not.toContain("order-intake/")
    })

    it("answers 404 to a warehouse that does not serve the branch", async () => {
      const orderId = await deskOrder()
      await approveDeskOrder(orderId)
      vi.mocked(getImage).mockClear()
      signIn(local.warehouseB1)
      expect((await warehouseScreenshot(orderId)).status).toBe(404)
      expect((await warehouseScreenshot("abc")).status).toBe(404)
      expect(vi.mocked(getImage)).not.toHaveBeenCalled()
    })
  })
})
