import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as tenantApproveRoute from "@/app/api/v1/orders/[id]/approve/route"
import * as tenantRejectRoute from "@/app/api/v1/orders/[id]/reject/route"
import * as tenantReturnRoute from "@/app/api/v1/orders/[id]/return-for-correction/route"
import * as tenantResubmitRoute from "@/app/api/v1/orders/[id]/resubmit/route"
import * as approvalsRoute from "@/app/api/v1/executive/approvals/route"
import * as approveRoute from "@/app/api/v1/executive/approvals/[id]/approve/route"
import * as rejectRoute from "@/app/api/v1/executive/approvals/[id]/reject/route"
import * as returnRoute from "@/app/api/v1/executive/approvals/[id]/return/route"
import * as attachmentRoute from "@/app/api/v1/executive/approvals/[id]/attachment/route"
import * as deskEditRoute from "@/app/api/v1/order-desk/orders/[id]/route"
import * as deskCancelRoute from "@/app/api/v1/order-desk/orders/[id]/cancel/route"
import * as deskResubmitRoute from "@/app/api/v1/order-desk/orders/[id]/resubmit/route"
import * as executivesRoute from "@/app/api/v1/apricart-executives/route"
import * as executiveOrganizationsRoute from "@/app/api/v1/apricart-executives/[userId]/organizations/route"
import {
  apricartExecutiveAssignments,
  auditLogs,
  budgets,
  emailOutbox,
  globalProducts,
  notifications,
  orderCorrectionRequests,
  orders,
  organizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { getImage } from "@/lib/server/image-storage"
import { approveOrder } from "@/lib/server/order-decision-service"
import { cancelDeskOrder } from "@/lib/server/order-desk-orders"

import {
  createOrderDeskFixtures,
  destroyOrderDeskFixtures,
  hasTestDatabase,
  ORDER_DESK_FIXTURE_PRICE_CENTS,
  stageIntakeAttachment,
  type OrderDeskFixtures,
} from "./helpers/order-desk-fixtures"

/**
 * Apricart Executives approving the Order Desk's orders, end to end: the real
 * routes against Postgres, with only identity, request headers, the rate
 * limiter, the cache, outbound email and the S3 read faked.
 *
 * The conditions under test (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md):
 *   * every desk order starts PENDING;
 *   * an executive decides only desk orders, only in organizations assigned to them;
 *   * nobody in the tenant decides a desk order, and its requesters cannot rewrite it;
 *   * only Super Admin assigns, and every assignment is audited.
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

type Kind = "super" | "head" | "desk" | "portal" | "executive" | "executiveC" | "executiveOff"
type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

const jsonRequest = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
const get = (url: string) => new NextRequest(url)
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

let keyCounter = 0
const idempotencyKey = () => `ite-${Date.now().toString(36)}-${(keyCounter += 1)}`

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
  return { status: response.status, body, headers: response.headers }
}

describe.skipIf(!hasTestDatabase)("Apricart Executives approving Order Desk orders", () => {
  let f: OrderDeskFixtures

  const actor = (kind: Kind): Actor => {
    const table = {
      super: { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null },
      head: { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationA, branchId: null },
      desk: { id: f.deskId, role: "ORDER_DESK", organizationId: null, branchId: null },
      portal: { id: f.portalId, role: "ORDER_PORTAL", organizationId: f.organizationA, branchId: f.branchA1 },
      executive: { id: f.executiveId, role: "APRICART_EXECUTIVE", organizationId: null, branchId: null },
      executiveC: { id: f.executiveCId, role: "APRICART_EXECUTIVE", organizationId: null, branchId: null },
      executiveOff: { id: f.executiveOffId, role: "APRICART_EXECUTIVE", organizationId: null, branchId: null },
    } as const
    return { ...table[kind], email: `${kind}-${f.suffix}@example.test` }
  }

  const signIn = (kind: Kind | null) => {
    vi.mocked(getServerSession).mockResolvedValue(
      kind === null ? null : ({ user: { ...actor(kind), fullName: kind, mustChangePassword: false } } as any),
    )
  }

  const createOrder = async (body: unknown) =>
    read(await ordersRoute.POST(jsonRequest("http://localhost/api/v1/orders", "POST", body, { "Idempotency-Key": idempotencyKey() })))

  /** A desk order at A1 (or B1 with `atB`), created by the desk; returns its id. */
  const deskOrder = async (options: { atB?: boolean; quantity?: number } = {}) => {
    signIn("desk")
    const created = await createOrder({
      organizationId: options.atB ? f.organizationB : f.organizationA,
      branchId: options.atB ? f.branchB1 : f.branchA1,
      items: [{ organizationInventoryId: options.atB ? f.inventoryB : f.inventoryA, quantity: options.quantity ?? 2 }],
      intakeChannel: "EMAIL",
      intakeReference: `Executive approvals ${f.suffix}`,
      intakeAttachmentKey: await stageIntakeAttachment(f.deskId),
    })
    expect(created.status, "desk order").toBe(200)
    expect(created.body.order.status).toBe("PENDING")
    return created.body.order.id as number
  }

  /** An order the customer's own Order Portal user raised at A1. */
  const portalOrder = async () => {
    signIn("portal")
    const created = await createOrder({ items: [{ organizationInventoryId: f.inventoryA, quantity: 1 }] })
    expect(created.status, "portal order").toBe(200)
    return created.body.order.id as number
  }

  const storedOrder = async (orderId: number) => (await db.select().from(orders).where(eq(orders.id, orderId)))[0]
  const versionOf = async (orderId: number) => {
    const row = await storedOrder(orderId)
    return row.updatedAt ? row.updatedAt.toISOString() : null
  }
  const stock = async () => {
    const [row] = await db.select({ stock: globalProducts.stockQuantity }).from(globalProducts).where(eq(globalProducts.id, f.productId))
    return Number(row.stock)
  }
  const heldAtB1 = async () => {
    const [row] = await db.select({ held: budgets.amountHeldCents }).from(budgets).where(eq(budgets.id, f.budgetB1))
    return Number(row.held)
  }

  const list = async (query = "") => read(await approvalsRoute.GET(get(`http://localhost/api/v1/executive/approvals?${query}`)))
  const approve = async (orderId: number | string, body?: unknown) => {
    const payload = body ?? { expectedUpdatedAt: typeof orderId === "number" ? await versionOf(orderId) : null }
    return read(await approveRoute.POST(
      jsonRequest(`http://localhost/api/v1/executive/approvals/${orderId}/approve`, "POST", payload),
      params(orderId),
    ))
  }
  const reject = async (orderId: number, body: unknown = { reason: "Duplicate of an earlier message" }) => read(await rejectRoute.POST(
    jsonRequest(`http://localhost/api/v1/executive/approvals/${orderId}/reject`, "POST", body),
    params(orderId),
  ))
  const giveBack = async (orderId: number, body: unknown = { comment: "Customer asked for 3, not 2" }) => read(await returnRoute.POST(
    jsonRequest(`http://localhost/api/v1/executive/approvals/${orderId}/return`, "POST", body),
    params(orderId),
  ))
  const attachment = async (orderId: number) => read(await attachmentRoute.GET(
    get(`http://localhost/api/v1/executive/approvals/${orderId}/attachment`),
    params(orderId),
  ))
  const tenantDecision = async (route: { POST: (req: any, props: any) => Promise<Response> }, orderId: number, body: unknown) =>
    read(await route.POST(jsonRequest(`http://localhost/api/v1/orders/${orderId}/x`, "POST", body), params(orderId)))
  const deskEdit = async (orderId: number, quantity: number) => read(await deskEditRoute.PUT(
    jsonRequest(`http://localhost/api/v1/order-desk/orders/${orderId}`, "PUT", { items: [{ organizationInventoryId: f.inventoryA, quantity }] }),
    params(orderId),
  ))
  const deskCancel = async (orderId: number) => read(await deskCancelRoute.POST(
    jsonRequest(`http://localhost/api/v1/order-desk/orders/${orderId}/cancel`, "POST", { reason: "Customer withdrew it" }),
    params(orderId),
  ))
  const deskResubmit = async (orderId: number, body?: unknown) => read(await deskResubmitRoute.POST(
    new Request(`http://localhost/api/v1/order-desk/orders/${orderId}/resubmit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params(orderId),
  ))
  const putOrganizations = async (userId: string, body: unknown) => read(await executiveOrganizationsRoute.PUT(
    jsonRequest(`http://localhost/api/v1/apricart-executives/${userId}/organizations`, "PUT", body),
    { params: Promise.resolve({ userId }) },
  ))

  beforeAll(async () => {
    f = await createOrderDeskFixtures()
  })

  afterAll(async () => {
    if (f) {
      await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, [f.organizationA, f.organizationB, f.organizationC]))
      await destroyOrderDeskFixtures(f)
    }
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("authentication and authorization", () => {
    it("refuses every executive and assignment endpoint without a session", async () => {
      signIn(null)
      expect((await list()).status).toBe(401)
      expect((await approve(1, { expectedUpdatedAt: null })).status).toBe(401)
      expect((await reject(1)).status).toBe(401)
      expect((await giveBack(1)).status).toBe(401)
      expect((await attachment(1)).status).toBe(401)
      expect((await read(await executivesRoute.GET())).status).toBe(401)
      expect((await putOrganizations(f.executiveId, { organizationIds: [] })).status).toBe(401)
    })

    it("refuses the executive endpoints to every other role", async () => {
      const orderId = await deskOrder()
      for (const kind of ["super", "head", "desk", "portal"] as const) {
        signIn(kind)
        expect((await list()).status, kind).toBe(403)
        expect((await approve(orderId, { expectedUpdatedAt: null })).status, kind).toBe(403)
        expect((await reject(orderId)).status, kind).toBe(403)
        expect((await giveBack(orderId)).status, kind).toBe(403)
        expect((await attachment(orderId)).status, kind).toBe(403)
      }
      expect((await storedOrder(orderId)).status).toBe("PENDING")
    })

    it("refuses the assignment endpoints to everyone but Super Admin", async () => {
      for (const kind of ["head", "desk", "portal", "executive"] as const) {
        signIn(kind)
        expect((await read(await executivesRoute.GET())).status, kind).toBe(403)
        expect((await putOrganizations(f.executiveId, { organizationIds: [f.organizationC] })).status, kind).toBe(403)
      }
    })
  })

  describe("a desk order waits for an executive", () => {
    it("even where the organization approves its own orders automatically", async () => {
      await db.update(organizations).set({ orderApprovalRequired: false }).where(eq(organizations.id, f.organizationB))
      try {
        const orderId = await deskOrder({ atB: true, quantity: 1 })
        const row = await storedOrder(orderId)
        expect(row.status).toBe("PENDING")
        expect(row.approvedByUserId).toBeNull()
        expect(row.approvalTokenHash).toBeNull()

        signIn("executive")
        expect((await approve(orderId)).status).toBe(200)
      } finally {
        await db.update(organizations).set({ orderApprovalRequired: true }).where(eq(organizations.id, f.organizationB))
      }
    })
  })

  describe("the approval list", () => {
    it("lists the desk's orders in assigned organizations only, with their lines and amounts", async () => {
      const atA = await deskOrder()
      const atB = await deskOrder({ atB: true, quantity: 1 })
      const fromPortal = await portalOrder()

      signIn("executive")
      const { status, body } = await list("status=all&limit=50")
      expect(status).toBe(200)
      const ids = body.items.map((item: any) => item.id)
      expect(ids).toEqual(expect.arrayContaining([atA, atB]))
      // An order the customer's own staff raised is never the executive's.
      expect(ids).not.toContain(fromPortal)
      for (const item of body.items) expect([f.organizationA, f.organizationB]).toContain(item.organizationId)
      expect(body.organizations.map((organization: any) => organization.id).sort((a: number, b: number) => a - b))
        .toEqual([f.organizationA, f.organizationB].sort((a, b) => a - b))

      const row = body.items.find((item: any) => item.id === atA)
      expect(row).toMatchObject({
        status: "PENDING",
        totalCents: 2 * ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA,
        intakeChannel: "EMAIL",
        canApprove: true,
        canReject: true,
        canReturn: true,
      })
      expect(row.items).toHaveLength(1)
      // Never the fulfilment token, never the screenshot's storage key.
      expect(JSON.stringify(body)).not.toMatch(/approvalToken|intakeAttachmentKey/)
    })

    it("cannot be widened by naming an organization outside the reach", async () => {
      await deskOrder()
      signIn("executiveC")
      const own = await list("status=all")
      expect(own.status).toBe(200)
      expect(own.body.items).toEqual([])
      expect((await list(`status=all&organizationId=${f.organizationA}`)).body.items).toEqual([])
      expect((await list("status=everything")).status).toBe(400)
      expect((await list("organizationId=abc")).status).toBe(400)
    })

    it("gives an inactive executive nothing", async () => {
      await deskOrder()
      signIn("executiveOff")
      const { body } = await list("status=all")
      expect(body.items).toEqual([])
      expect(body.organizations).toEqual([])
    })

    it("counts each tab exactly as the tab lists it", async () => {
      signIn("executive")
      const { body } = await list("status=all&limit=1")
      for (const tab of ["awaiting_approval", "returned", "approved", "rejected", "all"]) {
        expect((await list(`status=${tab}&limit=1`)).body.pagination.total, tab).toBe(body.counts[tab])
      }
    })
  })

  describe("approving", () => {
    it("makes the order Active, answerable to the executive, without telling anyone", async () => {
      const orderId = await deskOrder()
      signIn("executive")
      const approved = await approve(orderId)

      expect(approved.status).toBe(200)
      expect(approved.body.order).toMatchObject({ id: orderId, status: "APPROVED" })
      // The token is stored for the order, never handed to the executive.
      expect(JSON.stringify(approved.body)).not.toMatch(/approvalToken|token/i)

      const row = await storedOrder(orderId)
      expect(row.status).toBe("APPROVED")
      expect(row.approvedByUserId).toBe(f.executiveId)
      expect(row.approvedAt).toBeInstanceOf(Date)
      expect(row.approvalTokenHash).not.toBeNull()

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_APPROVED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(audit.userId).toBe(f.executiveId)
      expect(audit.metadata).toMatchObject({ actorRole: "APRICART_EXECUTIVE", decisionRole: "APRICART_EXECUTIVE" })

      expect(await db.select().from(notifications).where(eq(notifications.orderId, orderId))).toEqual([])
      expect(await db.select().from(emailOutbox).where(eq(emailOutbox.orderId, orderId))).toEqual([])

      // Decided once: a second approval changes nothing.
      expect((await approve(orderId)).status).toBe(400)
      expect((await storedOrder(orderId)).approvedByUserId).toBe(f.executiveId)
    })

    it("refuses to approve a version the executive did not see", async () => {
      const orderId = await deskOrder()
      signIn("executive")
      const seen = await versionOf(orderId)

      signIn("desk")
      expect((await deskEdit(orderId, 5)).status).toBe(200)

      signIn("executive")
      const stale = await approve(orderId, { expectedUpdatedAt: seen })
      expect(stale.status).toBe(409)
      expect((await storedOrder(orderId)).status).toBe("PENDING")

      expect((await approve(orderId)).status).toBe(200)
      expect(Number((await storedOrder(orderId)).totalCents)).toBe(5 * ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA)
    })

    it("refuses a malformed approval", async () => {
      const orderId = await deskOrder()
      signIn("executive")
      expect((await approve(orderId, {})).status).toBe(400)
      expect((await approve(orderId, { expectedUpdatedAt: "yesterday" })).status).toBe(400)
      expect((await approve(orderId, { expectedUpdatedAt: null, status: "APPROVED" })).status).toBe(400)
      expect((await approve("abc", { expectedUpdatedAt: null })).status).toBe(400)
      expect((await storedOrder(orderId)).status).toBe("PENDING")
    })

    it("answers 404, and changes nothing, outside the reach", async () => {
      const orderId = await deskOrder()
      const fromPortal = await portalOrder()

      signIn("executiveC")
      expect((await approve(orderId)).status).toBe(404)
      expect((await reject(orderId)).status).toBe(404)
      expect((await giveBack(orderId)).status).toBe(404)

      signIn("executiveOff")
      expect((await approve(orderId)).status).toBe(404)

      // An order the Order Portal raised, in an organization the executive holds.
      signIn("executive")
      expect((await approve(fromPortal)).status).toBe(404)
      expect((await reject(fromPortal)).status).toBe(404)
      expect((await approve(999_999_999, { expectedUpdatedAt: null })).status).toBe(404)

      expect((await storedOrder(orderId)).status).toBe("PENDING")
      expect((await storedOrder(fromPortal)).status).toBe("PENDING")
    })

    it("stops the moment Super Admin removes the organization", async () => {
      const orderId = await deskOrder()
      signIn("super")
      expect((await putOrganizations(f.executiveId, { organizationIds: [f.organizationB] })).status).toBe(200)
      try {
        signIn("executive")
        expect((await approve(orderId)).status).toBe(404)
        expect((await list("status=all&limit=50")).body.items.map((item: any) => item.id)).not.toContain(orderId)
      } finally {
        signIn("super")
        expect((await putOrganizations(f.executiveId, { organizationIds: [f.organizationA, f.organizationB] })).status).toBe(200)
      }
      signIn("executive")
      expect((await approve(orderId)).status).toBe(200)
    })

    it("approves once when two approvals race", async () => {
      const orderId = await deskOrder()
      signIn("executive")
      const version = await versionOf(orderId)
      const results = await Promise.all([
        approve(orderId, { expectedUpdatedAt: version }),
        approve(orderId, { expectedUpdatedAt: version }),
      ])
      expect(results.map((result) => result.status).sort((a, b) => a - b)[0]).toBe(200)
      expect(results.filter((result) => result.status === 200)).toHaveLength(1)
      const trail = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_APPROVED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(trail).toHaveLength(1)
    })

    it("ends cancelled, releasing stock and the hold once, when an approval races the desk's cancel", async () => {
      const stockBefore = await stock()
      const heldBefore = await heldAtB1()
      const orderId = await deskOrder({ atB: true, quantity: 3 })
      const version = await versionOf(orderId)

      // The session is one mock, so the two transitions race at the service,
      // each with its own actor, exactly as the two routes call them.
      const [approved, cancelled] = await Promise.all([
        approveOrder({
          orderId,
          scope: { role: "APRICART_EXECUTIVE", userId: f.executiveId, organizationId: null, branchId: null },
          user: { id: f.executiveId, role: "APRICART_EXECUTIVE", email: null },
          expectedUpdatedAt: version === null ? null : new Date(version),
        }),
        cancelDeskOrder({ orderId, reason: "Customer withdrew it", actor: { id: f.deskId, role: "ORDER_DESK", email: null } }),
      ])
      // Whichever lands first, the desk may cancel until delivery, so the order ends cancelled.
      expect(["approved", "invalid-state", "conflict"]).toContain(approved.kind)
      expect(cancelled.kind).toBe("cancelled")
      expect((await storedOrder(orderId)).status).toBe("CANCELLED")
      expect(await stock()).toBe(stockBefore)
      expect(await heldAtB1()).toBe(heldBefore)
    })
  })

  describe("rejecting", () => {
    it("requires a reason, and releases the order's stock and budget hold", async () => {
      const stockBefore = await stock()
      const heldBefore = await heldAtB1()
      const orderId = await deskOrder({ atB: true, quantity: 4 })
      expect(await stock()).toBe(stockBefore - 4)
      expect(await heldAtB1()).toBe(heldBefore + 4 * ORDER_DESK_FIXTURE_PRICE_CENTS.base)

      signIn("executive")
      expect((await reject(orderId, {})).status).toBe(400)
      expect((await reject(orderId, { reason: "   " })).status).toBe(400)
      expect((await reject(orderId, { reason: "x", organizationId: f.organizationC })).status).toBe(400)

      const rejected = await reject(orderId, { reason: "Customer sent this twice" })
      expect(rejected.status).toBe(200)

      const row = await storedOrder(orderId)
      expect(row.status).toBe("REJECTED")
      expect(row.rejectedByUserId).toBe(f.executiveId)
      expect(row.rejectionReason).toBe("Customer sent this twice")
      expect(await stock()).toBe(stockBefore)
      expect(await heldAtB1()).toBe(heldBefore)

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "ORDER_REJECTED"),
        eq(auditLogs.entityId, String(orderId)),
      ))
      expect(audit.metadata).toMatchObject({ decisionRole: "APRICART_EXECUTIVE" })
      expect(await db.select().from(notifications).where(eq(notifications.orderId, orderId))).toEqual([])

      // The desk sees why, and can do nothing more with it.
      signIn("desk")
      expect((await deskCancel(orderId)).status).toBe(409)
      expect((await deskEdit(orderId, 1)).status).toBe(409)
    })
  })

  describe("returning for correction", () => {
    it("sends the order to the desk, which corrects and resubmits it before it can be approved", async () => {
      const orderId = await deskOrder()
      signIn("executive")
      expect((await giveBack(orderId, {})).status).toBe(400)
      const returned = await giveBack(orderId)
      expect(returned.status).toBe(200)
      expect((await storedOrder(orderId)).returnedForCorrectionAt).toBeInstanceOf(Date)

      // With the desk: the executive may not approve or return it again.
      const waiting = await approve(orderId)
      expect(waiting.status).toBe(409)
      expect(waiting.body.error).toMatch(/returned for correction/)
      expect((await giveBack(orderId)).status).toBe(409)
      const listed = (await list("status=returned&limit=50")).body.items.find((item: any) => item.id === orderId)
      expect(listed).toMatchObject({ canApprove: false, canReject: true, canReturn: false, correctionRequestNote: "Customer asked for 3, not 2" })

      signIn("desk")
      expect((await deskEdit(orderId, 3)).status).toBe(200)
      expect((await deskResubmit(orderId, { note: "Changed to 3" })).status).toBe(200)
      expect((await deskResubmit(orderId)).status).toBe(409)

      const [round] = await db.select().from(orderCorrectionRequests).where(eq(orderCorrectionRequests.orderId, orderId))
      expect(round).toMatchObject({
        resolution: "RESUBMITTED",
        resolvedByUserId: f.deskId,
        resolvedByRole: "ORDER_DESK",
        responseNote: "Changed to 3",
        requestedByRole: "APRICART_EXECUTIVE",
      })

      signIn("executive")
      expect((await approve(orderId)).status).toBe(200)
      expect(Number((await storedOrder(orderId)).totalCents)).toBe(3 * ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA)
      // Nobody in the tenant was told about any of it.
      expect(await db.select().from(notifications).where(eq(notifications.orderId, orderId))).toEqual([])
    })

    it("lets the desk withdraw a returned order, closing the round as cancelled", async () => {
      const stockBefore = await stock()
      const orderId = await deskOrder({ quantity: 2 })
      signIn("executive")
      expect((await giveBack(orderId)).status).toBe(200)

      signIn("desk")
      expect((await deskCancel(orderId)).status).toBe(200)
      const row = await storedOrder(orderId)
      expect(row.status).toBe("CANCELLED")
      expect(row.returnedForCorrectionAt).toBeNull()
      expect(row.correctionRequestNote).toBeNull()
      expect(await stock()).toBe(stockBefore)
      const [round] = await db.select().from(orderCorrectionRequests).where(eq(orderCorrectionRequests.orderId, orderId))
      expect(round).toMatchObject({ resolution: "CANCELLED", resolvedByUserId: f.deskId })
    })

    it("refuses a resubmission of an order that is not returned, or outside the desk's reach", async () => {
      const orderId = await deskOrder()
      signIn("desk")
      expect((await deskResubmit(orderId)).status).toBe(409)
      expect((await deskResubmit(999_999_999)).status).toBe(404)
      expect((await deskResubmit(orderId, { note: "x".repeat(1001) })).status).toBe(400)
      expect((await deskResubmit(orderId, { note: "ok", status: "APPROVED" })).status).toBe(400)
    })
  })

  describe("the customer's own people", () => {
    it("cannot approve, reject or return a desk order — even the configured approver", async () => {
      const orderId = await deskOrder()
      signIn("head")
      expect((await tenantDecision(tenantApproveRoute, orderId, {})).status).toBe(403)
      expect((await tenantDecision(tenantRejectRoute, orderId, { reason: "no" })).status).toBe(403)
      expect((await tenantDecision(tenantReturnRoute, orderId, { comment: "fix it" })).status).toBe(403)
      expect((await storedOrder(orderId)).status).toBe("PENDING")

      // Their own branch's orders are theirs to decide, exactly as before.
      const fromPortal = await portalOrder()
      signIn("head")
      expect((await tenantDecision(tenantApproveRoute, fromPortal, {})).status).toBe(200)
      expect((await storedOrder(fromPortal)).approvedByUserId).toBe(f.headOfficeId)
    })

    it("are told the order is Apricart's to decide, and offered no decision on it", async () => {
      const orderId = await deskOrder()
      const fromPortal = await portalOrder()
      signIn("head")
      const detail = await read(await orderRoute.GET(get(`http://localhost/api/v1/orders/${orderId}`), params(orderId)))
      expect(detail.status).toBe(200)
      expect(detail.body.item.decidedByApricart).toBe(true)
      expect(detail.body.capabilities).toMatchObject({ canApproveOrders: false, canRejectOrders: false, canReturnOrders: false })

      const own = await read(await orderRoute.GET(get(`http://localhost/api/v1/orders/${fromPortal}`), params(fromPortal)))
      expect(own.body.item.decidedByApricart).toBe(false)
      expect(own.body.capabilities).toMatchObject({ canApproveOrders: true, canRejectOrders: true })
    })

    it("cannot edit or resubmit a desk order at their branch", async () => {
      const orderId = await deskOrder()
      const totalBefore = Number((await storedOrder(orderId)).totalCents)
      signIn("portal")
      const edited = await read(await orderRoute.PUT(
        jsonRequest(`http://localhost/api/v1/orders/${orderId}`, "PUT", { items: [{ organizationInventoryId: f.inventoryA, quantity: 9 }] }),
        params(orderId),
      ))
      expect(edited.status).toBe(404)
      expect(Number((await storedOrder(orderId)).totalCents)).toBe(totalBefore)

      signIn("executive")
      expect((await giveBack(orderId)).status).toBe(200)
      signIn("portal")
      const resubmitted = await read(await tenantResubmitRoute.POST(
        jsonRequest(`http://localhost/api/v1/orders/${orderId}/resubmit`, "POST", {}),
        params(orderId),
      ))
      expect(resubmitted.status).toBe(404)
      expect((await storedOrder(orderId)).returnedForCorrectionAt).toBeInstanceOf(Date)
    })
  })

  describe("the customer's screenshot", () => {
    beforeAll(() => {
      process.env.S3_UPLOADS_BUCKET = "it-exec-approval"
      process.env.S3_UPLOADS_REGION = "ap-south-1"
    })
    afterAll(() => {
      delete process.env.S3_UPLOADS_BUCKET
      delete process.env.S3_UPLOADS_REGION
    })
    afterEach(() => {
      vi.mocked(getImage).mockReset()
    })

    it("is shown to an executive whose reach covers the order, and to nobody else", async () => {
      const orderId = await deskOrder()
      const key = (await storedOrder(orderId)).intakeAttachmentKey
      vi.mocked(getImage).mockResolvedValue({
        body: { transformToWebStream: () => new Response(new Uint8Array([1, 2, 3])).body } as any,
        contentType: "image/png",
        contentLength: 3,
      })

      signIn("executive")
      const shown = await attachment(orderId)
      expect(shown.status).toBe(200)
      expect(shown.headers.get("cache-control")).toContain("no-store")
      expect(shown.headers.get("x-content-type-options")).toBe("nosniff")
      expect(vi.mocked(getImage)).toHaveBeenCalledWith(key)

      signIn("executiveC")
      expect((await attachment(orderId)).status).toBe(404)

      // A desk order with no screenshot (entered before one was required) is the same 404.
      const withoutScreenshot = await deskOrder()
      await db.update(orders).set({ intakeAttachmentKey: null }).where(eq(orders.id, withoutScreenshot))
      signIn("executive")
      expect((await attachment(withoutScreenshot)).status).toBe(404)
    })
  })

  describe("Super Admin assigns", () => {
    it("replaces an executive's organizations, audits it, and lists them", async () => {
      signIn("super")
      const replaced = await putOrganizations(f.executiveCId, { organizationIds: [f.organizationC, f.organizationB] })
      expect(replaced.status).toBe(200)
      expect(replaced.body.item.organizationIds).toEqual([f.organizationB, f.organizationC].sort((a, b) => a - b))
      const rows = await db.select().from(apricartExecutiveAssignments).where(eq(apricartExecutiveAssignments.userId, f.executiveCId))
      expect(rows.map((row) => row.organizationId).sort((a, b) => a - b)).toEqual([f.organizationB, f.organizationC].sort((a, b) => a - b))
      expect(rows.every((row) => row.createdByUserId === f.superAdminId)).toBe(true)

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "UPDATE_APRICART_EXECUTIVE_ASSIGNMENTS"),
        eq(auditLogs.entityId, f.executiveCId),
      ))
      expect(audit.userId).toBe(f.superAdminId)

      const team = await read(await executivesRoute.GET())
      expect(team.status).toBe(200)
      expect(team.headers.get("cache-control")).toContain("no-store")
      const member = team.body.members.find((entry: any) => entry.id === f.executiveCId)
      expect(member.organizationIds).toEqual([f.organizationB, f.organizationC].sort((a, b) => a - b))
      expect(team.body.organizations.some((organization: any) => organization.id === f.organizationC)).toBe(true)
      // Executives only; no password hash or other column leaks.
      expect(team.body.members.some((entry: any) => entry.id === f.deskId)).toBe(false)
      expect(JSON.stringify(team.body)).not.toContain("passwordHash")

      expect((await putOrganizations(f.executiveCId, { organizationIds: [f.organizationC] })).status).toBe(200)
    })

    it("refuses anything it cannot apply, and changes nothing", async () => {
      signIn("super")
      expect((await putOrganizations(f.deskId, { organizationIds: [f.organizationA] })).status).toBe(404)
      expect((await putOrganizations("not-a-uuid", { organizationIds: [] })).status).toBe(404)
      expect((await putOrganizations(f.executiveCId, { organizationIds: [999_999_999] })).status).toBe(400)
      expect((await putOrganizations(f.executiveCId, { organizationIds: [f.organizationC, f.organizationC] })).status).toBe(400)
      expect((await putOrganizations(f.executiveCId, { organizationIds: [-1] })).status).toBe(400)
      expect((await putOrganizations(f.executiveCId, { organizationIds: [f.organizationC], role: "SUPER_ADMIN" })).status).toBe(400)
      const rows = await db.select().from(apricartExecutiveAssignments).where(eq(apricartExecutiveAssignments.userId, f.executiveCId))
      expect(rows.map((row) => row.organizationId)).toEqual([f.organizationC])
    })
  })
})
