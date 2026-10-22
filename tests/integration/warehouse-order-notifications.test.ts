import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like, or } from "drizzle-orm"

import * as approveRoute from "@/app/api/v1/orders/[id]/approve/route"
import * as rejectRoute from "@/app/api/v1/orders/[id]/reject/route"
import * as progressRoute from "@/app/api/v1/warehouse/orders/[id]/progress/route"
import * as notificationsRoute from "@/app/api/v1/warehouse/notifications/route"
import {
  auditLogs,
  branches,
  emailOutbox,
  globalProducts,
  notifications,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { fulfillApprovedOrder } from "@/lib/server/order-fulfillment"
import { processOrderEmailOutbox } from "@/lib/server/order-notifications"
import { queueWarehouseOrderNotifications } from "@/lib/server/warehouse-order-notifications"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Warehouse order-stage notifications against Postgres.
 * See plans/OF-WAREHOUSE-order-stage-notifications.md.
 *
 * Identity, headers, the rate limiter and the mail provider are faked; the
 * queueing, the routes, the outbox and every constraint are real.
 *
 * ```text
 * Tenant A                                   Tenant B
 *   A1 (Lahore)  ← whBranch (branch)            B1 (Lahore) ← whCity (city)
 *                ← whCity   (city "lahore")
 *                ← whInactive (deactivated)
 *   A2 (Karachi) ← whOther  (branch)
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
const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string }>)
vi.mock("@/lib/email/ses", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/ses")>()
  return {
    ...actual,
    sendAppEmail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
      sent.push({ to: input.to, subject: input.subject, text: input.text })
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
  const [created] = await db.insert(roles).values({ name, description: "Created by warehouse notification tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("warehouse order-stage notifications", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchB1: number
  let productId: number
  let placed = 0

  const place = async (values: { organizationId: number; branchId: number; status: string; fulfillmentStatus?: string; deliveredAt?: Date }) => {
    placed += 1
    const [row] = await db.insert(orders).values({
      tid: `WN${suffix}${placed}`.slice(0, 26),
      createdByUserId: actors.raiser.id,
      createdByRole: "ORDER_PORTAL",
      approvedAt: values.status === "APPROVED" ? new Date() : null,
      subtotalCents: 71_000,
      taxCents: 1_000,
      totalCents: 71_000,
      budgetTracked: false,
      ...values,
    }).returning({ id: orders.id, tid: orders.tid, organizationId: orders.organizationId, branchId: orders.branchId })
    await db.insert(orderItems).values({
      orderId: row.id, organizationId: values.organizationId, globalProductId: productId, productName: "Rice", productCode: "RICE", unit: "kg", quantity: 1, priceCents: 71_000, taxCents: 1_000,
    })
    return row
  }

  const noticesFor = async (orderId: number) => db
    .select({ userId: notifications.userId, type: notifications.type, targetRole: notifications.targetRole, message: notifications.message, eventKey: notifications.eventKey })
    .from(notifications)
    .where(and(eq(notifications.orderId, orderId), like(notifications.type, "WAREHOUSE_ORDER_%")))

  const outboxFor = async (orderId: number) => db
    .select({ id: emailOutbox.id, recipientUserId: emailOutbox.recipientUserId, template: emailOutbox.template, payload: emailOutbox.payload, eventKey: emailOutbox.eventKey, status: emailOutbox.status, recipientRole: emailOutbox.recipientRole })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.orderId, orderId), like(emailOutbox.template, "WAREHOUSE_ORDER_%")))

  const listNotices = async (actor: Actor | null) => {
    signIn(actor)
    return read(await notificationsRoute.GET())
  }

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "BRANCH_ADMIN", "ORDER_PORTAL", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT WN A ${suffix}`, code: `ITWNA_${suffix}`, orderApproverRole: "BRANCH_ADMIN" }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT WN B ${suffix}`, code: `ITWNB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id
    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT WN A1 ${suffix}`, city: `Lahore${suffix}`, status: "active" },
      { organizationId: orgA, name: `IT WN A2 ${suffix}`, city: `Karachi${suffix}`, status: "active" },
      { organizationId: orgB, name: `IT WN B1 ${suffix}`, city: ` lahore${suffix} `, status: "active" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null, isActive = true) => {
      const email = `it-wn-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-wn-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("branchAdmin", "BRANCH_ADMIN", orgA, branchA1)
    await person("raiser", "ORDER_PORTAL", orgA, branchA1)
    await person("whBranch", "WAREHOUSE", null, null)
    await person("whCity", "WAREHOUSE", null, null)
    await person("whOther", "WAREHOUSE", null, null)
    await person("whInactive", "WAREHOUSE", null, null, false)

    await db.insert(warehouseAssignments).values([
      { userId: actors.whBranch.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
      { userId: actors.whOther.id, branchId: branchA2, createdByUserId: actors.superAdmin.id },
      { userId: actors.whInactive.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
    ])
    await db.insert(warehouseCityAssignments).values({ userId: actors.whCity.id, cityKey: `lahore${suffix}`, createdByUserId: actors.superAdmin.id })
    await db.insert(warehouseCityOrganizations).values([
      { userId: actors.whCity.id, organizationId: orgA, createdByUserId: actors.superAdmin.id },
      { userId: actors.whCity.id, organizationId: orgB, createdByUserId: actors.superAdmin.id },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITWN-${suffix}`, name: `IT WN Rice ${suffix}`, basePrice: 71_000, status: "active", unit: "kg", stockQuantity: 100,
    }).returning({ id: globalProducts.id })
    productId = product.id
  })

  afterAll(async () => {
    if (!orgA) return
    const organizationIds = [orgA, orgB]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    const orderIds = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds))).map((row) => row.id)
    await db.delete(emailOutbox).where(inArray(emailOutbox.recipientUserId, actorIds))
    await db.delete(notifications).where(inArray(notifications.userId, actorIds))
    if (orderIds.length > 0) {
      await purgeInvoiceLedger({ organizationIds })
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, actorIds)))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, actorIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, actorIds))
    await db.delete(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, actorIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    sent.length = 0
  })

  describe("who is told", () => {
    it("tells every active warehouse user serving the branch, by branch or by city, and no one else", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      const queued = await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })
      expect(queued.recipientCount).toBe(2)

      const notices = await noticesFor(order.id)
      expect(notices.map((row) => row.userId).sort()).toEqual([actors.whBranch.id, actors.whCity.id].sort())
      expect(notices.every((row) => row.type === "WAREHOUSE_ORDER_CREATED" && row.targetRole === "WAREHOUSE")).toBe(true)
      expect(notices[0].message).toContain("awaiting approval")

      const outbox = await outboxFor(order.id)
      expect(outbox.map((row) => row.recipientUserId).sort()).toEqual([actors.whBranch.id, actors.whCity.id].sort())
      // Order, organization, branch, stage — no amount, no person.
      expect(Object.keys(outbox[0].payload).sort()).toEqual(["approvedAtCreation", "branchName", "orderId", "organizationName", "tid"])
      expect(JSON.stringify(outbox[0].payload)).not.toContain("raiser")
    })

    it("follows a city assignment into another chosen organization, and not into one that is not chosen", async () => {
      const order = await place({ organizationId: orgB, branchId: branchB1, status: "PENDING" })
      await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })
      expect((await noticesFor(order.id)).map((row) => row.userId)).toEqual([actors.whCity.id])

      // plans/OF-WAREHOUSE-city-assignments-by-organization.md: the city alone is not enough.
      await db.delete(warehouseCityOrganizations).where(and(
        eq(warehouseCityOrganizations.userId, actors.whCity.id),
        eq(warehouseCityOrganizations.organizationId, orgB),
      ))
      try {
        const unchosen = await place({ organizationId: orgB, branchId: branchB1, status: "PENDING" })
        await queueWarehouseOrderNotifications(db, { order: unchosen, event: "CREATED" })
        expect(await noticesFor(unchosen.id)).toEqual([])
      } finally {
        await db.insert(warehouseCityOrganizations).values({ userId: actors.whCity.id, organizationId: orgB })
      }
    })

    it("queues each event once per recipient, however often it is asked", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA2, status: "PENDING" })
      await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })
      await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })
      expect(await noticesFor(order.id)).toHaveLength(1)
      expect(await outboxFor(order.id)).toHaveLength(1)
    })

    it("keeps every occurrence of a recurring event, and refuses one with no occurrence", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA2, status: "PENDING" })
      await queueWarehouseOrderNotifications(db, { order, event: "EDITED", occurrence: 1 })
      await queueWarehouseOrderNotifications(db, { order, event: "EDITED", occurrence: 2 })
      expect((await noticesFor(order.id)).filter((row) => row.type === "WAREHOUSE_ORDER_EDITED")).toHaveLength(2)
      await expect(queueWarehouseOrderNotifications(db, { order, event: "EDITED" })).rejects.toThrow(/OCCURRENCE_REQUIRED/)
    })

    it("queues nothing when the change rolls back", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      await expect(db.transaction(async (tx) => {
        await queueWarehouseOrderNotifications(tx, { order, event: "CANCELLED" })
        throw new Error("rolled back")
      })).rejects.toThrow("rolled back")
      expect(await noticesFor(order.id)).toHaveLength(0)
      expect(await outboxFor(order.id)).toHaveLength(0)
    })
  })

  describe("the order paths", () => {
    it("tells the warehouse when an approver approves or rejects", async () => {
      const toApprove = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      signIn(actors.branchAdmin)
      expect((await approveRoute.POST(request(`http://localhost/api/v1/orders/${toApprove.id}/approve`, "POST"), params(toApprove.id))).status).toBe(200)
      expect((await noticesFor(toApprove.id)).filter((row) => row.type === "WAREHOUSE_ORDER_APPROVED")).toHaveLength(2)

      const toReject = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      signIn(actors.branchAdmin)
      const rejected = await rejectRoute.POST(
        request(`http://localhost/api/v1/orders/${toReject.id}/reject`, "POST", { reason: "Duplicate order" }),
        params(toReject.id),
      )
      expect(rejected.status).toBe(200)
      const notices = await noticesFor(toReject.id)
      expect(notices.filter((row) => row.type === "WAREHOUSE_ORDER_REJECTED")).toHaveLength(2)
      // The free-text reason never reaches the warehouse.
      expect(notices.some((row) => row.message.includes("Duplicate order"))).toBe(false)
    })

    it("tells the warehouse nothing when the warehouse moves a delivery stage", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
      signIn(actors.whBranch)
      const moved = await progressRoute.POST(
        request(`http://localhost/api/v1/warehouse/orders/${order.id}/progress`, "POST", { fulfillmentStatus: "IN_PROCESS" }),
        params(order.id),
      )
      expect(moved.status).toBe(200)
      expect(await noticesFor(order.id)).toHaveLength(0)
      expect(await outboxFor(order.id)).toHaveLength(0)
    })

    it("tells the warehouse when an order is fulfilled", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "DELIVERED", deliveredAt: new Date() })
      const outcome = await fulfillApprovedOrder({ orderId: order.id, organizationId: orgA, branchId: branchA1, fulfilledByUserId: actors.superAdmin.id })
      expect(outcome).toBe("fulfilled")
      expect((await noticesFor(order.id)).filter((row) => row.type === "WAREHOUSE_ORDER_FULFILLED")).toHaveLength(2)
    })
  })

  describe("the email", () => {
    it("is sent to a recipient who still serves the branch, and retired for one who no longer does", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      const queued = await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })

      // whCity's city stops matching before the email goes out.
      await db.update(branches).set({ city: `Multan${suffix}` }).where(eq(branches.id, branchA1))
      try {
        const result = await processOrderEmailOutbox({ eventKeys: queued.eventKeys, limit: queued.eventKeys.length })
        expect(result.sent).toBe(1)
        expect(result.skipped).toBe(1)
      } finally {
        await db.update(branches).set({ city: `Lahore${suffix}` }).where(eq(branches.id, branchA1))
      }
      expect(sent.map((mail) => mail.to)).toEqual([actors.whBranch.email])
      expect(sent[0].subject).toBe(`Order ${order.tid} was placed and is awaiting approval`)
      expect(sent[0].text).toContain("/warehouse")
      const statuses = Object.fromEntries((await outboxFor(order.id)).map((row) => [row.recipientUserId, row.status]))
      expect(statuses).toEqual({ [actors.whBranch.id]: "SENT", [actors.whCity.id]: "SKIPPED" })
    })
  })

  describe("the warehouse's notification list", () => {
    it("refuses an unauthenticated caller and every other role", async () => {
      expect((await listNotices(null)).status).toBe(401)
      for (const key of ["superAdmin", "branchAdmin", "raiser"]) {
        expect((await listNotices(actors[key])).status, key).toBe(403)
        signIn(actors[key])
        expect((await notificationsRoute.PATCH(request("http://localhost/api/v1/warehouse/notifications", "PATCH", { action: "mark-all-read" }))).status, key).toBe(403)
      }
    })

    it("lists only the caller's own notices, links only orders in its queue, and marks them read", async () => {
      const pending = await place({ organizationId: orgA, branchId: branchA1, status: "PENDING" })
      const approved = await place({ organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
      await queueWarehouseOrderNotifications(db, { order: pending, event: "CREATED" })
      await queueWarehouseOrderNotifications(db, { order: approved, event: "APPROVED" })

      const { status, body } = await listNotices(actors.whBranch)
      expect(status).toBe(200)
      const mine = body.items.filter((item: { message: string }) => item.message.includes(pending.tid) || item.message.includes(approved.tid))
      expect(mine).toHaveLength(2)
      const byEvent = Object.fromEntries(mine.map((item: { event: string; href: string | null }) => [item.event, item.href]))
      expect(byEvent).toEqual({ CREATED: null, APPROVED: "/warehouse#orders" })
      expect(body.unreadCount).toBeGreaterThanOrEqual(2)

      // whOther serves only A2 and sees none of A1's notices.
      const other = await listNotices(actors.whOther)
      expect(other.body.items.some((item: { message: string }) => item.message.includes(approved.tid))).toBe(false)

      signIn(actors.whBranch)
      expect((await notificationsRoute.PATCH(request("http://localhost/api/v1/warehouse/notifications", "PATCH", { action: "delete" }))).status).toBe(400)
      signIn(actors.whBranch)
      expect((await notificationsRoute.PATCH(request("http://localhost/api/v1/warehouse/notifications", "PATCH", { action: "mark-all-read" }))).status).toBe(200)
      expect((await listNotices(actors.whBranch)).body.unreadCount).toBe(0)
      // whCity's copies are untouched by whBranch reading its own.
      expect((await listNotices(actors.whCity)).body.unreadCount).toBeGreaterThan(0)
    })

    it("drops a branch's notices once the branch is withdrawn", async () => {
      const order = await place({ organizationId: orgA, branchId: branchA2, status: "PENDING" })
      await queueWarehouseOrderNotifications(db, { order, event: "CREATED" })
      expect((await listNotices(actors.whOther)).body.items.some((item: { message: string }) => item.message.includes(order.tid))).toBe(true)

      await db.delete(warehouseAssignments).where(eq(warehouseAssignments.userId, actors.whOther.id))
      const after = await listNotices(actors.whOther)
      expect(after.body).toEqual({ items: [], unreadCount: 0 })
    })
  })
})
