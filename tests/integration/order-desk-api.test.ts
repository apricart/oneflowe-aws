import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import sharp from "sharp"
import { and, count, desc, eq, sql } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as targetsRoute from "@/app/api/v1/order-desk/targets/route"
import * as catalogueRoute from "@/app/api/v1/order-desk/catalogue/route"
import * as deskOrdersRoute from "@/app/api/v1/order-desk/orders/route"
import * as deskOrderRoute from "@/app/api/v1/order-desk/orders/[id]/route"
import * as fulfilRoute from "@/app/api/v1/order-desk/orders/[id]/fulfil/route"
import * as cancelRoute from "@/app/api/v1/order-desk/orders/[id]/cancel/route"
import * as attachmentRoute from "@/app/api/v1/order-desk/orders/[id]/attachment/route"
import * as teamRoute from "@/app/api/v1/order-desk/team/route"
import * as assignmentsRoute from "@/app/api/v1/order-desk/team/[userId]/assignments/route"
import * as progressRoute from "@/app/api/v1/orders/[id]/fulfillment-status/route"
import * as refundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as uploadRoute from "@/app/api/v1/upload/image/route"
import * as publicImageRoute from "@/app/api/v1/images/[...key]/route"
import * as usersRoute from "@/app/api/v1/users/route"
import * as userAccessRoute from "@/app/api/v1/users/[id]/access/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as executiveApproveRoute from "@/app/api/v1/executive/approvals/[id]/approve/route"
import {
  auditLogs,
  branches,
  budgets,
  globalProducts,
  notifications,
  orderDeskAssignments,
  orderItems,
  orders,
  organizations,
  refunds,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { getImage, putImage } from "@/lib/server/image-storage"

import {
  createOrderDeskFixtures,
  destroyOrderDeskFixtures,
  hasTestDatabase,
  ORDER_DESK_FIXTURE_PRICE_CENTS,
  type OrderDeskFixtures,
} from "./helpers/order-desk-fixtures"
import { stageDeliveryChallan } from "./helpers/delivery-challan-fixtures"

/**
 * Apricart's Order Desk end to end: the real routes against Postgres, with
 * only identity, request headers, the rate limiter, the cache, password
 * hashing, outbound email and the S3 calls faked. Every authorization, reach,
 * ledger and audit decision runs for real.
 *
 * Every desk order now starts PENDING and an Apricart Executive approves it
 * (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md); a test that
 * needs an Active order gets one through `createActiveOrder`, which has the
 * executive approve it through the real route. The executive's own behaviour
 * is in executive-desk-approval-api.test.ts.
 * See plans/OF-ORDER-DESK-internal-order-entry.md.
 */
const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "integration-test-password-hash"),
  sendWelcomeEmail: vi.fn(async () => {}),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/email", () => ({
  sendWelcomeEmail: mocks.sendWelcomeEmail,
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
// Key generation and validation stay real; only the S3 calls are replaced.
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return { ...actual, putImage: vi.fn(async () => undefined), getImage: vi.fn() }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

let signedIn: Actor | null = null

function signIn(actor: Actor | null) {
  signedIn = actor
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, fullName: actor.email, mustChangePassword: false } } as any),
  )
}

const jsonRequest = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const get = (url: string) => new NextRequest(url)
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

let keyCounter = 0
const idempotencyKey = () => `itd-${Date.now().toString(36)}-${(keyCounter += 1)}`

function parseBody(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function read(response: Response) {
  const text = await response.text()
  return { status: response.status, body: parseBody(text), headers: response.headers }
}

describe.skipIf(!hasTestDatabase)("the Order Desk through its real API and database", () => {
  let f: OrderDeskFixtures
  let pngBytes: Buffer
  const createdUserIds: string[] = []

  const actor = (kind: "super" | "head" | "desk" | "desk2" | "deskOff" | "viewer" | "portal" | "executive"): Actor => {
    const table = {
      super: { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null },
      head: { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationA, branchId: null },
      desk: { id: f.deskId, role: "ORDER_DESK", organizationId: null, branchId: null },
      desk2: { id: f.desk2Id, role: "ORDER_DESK", organizationId: null, branchId: null },
      deskOff: { id: f.deskOffId, role: "ORDER_DESK", organizationId: null, branchId: null },
      viewer: { id: f.viewerId, role: "VIEWER", organizationId: f.organizationA, branchId: f.branchA1 },
      portal: { id: f.portalId, role: "ORDER_PORTAL", organizationId: f.organizationA, branchId: f.branchA1 },
      executive: { id: f.executiveId, role: "APRICART_EXECUTIVE", organizationId: null, branchId: null },
    } as const
    return { ...table[kind], email: `${kind}-${f.suffix}@example.test` }
  }

  const deskOrderBody = (overrides: Record<string, unknown> = {}) => ({
    organizationId: f.organizationA,
    branchId: f.branchA1,
    items: [{ organizationInventoryId: f.inventoryA, quantity: 2 }],
    intakeChannel: "WHATSAPP",
    intakeReference: "Ali, 05 Oct 10:14",
    ...overrides,
  })
  const bOrderBody = (quantity: number, overrides: Record<string, unknown> = {}) => deskOrderBody({
    organizationId: f.organizationB,
    branchId: f.branchB1,
    items: [{ organizationInventoryId: f.inventoryB, quantity }],
    ...overrides,
  })

  const createOrder = async (body: unknown, key = idempotencyKey()) =>
    read(await ordersRoute.POST(jsonRequest("http://localhost/api/v1/orders", "POST", body, { "Idempotency-Key": key })))

  /** An executive assigned to the order's organization approves it, then the caller is signed back in. */
  const approveAsExecutive = async (orderId: number) => {
    const caller = signedIn
    const [row] = await db.select({ updatedAt: orders.updatedAt }).from(orders).where(eq(orders.id, orderId))
    signIn(actor("executive"))
    const approved = await read(await executiveApproveRoute.POST(
      jsonRequest(`http://localhost/api/v1/executive/approvals/${orderId}/approve`, "POST", {
        expectedUpdatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      }),
      params(orderId),
    ))
    expect(approved.status, "executive approval").toBe(200)
    signIn(caller)
  }

  /** A desk order taken through its executive approval: Active, ready for delivery. */
  const createActiveOrder = async (body: unknown, key = idempotencyKey()) => {
    const created = await createOrder(body, key)
    expect(created.status, "desk order created").toBe(200)
    await approveAsExecutive(created.body.order.id)
    return created
  }

  const targets = async () => read(await targetsRoute.GET())
  const catalogue = async (organizationId: number, branchId: number) => read(await catalogueRoute.GET(
    get(`http://localhost/api/v1/order-desk/catalogue?organizationId=${organizationId}&branchId=${branchId}`),
  ))
  const listDeskOrders = async (query = "status=all") => read(await deskOrdersRoute.GET(
    get(`http://localhost/api/v1/order-desk/orders?${query}`),
  ))
  const fulfil = async (orderId: number) => read(await fulfilRoute.POST(
    new Request(`http://localhost/api/v1/order-desk/orders/${orderId}/fulfil`, { method: "POST" }),
    params(orderId),
  ))
  const cancel = async (orderId: number, body: unknown = { reason: "Customer withdrew it" }) => read(await cancelRoute.POST(
    jsonRequest(`http://localhost/api/v1/order-desk/orders/${orderId}/cancel`, "POST", body),
    params(orderId),
  ))
  const editOrder = async (orderId: number, body: unknown) => read(await deskOrderRoute.PUT(
    jsonRequest(`http://localhost/api/v1/order-desk/orders/${orderId}`, "PUT", body),
    params(orderId),
  ))
  const attachment = async (orderId: number) => read(await attachmentRoute.GET(
    get(`http://localhost/api/v1/order-desk/orders/${orderId}/attachment`),
    params(orderId),
  ))
  const requestRefund = async (orderId: number, body: unknown) => read(await refundsRoute.POST(
    jsonRequest(`http://localhost/api/v1/orders/${orderId}/refunds`, "POST", body),
    params(orderId),
  ))
  const refundHistory = async (orderId: number) => read(await refundsRoute.GET(
    get(`http://localhost/api/v1/orders/${orderId}/refunds`),
    params(orderId),
  ))
  const upload = async () => {
    const form = new FormData()
    form.append("image", new File([new Uint8Array(pngBytes)], "whatsapp.png", { type: "image/png" }))
    return read(await uploadRoute.POST(new NextRequest("http://localhost/api/v1/upload/image", { method: "POST", body: form })))
  }
  /** Super Admin records delivery through its own progress route, one step at a time. */
  const superDeliver = async (orderId: number) => {
    signIn(actor("super"))
    for (const fulfillmentStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      const deliveryChallanId = fulfillmentStatus === "DELIVERED"
        ? await stageDeliveryChallan(orderId, actor("super").id)
        : undefined
      const result = await read(await progressRoute.POST(
        jsonRequest(`http://localhost/api/v1/orders/${orderId}/fulfillment-status`, "POST", { fulfillmentStatus, deliveryChallanId }),
        params(orderId),
      ))
      expect(result.status, fulfillmentStatus).toBe(200)
    }
  }
  const putAssignments = async (userId: string, body: unknown) => read(await assignmentsRoute.PUT(
    jsonRequest(`http://localhost/api/v1/order-desk/team/${userId}/assignments`, "PUT", body),
    { params: Promise.resolve({ userId }) },
  ))
  const patchAccess = async (userId: string, body: unknown) => read(await userAccessRoute.PATCH(
    jsonRequest(`http://localhost/api/v1/users/${userId}/access`, "PATCH", body),
    { params: Promise.resolve({ id: userId }) },
  ))
  const patchOrganization = async (organizationId: number, body: unknown) => read(await organizationRoute.PATCH(
    jsonRequest(`http://localhost/api/v1/organizations/${organizationId}`, "PATCH", body),
    params(organizationId),
  ))

  const storedOrder = async (orderId: number) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId))
    return row
  }
  const stock = async () => {
    const [row] = await db.select({ stock: globalProducts.stockQuantity }).from(globalProducts).where(eq(globalProducts.id, f.productId))
    return Number(row.stock)
  }
  const budgetB1 = async () => {
    const [row] = await db.select().from(budgets).where(eq(budgets.id, f.budgetB1))
    return { held: Number(row.amountHeldCents), spent: Number(row.amountSpentCents) }
  }

  beforeAll(async () => {
    f = await createOrderDeskFixtures()
    pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#22aa55" } }).png().toBuffer()
  })

  afterAll(async () => {
    if (f) await destroyOrderDeskFixtures(f, createdUserIds)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("authentication", () => {
    it("refuses every desk endpoint without a session", async () => {
      signIn(null)
      expect((await targets()).status).toBe(401)
      expect((await catalogue(f.organizationA, f.branchA1)).status).toBe(401)
      expect((await listDeskOrders()).status).toBe(401)
      expect((await fulfil(1)).status).toBe(401)
      expect((await cancel(1)).status).toBe(401)
      expect((await editOrder(1, { items: [{ organizationInventoryId: 1, quantity: 1 }] })).status).toBe(401)
      expect((await attachment(1)).status).toBe(401)
      expect((await read(await teamRoute.GET())).status).toBe(401)
      expect((await putAssignments(f.deskId, { organizationIds: [], branchIds: [] })).status).toBe(401)
      expect((await createOrder(deskOrderBody())).status).toBe(401)
    })

    it("refuses every desk endpoint to other roles", async () => {
      for (const kind of ["super", "head", "portal", "viewer"] as const) {
        signIn(actor(kind))
        expect((await targets()).status, kind).toBe(403)
        expect((await catalogue(f.organizationA, f.branchA1)).status, kind).toBe(403)
        expect((await listDeskOrders()).status, kind).toBe(403)
        expect((await fulfil(1)).status, kind).toBe(403)
        expect((await cancel(1)).status, kind).toBe(403)
        expect((await editOrder(1, { items: [{ organizationInventoryId: 1, quantity: 1 }] })).status, kind).toBe(403)
        expect((await attachment(1)).status, kind).toBe(403)
      }
    })
  })

  describe("reach", () => {
    it("offers only assigned, managed, active organizations and branches", async () => {
      signIn(actor("desk"))
      const { status, body } = await targets()
      expect(status).toBe(200)
      const byId = new Map<number, { branches: { id: number }[] }>(body.items.map((item: any) => [item.id, item]))
      expect([...byId.keys()].sort((a, b) => a - b)).toEqual([f.organizationA, f.organizationB].sort((a, b) => a - b))
      // A3 is inactive; C is not managed although the desk holds a grant to it.
      expect(byId.get(f.organizationA)!.branches.map((branch) => branch.id).sort((a, b) => a - b))
        .toEqual([f.branchA1, f.branchA2].sort((a, b) => a - b))
      expect(byId.get(f.organizationB)!.branches.map((branch) => branch.id)).toEqual([f.branchB1])
    })

    it("narrows a single-branch grant to that branch", async () => {
      signIn(actor("desk2"))
      const { body } = await targets()
      expect(body.items).toHaveLength(1)
      expect(body.items[0].branches.map((branch: any) => branch.id)).toEqual([f.branchA2])
    })

    it("gives an inactive desk account nothing", async () => {
      signIn(actor("deskOff"))
      expect((await targets()).body.items).toEqual([])
      expect((await createOrder(deskOrderBody())).status).toBe(403)
    })

    it("prices the catalogue through the ladder and refuses branches outside the reach", async () => {
      signIn(actor("desk"))
      const ok = await catalogue(f.organizationA, f.branchA1)
      expect(ok.status).toBe(200)
      expect(ok.body.items).toHaveLength(1)
      expect(ok.body.items[0].priceCents).toBe(ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA)

      expect((await catalogue(f.organizationC, f.branchC1)).status).toBe(403)
      expect((await catalogue(f.organizationA, f.branchA3)).status).toBe(403)
      expect((await catalogue(f.organizationA, f.branchB1)).status).toBe(403)

      signIn(actor("desk2"))
      expect((await catalogue(f.organizationA, f.branchA1)).status).toBe(403)
    })
  })

  describe("creating an order", () => {
    it("creates it pending for an Apricart Executive, with where it came from", async () => {
      const stockBefore = await stock()
      signIn(actor("desk"))
      const { status, body } = await createOrder(deskOrderBody())

      expect(status).toBe(200)
      expect(body.order.status).toBe("PENDING")
      expect(body.order.approvalTokenHash).toBeUndefined()

      const row = await storedOrder(body.order.id)
      // Nobody has approved it, and there is no fulfilment token yet.
      expect(row.approvedByUserId).toBeNull()
      expect(row.approvedAt).toBeNull()
      expect(row.approvalTokenHash).toBeNull()
      expect(row.createdByRole).toBe("ORDER_DESK")
      expect(row.intakeChannel).toBe("WHATSAPP")
      expect(row.intakeReference).toBe("Ali, 05 Oct 10:14")
      expect(row.intakeAttachmentKey).toBeNull()
      expect(Number(row.totalCents)).toBe(2 * ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA)
      expect(row.budgetTracked).toBe(false)
      expect(await stock()).toBe(stockBefore - 2)

      // Apricart entered it, so nobody is notified that it exists.
      expect(await db.select().from(notifications).where(eq(notifications.orderId, body.order.id))).toEqual([])

      const [log] = await db.select().from(systemLogs).where(and(
        eq(systemLogs.action, "ORDER_CREATE"),
        eq(systemLogs.resourceId, String(body.order.id)),
      ))
      expect(log.details).toMatchObject({ autoApproved: false, approvalBasis: "APRICART_EXECUTIVE_APPROVAL" })
    })

    it("answers a retried submission with the same order", async () => {
      signIn(actor("desk"))
      const key = idempotencyKey()
      const first = await createOrder(deskOrderBody({ branchId: f.branchA2 }), key)
      const second = await createOrder(deskOrderBody({ branchId: f.branchA2 }), key)
      expect(first.status).toBe(200)
      expect(second.body.replayed).toBe(true)
      expect(second.body.order.id).toBe(first.body.order.id)
    })

    it("holds budget at a budgeted tenant, exactly like any other order", async () => {
      signIn(actor("desk"))
      const before = await budgetB1()
      const { status, body } = await createOrder(bOrderBody(3))
      expect(status).toBe(200)
      expect((await storedOrder(body.order.id)).budgetTracked).toBe(true)
      expect((await budgetB1()).held).toBe(before.held + 3 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)
    })

    it("requires the intake details, and refuses them from anyone else", async () => {
      signIn(actor("desk"))
      expect((await createOrder(deskOrderBody({ intakeChannel: undefined }))).status).toBe(400)
      expect((await createOrder(deskOrderBody({ intakeReference: undefined }))).status).toBe(400)
      expect((await createOrder(deskOrderBody({ intakeChannel: "FAX" }))).status).toBe(400)

      signIn(actor("portal"))
      const portal = await createOrder({
        items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }],
        intakeChannel: "EMAIL",
        intakeReference: "pretending to be the desk",
      })
      expect(portal.status).toBe(400)
    })

    it("refuses targets outside the reach", async () => {
      signIn(actor("desk"))
      const unmanaged = await createOrder(deskOrderBody({
        organizationId: f.organizationC,
        branchId: f.branchC1,
        items: [{ organizationInventoryId: f.inventoryC, quantity: 1 }],
      }))
      expect(unmanaged.status).toBe(403)
      expect((await createOrder(deskOrderBody({ branchId: f.branchA3 }))).status).toBe(403)
      expect((await createOrder(deskOrderBody({ branchId: f.branchB1 }))).status).toBe(400)
      expect((await createOrder(deskOrderBody({ organizationId: undefined }))).status).toBe(400)

      signIn(actor("desk2"))
      expect((await createOrder(deskOrderBody())).status).toBe(403)
    })

    it("leaves every other role's approval workflow alone", async () => {
      signIn(actor("head"))
      const { status, body } = await createOrder({ branchId: f.branchA1, items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
      expect(status).toBe(200)
      expect(body.order.status).toBe("PENDING")
    })

    it("no longer lets a read-only Viewer create an order", async () => {
      signIn(actor("viewer"))
      expect((await createOrder({ items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })).status).toBe(403)
    })

    it("still lets the Order Portal order for its own branch", async () => {
      signIn(actor("portal"))
      const { status, body } = await createOrder({ items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
      expect(status).toBe(200)
      expect(body.order.status).toBe("PENDING")
    })
  })

  describe("the customer's screenshot", () => {
    beforeAll(() => {
      process.env.S3_UPLOADS_BUCKET = "it-order-desk"
      process.env.S3_UPLOADS_REGION = "ap-south-1"
    })

    afterAll(() => {
      delete process.env.S3_UPLOADS_BUCKET
      delete process.env.S3_UPLOADS_REGION
    })

    afterEach(() => {
      vi.mocked(putImage).mockClear()
      vi.mocked(getImage).mockReset()
    })

    it("is stored privately and bound to the desk user who uploaded it", async () => {
      signIn(actor("desk"))
      const uploaded = await upload()
      expect(uploaded.status).toBe(200)
      expect(uploaded.body.attachmentKey).toMatch(/^order-intake\/[0-9a-f-]{36}\.png$/)
      // Never a readable path, never the public product prefix.
      expect(uploaded.body.url).toBeUndefined()
      expect(vi.mocked(putImage)).toHaveBeenCalledWith(expect.objectContaining({ key: uploaded.body.attachmentKey }))

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "UPLOAD_ORDER_INTAKE_ATTACHMENT"),
        eq(auditLogs.entityId, uploaded.body.attachmentKey),
      ))
      expect(audit.userId).toBe(f.deskId)
    })

    it("is attached to the order, shown to the desk, and to nobody outside its reach", async () => {
      signIn(actor("desk"))
      const { body: { attachmentKey } } = await upload()
      const created = await createOrder(deskOrderBody({ intakeAttachmentKey: attachmentKey }))
      expect(created.status).toBe(200)
      const orderId = created.body.order.id
      expect((await storedOrder(orderId)).intakeAttachmentKey).toBe(attachmentKey)

      const listed = await listDeskOrders("status=all&limit=50")
      const row = listed.body.items.find((item: any) => item.id === orderId)
      expect(row.hasAttachment).toBe(true)
      // The key itself never leaves the server.
      expect(JSON.stringify(listed.body)).not.toContain(attachmentKey)

      vi.mocked(getImage).mockResolvedValue({
        body: { transformToWebStream: () => new Response(new Uint8Array(pngBytes)).body } as any,
        contentType: "image/png",
        contentLength: pngBytes.length,
      })
      const shown = await attachment(orderId)
      expect(shown.status).toBe(200)
      expect(shown.headers.get("content-type")).toBe("image/png")
      expect(shown.headers.get("cache-control")).toContain("no-store")
      expect(vi.mocked(getImage)).toHaveBeenCalledWith(attachmentKey)

      // desk2 reaches A2 only; this order is at A1.
      signIn(actor("desk2"))
      expect((await attachment(orderId)).status).toBe(404)

      // The public product-image route never serves the private prefix.
      signIn(actor("super"))
      const publicRead = await read(await publicImageRoute.GET(
        get(`http://localhost/api/v1/images/${attachmentKey}`),
        { params: Promise.resolve({ key: attachmentKey.split("/") }) },
      ))
      expect(publicRead.status).toBe(404)
    })

    it("answers 404 for an order without a screenshot", async () => {
      signIn(actor("desk"))
      const created = await createOrder(deskOrderBody())
      expect((await attachment(created.body.order.id)).status).toBe(404)
    })

    it("refuses a key that someone else uploaded, one already used, or one of the wrong shape", async () => {
      signIn(actor("desk2"))
      const { body: { attachmentKey: desk2Key } } = await upload()

      signIn(actor("desk"))
      const stolen = await createOrder(deskOrderBody({ intakeAttachmentKey: desk2Key }))
      expect(stolen.status).toBe(400)
      expect(stolen.body.error).toMatch(/not uploaded by you/)

      const { body: { attachmentKey } } = await upload()
      expect((await createOrder(deskOrderBody({ intakeAttachmentKey: attachmentKey }))).status).toBe(200)
      const reused = await createOrder(deskOrderBody({ intakeAttachmentKey: attachmentKey }))
      expect(reused.status).toBe(400)
      expect(reused.body.error).toMatch(/already attached/)

      const forged = await createOrder(deskOrderBody({ intakeAttachmentKey: "products/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png" }))
      expect(forged.status).toBe(400)
    })

    it("is never stored as a data: URL when storage is not configured", async () => {
      delete process.env.S3_UPLOADS_BUCKET
      try {
        signIn(actor("desk"))
        const uploaded = await upload()
        expect(uploaded.status).toBe(503)
        expect(vi.mocked(putImage)).not.toHaveBeenCalled()
      } finally {
        process.env.S3_UPLOADS_BUCKET = "it-order-desk"
      }
    })
  })

  describe("the desk's orders", () => {
    it("lists desk orders in reach, never a portal order, and shares them across the desk", async () => {
      signIn(actor("desk"))
      const all = await listDeskOrders("status=all&limit=50")
      expect(all.status).toBe(200)
      expect(all.body.items.length).toBeGreaterThan(0)
      for (const order of all.body.items) {
        expect([f.organizationA, f.organizationB]).toContain(order.organizationId)
        expect(order.intakeChannel).not.toBeNull()
      }
      const portalOrders = await db.select({ id: orders.id }).from(orders).where(eq(orders.createdByUserId, f.portalId))
      const listedIds = new Set(all.body.items.map((order: any) => order.id))
      for (const order of portalOrders) expect(listedIds.has(order.id)).toBe(false)

      signIn(actor("desk2"))
      const shared = await listDeskOrders("status=all")
      expect(shared.body.items.length).toBeGreaterThan(0)
      for (const order of shared.body.items) expect(order.branchId).toBe(f.branchA2)
    })

    it("cannot be widened by naming an organization out of reach", async () => {
      signIn(actor("desk2"))
      const { status, body } = await listDeskOrders(`status=all&organizationId=${f.organizationB}`)
      expect(status).toBe(200)
      expect(body.items).toEqual([])
      expect((await listDeskOrders("status=everything")).status).toBe(400)
    })

    it("is fulfilled by the desk only after an executive approves it and Super Admin records delivery", async () => {
      signIn(actor("desk"))
      const created = await createOrder(bOrderBody(1))
      const orderId = created.body.order.id
      const before = await budgetB1()

      // Pending: the desk may edit or cancel it, and cannot fulfil it.
      let listed = (await listDeskOrders("status=awaiting_approval&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ status: "PENDING", canEdit: true, canCancel: true, canResubmit: false, canFulfil: false })
      expect((await fulfil(orderId)).status).toBe(409)

      await approveAsExecutive(orderId)

      // Approved, not delivered yet: the desk cannot fulfil, and may only cancel.
      expect((await fulfil(orderId)).status).toBe(409)
      listed = (await listDeskOrders("status=awaiting_delivery&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ canEdit: false, canCancel: true, canFulfil: false, canRequestRefund: false })

      await superDeliver(orderId)

      signIn(actor("desk"))
      listed = (await listDeskOrders("status=ready_to_fulfil&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ fulfillmentStatus: "DELIVERED", canEdit: false, canCancel: false, canFulfil: true })

      const done = await fulfil(orderId)
      expect(done.status).toBe(200)
      const row = await storedOrder(orderId)
      expect(row.status).toBe("FULFILLED")
      expect(row.fulfilledByUserId).toBe(f.deskId)
      expect(row.deliveredAt).toBeInstanceOf(Date)

      const after = await budgetB1()
      expect(after.held).toBe(before.held - ORDER_DESK_FIXTURE_PRICE_CENTS.base)
      expect(after.spent).toBe(before.spent + ORDER_DESK_FIXTURE_PRICE_CENTS.base)
      expect((await fulfil(orderId)).status).toBe(409)

      const trail = await db.select({ action: auditLogs.action, userId: auditLogs.userId }).from(auditLogs).where(eq(auditLogs.entityId, String(orderId)))
      expect(trail.filter((entry) => entry.action === "ORDER_FULFILLMENT_STATUS_UPDATE").every((entry) => entry.userId === f.superAdminId)).toBe(true)
      expect(trail.some((entry) => entry.action === "ORDER_FULFILLED" && entry.userId === f.deskId)).toBe(true)
    })

    it("answers 404 for an order outside the reach or not entered by the desk", async () => {
      signIn(actor("desk"))
      const a1 = await createOrder(deskOrderBody())
      const [portalOrder] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.createdByUserId, f.portalId))
        .orderBy(desc(orders.id))
        .limit(1)

      expect((await fulfil(portalOrder.id)).status).toBe(404)
      expect((await cancel(portalOrder.id)).status).toBe(404)
      expect((await editOrder(portalOrder.id, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })).status).toBe(404)

      signIn(actor("desk2"))
      expect((await fulfil(a1.body.order.id)).status).toBe(404)
      expect((await cancel(a1.body.order.id)).status).toBe(404)
      expect((await editOrder(a1.body.order.id, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })).status).toBe(404)
      expect((await fulfil(999_999_999)).status).toBe(404)
    })
  })

  describe("cancelling", () => {
    it("withdraws an undelivered order and releases its stock and budget hold", async () => {
      signIn(actor("desk"))
      const stockBefore = await stock()
      const heldBefore = (await budgetB1()).held
      const created = await createOrder(bOrderBody(4))
      const orderId = created.body.order.id
      expect(await stock()).toBe(stockBefore - 4)
      expect((await budgetB1()).held).toBe(heldBefore + 4 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)

      expect((await cancel(orderId, { reason: "  " })).status).toBe(400)
      expect((await cancel(orderId, {})).status).toBe(400)

      const done = await cancel(orderId, { reason: "Customer withdrew it by WhatsApp" })
      expect(done.status).toBe(200)

      const row = await storedOrder(orderId)
      expect(row.status).toBe("CANCELLED")
      expect(row.cancelledByUserId).toBe(f.deskId)
      expect(row.cancelledAt).toBeInstanceOf(Date)
      expect(row.cancellationReason).toBe("Customer withdrew it by WhatsApp")
      expect(await stock()).toBe(stockBefore)
      expect((await budgetB1()).held).toBe(heldBefore)

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_CANCELLED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(audit.userId).toBe(f.deskId)

      // Once cancelled it stays cancelled, and nothing more can be done with it.
      expect((await cancel(orderId)).status).toBe(409)
      expect((await fulfil(orderId)).status).toBe(409)
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryB, quantity: 1 }] })).status).toBe(409)
      const listed = (await listDeskOrders("status=cancelled&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ status: "CANCELLED", canEdit: false, canCancel: false, canFulfil: false })
    })

    it("refuses to cancel an order Super Admin has marked delivered", async () => {
      signIn(actor("desk"))
      const created = await createActiveOrder(deskOrderBody())
      await superDeliver(created.body.order.id)
      signIn(actor("desk"))
      expect((await cancel(created.body.order.id)).status).toBe(409)
      expect((await storedOrder(created.body.order.id)).status).toBe("APPROVED")
    })
  })

  describe("editing", () => {
    it("re-prices the lines and moves stock and the budget hold by the difference", async () => {
      signIn(actor("desk"))
      const created = await createOrder(bOrderBody(2, { poNumber: "PO-1" }))
      const orderId = created.body.order.id
      const invoiceNumber = (await storedOrder(orderId)).receiptData?.invoiceNumber
      const stockBefore = await stock()
      const heldBefore = (await budgetB1()).held

      const edited = await editOrder(orderId, {
        items: [{ organizationInventoryId: f.inventoryB, quantity: 5 }],
        notes: "Customer added three more",
        poNumber: "PO-2",
      })
      expect(edited.status).toBe(200)
      expect(edited.body.totalCents).toBe(5 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)

      const row = await storedOrder(orderId)
      // Still waiting for the executive, who now sees the edited lines.
      expect(row.status).toBe("PENDING")
      expect(Number(row.totalCents)).toBe(5 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)
      expect(row.notes).toBe("Customer added three more")
      expect(row.poNumber).toBe("PO-2")
      // The invoice keeps its number.
      expect(row.receiptData?.invoiceNumber).toBe(invoiceNumber)
      expect(row.receiptData?.poNumber).toBe("PO-2")
      expect(await stock()).toBe(stockBefore - 3)
      expect((await budgetB1()).held).toBe(heldBefore + 3 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)

      const lines = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId))
      expect(lines.map((line) => Number(line.quantity))).toEqual([5])

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_EDITED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(audit.userId).toBe(f.deskId)

      // Shrinking gives stock and budget back.
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryB, quantity: 1 }] })).status).toBe(200)
      expect(await stock()).toBe(stockBefore + 1)
      expect((await budgetB1()).held).toBe(heldBefore - ORDER_DESK_FIXTURE_PRICE_CENTS.base)
    })

    it("refuses an edit it cannot honour, and changes nothing", async () => {
      signIn(actor("desk"))
      const created = await createOrder(deskOrderBody())
      const orderId = created.body.order.id
      const totalBefore = Number((await storedOrder(orderId)).totalCents)

      expect((await editOrder(orderId, { items: [] })).status).toBe(400)
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1_000_000 }] })).status).toBe(400)
      // A product of another tenant is never available on this branch.
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryB, quantity: 1 }] })).status).toBe(400)
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }], status: "FULFILLED" })).status).toBe(400)
      expect(Number((await storedOrder(orderId)).totalCents)).toBe(totalBefore)

      // Once an executive approves it, the lines are fixed: an edit would
      // change what was approved.
      await approveAsExecutive(orderId)
      const approved = await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
      expect(approved.status).toBe(409)
      expect(approved.body.error).toMatch(/approved order cannot be edited/)

      await superDeliver(orderId)
      signIn(actor("desk"))
      expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })).status).toBe(409)
      expect(Number((await storedOrder(orderId)).totalCents)).toBe(totalBefore)
    })

    it("refuses an edit once the branch is no longer one the desk may order for", async () => {
      signIn(actor("desk"))
      const created = await createOrder(deskOrderBody({ branchId: f.branchA2 }))
      await db.update(branches).set({ status: "inactive" }).where(eq(branches.id, f.branchA2))
      try {
        const refused = await editOrder(created.body.order.id, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
        expect(refused.status).toBe(403)
      } finally {
        await db.update(branches).set({ status: "active" }).where(eq(branches.id, f.branchA2))
      }
    })
  })

  describe("refunds", () => {
    it("lets the desk request a refund on a fulfilled order for Super Admin to approve", async () => {
      signIn(actor("desk"))
      const created = await createActiveOrder(bOrderBody(2))
      const orderId = created.body.order.id
      const [line] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId))

      // Not yet fulfilled: refused, as for every requester.
      expect((await requestRefund(orderId, { items: [{ id: line.id, quantity: 1 }], reason: "Damaged" })).status).toBe(400)

      await superDeliver(orderId)
      signIn(actor("desk"))
      expect((await fulfil(orderId)).status).toBe(200)
      const spentBefore = (await budgetB1()).spent

      const requested = await requestRefund(orderId, { items: [{ id: line.id, quantity: 1 }], reason: "One box arrived damaged" })
      expect(requested.status).toBe(200)

      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, orderId))
      expect(refund.status).toBe("PENDING")
      expect(refund.requestedByUserId).toBe(f.deskId)
      expect(Number(refund.amountCents)).toBe(ORDER_DESK_FIXTURE_PRICE_CENTS.base)
      // Nothing moves until Super Admin approves it.
      expect((await budgetB1()).spent).toBe(spentBefore)
      const superAdminNotice = await db.select().from(notifications).where(and(
        eq(notifications.userId, f.superAdminId),
        eq(notifications.type, "REFUND_REQUESTED"),
      ))
      expect(superAdminNotice.length).toBeGreaterThan(0)

      const history = await refundHistory(orderId)
      expect(history.status).toBe(200)
      const listed = (await listDeskOrders("status=fulfilled&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ canRequestRefund: true, pendingRefundCents: ORDER_DESK_FIXTURE_PRICE_CENTS.base })

      // Outside the reach: refused, and the history is not readable either.
      signIn(actor("desk2"))
      expect((await requestRefund(orderId, { items: [{ id: line.id, quantity: 1 }], reason: "x" })).status).toBe(403)
      expect((await refundHistory(orderId)).status).toBe(403)
    })

    it("never lets the desk refund an order it did not enter", async () => {
      const [portalOrder] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.createdByUserId, f.portalId))
        .orderBy(desc(orders.id))
        .limit(1)
      signIn(actor("desk"))
      expect((await refundHistory(portalOrder.id)).status).toBe(403)
    })
  })

  describe("Super Admin administers the desk", () => {
    it("creates a desk user only without a tenant, and Head Office cannot create one", async () => {
      const base = {
        firstName: "Desk",
        lastName: "Person",
        email: `itd-new-${f.suffix}@example.test`,
        username: `itd-new-${f.suffix}`,
        password: "Str0ng!Passw0rd",
        role: "ORDER_DESK",
        branchId: null,
      }
      const create = async (body: unknown) => read(await usersRoute.POST(new Request("http://localhost/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })))

      signIn(actor("head"))
      expect((await create({ ...base, organizationId: f.organizationA })).status).toBe(403)

      signIn(actor("super"))
      expect((await create({ ...base, organizationId: f.organizationA })).status).toBe(400)
      const created = await create({ ...base, organizationId: null })
      expect(created.status).toBe(201)
      createdUserIds.push(created.body.item.id)
      expect(created.body.item.organizationId).toBeNull()

      signIn({ id: created.body.item.id, email: base.email, role: "ORDER_DESK", organizationId: null, branchId: null })
      expect((await targets()).body.items).toEqual([])
    })

    it("grants only managed organizations, audits it, and refuses everyone else", async () => {
      signIn(actor("super"))
      expect((await putAssignments(f.desk2Id, { organizationIds: [f.organizationC], branchIds: [] })).status).toBe(400)
      expect((await putAssignments(f.desk2Id, { organizationIds: [], branchIds: [f.branchC1] })).status).toBe(400)
      expect((await putAssignments(f.portalId, { organizationIds: [f.organizationA], branchIds: [] })).status).toBe(404)

      const granted = await putAssignments(f.desk2Id, { organizationIds: [f.organizationB], branchIds: [f.branchA2, f.branchB1] })
      expect(granted.status).toBe(200)
      expect(granted.body.item.branchIds).toEqual([f.branchA2])
      expect(await db.select().from(orderDeskAssignments).where(eq(orderDeskAssignments.userId, f.desk2Id))).toHaveLength(2)
      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_ORDER_DESK_ASSIGNMENTS"),
        eq(auditLogs.entityId, f.desk2Id),
      ))
      expect(audit.userId).toBe(f.superAdminId)

      const team = await read(await teamRoute.GET())
      expect(team.status).toBe(200)
      expect(team.body.members.some((member: any) => member.id === f.desk2Id)).toBe(true)
      expect(team.body.managedOrganizations.some((organization: any) => organization.id === f.organizationC)).toBe(false)

      signIn(actor("head"))
      expect((await putAssignments(f.desk2Id, { organizationIds: [f.organizationA], branchIds: [] })).status).toBe(403)
      expect((await read(await teamRoute.GET())).status).toBe(403)
      signIn(actor("desk"))
      expect((await putAssignments(f.deskId, { organizationIds: [f.organizationC], branchIds: [] })).status).toBe(403)
    })

    it("lets a desk account be deactivated but never retyped or given a tenant", async () => {
      signIn(actor("head"))
      expect((await patchAccess(f.desk2Id, { isActive: false })).status).toBe(403)

      signIn(actor("super"))
      expect((await patchAccess(f.desk2Id, { role: "HEAD_OFFICE" })).status).toBe(400)
      expect((await patchAccess(f.desk2Id, { organizationId: f.organizationA })).status).toBe(400)
      expect((await patchAccess(f.portalId, { role: "ORDER_DESK" })).status).toBe(400)

      expect((await patchAccess(f.desk2Id, { isActive: false })).status).toBe(200)
      signIn(actor("desk2"))
      expect((await targets()).body.items).toEqual([])

      signIn(actor("super"))
      expect((await patchAccess(f.desk2Id, { isActive: true })).status).toBe(200)
    })

    it("withdraws the desk from a tenant the moment it stops being managed", async () => {
      signIn(actor("head"))
      expect((await patchOrganization(f.organizationA, { managedOrdering: false })).status).toBe(403)

      signIn(actor("super"))
      expect((await patchOrganization(f.organizationA, { managedOrdering: false })).status).toBe(200)
      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_ORGANIZATION_MANAGED_ORDERING"),
        eq(auditLogs.organizationId, f.organizationA),
      ))
      expect(audit.metadata).toMatchObject({ previousManagedOrdering: true, managedOrdering: false })

      signIn(actor("desk"))
      expect((await targets()).body.items.map((item: any) => item.id)).not.toContain(f.organizationA)
      expect((await createOrder(deskOrderBody())).status).toBe(403)
      expect((await listDeskOrders(`status=all&organizationId=${f.organizationA}`)).body.items).toEqual([])

      signIn(actor("super"))
      expect((await patchOrganization(f.organizationA, { managedOrdering: true })).status).toBe(200)
      const [organization] = await db.select({ managedOrdering: organizations.managedOrdering }).from(organizations).where(eq(organizations.id, f.organizationA))
      expect(organization.managedOrdering).toBe(true)
    })

    it("keeps the column off for every tenant that never asked", async () => {
      const [row] = await db.select({ managedOrdering: organizations.managedOrdering }).from(organizations).where(eq(organizations.id, f.organizationC))
      expect(row.managedOrdering).toBe(false)
      const [user] = await db.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, f.deskId))
      expect(user.organizationId).toBeNull()
    })
  })

  describe("retries and races", () => {
    beforeAll(() => {
      process.env.S3_UPLOADS_BUCKET = "it-order-desk"
      process.env.S3_UPLOADS_REGION = "ap-south-1"
    })

    afterAll(() => {
      delete process.env.S3_UPLOADS_BUCKET
      delete process.env.S3_UPLOADS_REGION
    })

    it("answers a retried submission that carries a screenshot with the order it created", async () => {
      signIn(actor("desk"))
      const { body: { attachmentKey } } = await upload()
      const key = idempotencyKey()
      const body = deskOrderBody({ intakeAttachmentKey: attachmentKey })

      const first = await createOrder(body, key)
      expect(first.status).toBe(200)
      // The response was lost and the desk user pressed Create again.
      const retry = await createOrder(body, key)
      expect(retry.status).toBe(200)
      expect(retry.body.replayed).toBe(true)
      expect(retry.body.order.id).toBe(first.body.order.id)

      // The same key with a different draft is still a conflict, never a second order.
      expect((await createOrder({ ...body, intakeReference: "a different message" }, key)).status).toBe(409)
      // A genuinely new submission still may not reuse the screenshot.
      const reused = await createOrder(body)
      expect(reused.status).toBe(400)
      expect(reused.body.error).toMatch(/already attached/)
      expect(await db.select({ id: orders.id }).from(orders).where(eq(orders.intakeAttachmentKey, attachmentKey))).toHaveLength(1)
    })

    it("creates one order when the same draft is submitted twice at once", async () => {
      signIn(actor("desk"))
      const { body: { attachmentKey } } = await upload()
      const key = idempotencyKey()
      const body = deskOrderBody({ intakeAttachmentKey: attachmentKey })
      const stockBefore = await stock()

      const results = await Promise.all([createOrder(body, key), createOrder(body, key)])

      expect(results.map((result) => result.status)).toEqual([200, 200])
      expect(results[0].body.order.id).toBe(results[1].body.order.id)
      expect(results.filter((result) => result.body.replayed === true)).toHaveLength(1)
      expect(await stock()).toBe(stockBefore - 2)
    })

    it("answers a double submission with one order for every role, not a 500", async () => {
      // The shared creation path: the same lost race happens in the shop.
      signIn(actor("portal"))
      const key = idempotencyKey()
      const body = { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] }
      const results = await Promise.all([createOrder(body, key), createOrder(body, key)])
      expect(results.map((result) => result.status)).toEqual([200, 200])
      expect(results[0].body.order.id).toBe(results[1].body.order.id)
      expect(await db.select({ id: orders.id }).from(orders).where(and(
        eq(orders.createdByUserId, f.portalId),
        eq(orders.idempotencyKey, key),
      ))).toHaveLength(1)
    })

    it("cancels an approved order once when two cancels race, releasing stock and the hold once", async () => {
      signIn(actor("desk"))
      const stockBefore = await stock()
      const heldBefore = (await budgetB1()).held
      const orderId = (await createActiveOrder(bOrderBody(3))).body.order.id

      const results = await Promise.all([cancel(orderId), cancel(orderId)])

      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409])
      expect(await stock()).toBe(stockBefore)
      expect((await budgetB1()).held).toBe(heldBefore)
      const trail = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_CANCELLED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(trail).toHaveLength(1)
    })

    it("fulfils once when two fulfils race, moving the hold to spent once", async () => {
      signIn(actor("desk"))
      const orderId = (await createActiveOrder(bOrderBody(2))).body.order.id
      await superDeliver(orderId)
      signIn(actor("desk"))
      const before = await budgetB1()

      const results = await Promise.all([fulfil(orderId), fulfil(orderId)])

      expect(results.map((result) => result.status).sort((a, b) => a - b)).toEqual([200, 409])
      const after = await budgetB1()
      expect(after.held).toBe(before.held - 2 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)
      expect(after.spent).toBe(before.spent + 2 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)
    })

    it("leaves stock and the hold whole when an edit races a cancel", async () => {
      signIn(actor("desk"))
      const stockBefore = await stock()
      const heldBefore = (await budgetB1()).held
      const orderId = (await createOrder(bOrderBody(2))).body.order.id

      const [edited, cancelled] = await Promise.all([
        editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryB, quantity: 5 }] }),
        cancel(orderId),
      ])

      // Whichever takes the lock first, the cancel lands and releases what the order then holds.
      expect(cancelled.status).toBe(200)
      expect([200, 409]).toContain(edited.status)
      expect((await storedOrder(orderId)).status).toBe("CANCELLED")
      expect(await stock()).toBe(stockBefore)
      expect((await budgetB1()).held).toBe(heldBefore)
    })
  })

  describe("the edges of the desk's reach", () => {
    it("can still withdraw an order at a branch deactivated after it was placed, but not order there", async () => {
      signIn(actor("desk"))
      const orderId = (await createOrder(deskOrderBody({ branchId: f.branchA2 }))).body.order.id
      await db.update(branches).set({ status: "inactive" }).where(eq(branches.id, f.branchA2))
      try {
        expect((await createOrder(deskOrderBody({ branchId: f.branchA2 }))).status).toBe(403)
        expect((await catalogue(f.organizationA, f.branchA2)).status).toBe(403)
        const listed = await listDeskOrders(`status=awaiting_approval&branchId=${f.branchA2}&limit=50`)
        expect(listed.body.items.map((item: any) => item.id)).toContain(orderId)
        expect((await cancel(orderId)).status).toBe(200)
      } finally {
        await db.update(branches).set({ status: "active" }).where(eq(branches.id, f.branchA2))
      }
    })

    it("gives a deactivated desk user nothing, not even the orders it entered", async () => {
      signIn(actor("desk"))
      const orderId = (await createOrder(deskOrderBody())).body.order.id
      // The account is switched off while its token is still in flight.
      await db.update(users).set({ isActive: false }).where(eq(users.id, f.deskId))
      try {
        expect((await listDeskOrders("status=all&limit=50")).body.items).toEqual([])
        expect((await cancel(orderId)).status).toBe(404)
        expect((await fulfil(orderId)).status).toBe(404)
        expect((await editOrder(orderId, { items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })).status).toBe(404)
        expect((await attachment(orderId)).status).toBe(404)
        expect((await refundHistory(orderId)).status).toBe(403)
        expect((await createOrder(deskOrderBody())).status).toBe(403)
        expect((await storedOrder(orderId)).status).toBe("PENDING")
      } finally {
        await db.update(users).set({ isActive: true }).where(eq(users.id, f.deskId))
      }
    })

    it("refuses a session that still owes a password change", async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { ...actor("desk"), fullName: "desk", mustChangePassword: true },
      } as any)
      expect((await createOrder(deskOrderBody())).status).toBe(403)
    })

    it("shows desk orders to the customer's own Head Office as orders of its branch that Apricart decides", async () => {
      signIn(actor("desk"))
      const orderId = (await createOrder(deskOrderBody())).body.order.id
      signIn(actor("head"))
      const seen = await read(await ordersRoute.GET(get(`http://localhost/api/v1/orders?id=${orderId}`)))
      expect(seen.status).toBe(200)
      expect(seen.body.items.map((item: any) => item.id)).toEqual([orderId])
      expect(seen.body.items[0].status).toBe("PENDING")
      expect(seen.body.items[0].decidedByApricart).toBe(true)
      // The creator's role itself is never in the response.
      expect(seen.body.items[0].createdByRole).toBeUndefined()
    })
  })

  describe("malformed input", () => {
    it("is refused on every desk write, and changes nothing", async () => {
      signIn(actor("desk"))
      const orderId = (await createOrder(deskOrderBody())).body.order.id
      const before = await storedOrder(orderId)
      const stockBefore = await stock()

      expect((await cancel(orderId, { reason: "x", status: "APPROVED" })).status).toBe(400)
      expect((await cancel(orderId, { reason: "x".repeat(501) })).status).toBe(400)

      const line = (organizationInventoryId: number, quantity: unknown) => ({ organizationInventoryId, quantity })
      for (const items of [
        [line(f.inventoryA, 1), line(f.inventoryA, 2)],
        [line(f.inventoryA, 1.5)],
        [line(f.inventoryA, 0)],
        [line(f.inventoryA, -1)],
        [line(f.inventoryA, "lots")],
      ]) {
        expect((await editOrder(orderId, { items })).status, JSON.stringify(items)).toBe(400)
      }
      const badId = await read(await deskOrderRoute.PUT(
        jsonRequest("http://localhost/api/v1/order-desk/orders/abc", "PUT", { items: [line(f.inventoryA, 1)] }),
        params("abc"),
      ))
      expect(badId.status).toBe(400)

      const catalogueWith = async (query: string) => read(await catalogueRoute.GET(get(`http://localhost/api/v1/order-desk/catalogue?${query}`)))
      expect((await catalogueWith(`organizationId=${f.organizationA}`)).status).toBe(400)
      expect((await catalogueWith(`organizationId=${f.organizationA}&branchId=${f.branchA1}&extra=1`)).status).toBe(400)

      expect((await createOrder(deskOrderBody({ intakeReference: "x".repeat(256) }))).status).toBe(400)
      expect((await createOrder(deskOrderBody({ intakeChannel: "whatsapp" }))).status).toBe(400)
      expect((await createOrder(deskOrderBody({ intakeAttachmentKey: "order-intake/../products/x.png" }))).status).toBe(400)

      const after = await storedOrder(orderId)
      expect(after.status).toBe(before.status)
      expect(Number(after.totalCents)).toBe(Number(before.totalCents))
      expect(await stock()).toBe(stockBefore)
    })
  })

  describe("the ordering gates", () => {
    it("holds the desk to the unacknowledged-delivery block, which the desk clears by fulfilling", async () => {
      const unacknowledgedAtA2 = async () => {
        const [row] = await db.select({ n: count() }).from(orders).where(and(
          eq(orders.branchId, f.branchA2),
          sql`UPPER(${orders.status}) = 'APPROVED'`,
          sql`${orders.fulfillmentStatus} = 'DELIVERED'`,
        ))
        return Number(row.n)
      }
      const existing = await unacknowledgedAtA2()
      await db.update(organizations)
        .set({ blockOrderingOnUnacknowledgedDeliveries: true, unacknowledgedDeliveryBlockThreshold: existing + 1 })
        .where(eq(organizations.id, f.organizationA))
      try {
        signIn(actor("desk"))
        const orderId = (await createActiveOrder(deskOrderBody({ branchId: f.branchA2 }))).body.order.id
        await superDeliver(orderId)

        signIn(actor("desk"))
        const blocked = await createOrder(deskOrderBody({ branchId: f.branchA2 }))
        expect(blocked.status).toBe(409)
        expect(blocked.body.code).toBe("UNACKNOWLEDGED_DELIVERIES_BLOCKED")

        expect((await fulfil(orderId)).status).toBe(200)
        expect((await createOrder(deskOrderBody({ branchId: f.branchA2 }))).status).toBe(200)
      } finally {
        await db.update(organizations)
          .set({ blockOrderingOnUnacknowledgedDeliveries: false, unacknowledgedDeliveryBlockThreshold: 2 })
          .where(eq(organizations.id, f.organizationA))
      }
    })
  })

  describe("the order list after refunds", () => {
    it("keeps a fully refunded desk order on the Fulfilled tab", async () => {
      signIn(actor("desk"))
      const orderId = (await createActiveOrder(bOrderBody(1))).body.order.id
      await superDeliver(orderId)
      signIn(actor("desk"))
      expect((await fulfil(orderId)).status).toBe(200)
      const [line] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId))

      signIn(actor("super"))
      expect((await requestRefund(orderId, { items: [{ id: line.id, quantity: 1 }], reason: "Returned in full" })).status).toBe(200)
      expect((await storedOrder(orderId)).status).toBe("REFUNDED")

      signIn(actor("desk"))
      const row = (await listDeskOrders("status=fulfilled&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(row).toMatchObject({
        status: "REFUNDED",
        refundedCents: ORDER_DESK_FIXTURE_PRICE_CENTS.base,
        canEdit: false,
        canCancel: false,
        canFulfil: false,
        canRequestRefund: false,
      })
    })

    it("counts each tab exactly as the tab lists it, and every order on one tab", async () => {
      signIn(actor("desk"))
      const { body } = await listDeskOrders("status=all&limit=1")
      const tabs = ["awaiting_approval", "awaiting_delivery", "ready_to_fulfil", "fulfilled", "rejected", "cancelled", "all"] as const
      for (const tab of tabs) {
        const listed = await listDeskOrders(`status=${tab}&limit=1`)
        expect(listed.body.pagination.total, tab).toBe(body.counts[tab])
      }
      const { awaiting_approval, awaiting_delivery, ready_to_fulfil, fulfilled, rejected, cancelled, all } = body.counts
      expect(awaiting_approval).toBeGreaterThan(0)
      expect(awaiting_approval + awaiting_delivery + ready_to_fulfil + fulfilled + rejected + cancelled).toBe(all)
    })

    it("bounds the page size and treats search wildcards literally", async () => {
      signIn(actor("desk"))
      const big = await listDeskOrders("status=all&limit=5000&page=0")
      expect(big.body.pagination).toMatchObject({ page: 1, limit: 50 })
      expect(big.body.items.length).toBeLessThanOrEqual(50)
      for (const wildcard of ["%", "_"]) {
        const found = await listDeskOrders(`status=all&q=${encodeURIComponent(wildcard)}`)
        expect(found.status).toBe(200)
        expect(found.body.items, wildcard).toEqual([])
      }
      expect((await listDeskOrders(`status=all&q=${"x".repeat(101)}`)).status).toBe(400)

      const reference = `Ref-${f.suffix}`
      const orderId = (await createOrder(deskOrderBody({ intakeReference: reference }))).body.order.id
      expect((await listDeskOrders(`status=all&q=${reference}`)).body.items.map((item: any) => item.id)).toEqual([orderId])
      // desk2 does not reach A1, so the same search finds nothing.
      signIn(actor("desk2"))
      expect((await listDeskOrders(`status=all&q=${reference}`)).body.items).toEqual([])
    })
  })
})
