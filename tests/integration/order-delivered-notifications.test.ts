import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as progressRoute from "@/app/api/v1/warehouse/orders/[id]/progress/route"
import * as notificationsRoute from "@/app/api/v1/notifications/route"
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
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { processOrderEmailOutbox, queueOrderDeliveredNotifications } from "@/lib/server/order-notifications"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"
import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * "Your order was delivered — please acknowledge" against Postgres.
 * See plans/OF-NOTIFY-order-delivered-acknowledge.md.
 *
 * Identity, headers, the rate limiter and the mail provider are faked; the
 * delivery route, the queueing, the outbox and every constraint are real.
 *
 * ```text
 * Tenant A                                   Tenant B
 *   A1 ← raiser (Order Initiator)              B1 ← outsider (Financial Approver)
 *      ← approver (Financial Approver)
 *      ← warehouse
 *   A2 ← movedApprover (was A1's approver)
 *   headOffice
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

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by delivered-notification tests" }).returning({ id: roles.id })
  return created.id
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!hasTestDatabase)("order delivered — acknowledge notifications", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchB1: number
  let productId: number
  let placed = 0

  const place = async (values: {
    approvedByUserId?: string | null
    createdByRole?: string
    fulfillmentStatus?: string
    tokenHandoffAt?: Date
    organizationId?: number
    branchId?: number
  } = {}) => {
    placed += 1
    const organizationId = values.organizationId ?? orgA
    const [row] = await db.insert(orders).values({
      tid: `OD${suffix}${placed}`.slice(0, 26),
      organizationId,
      branchId: values.branchId ?? branchA1,
      createdByUserId: actors.raiser.id,
      createdByRole: values.createdByRole ?? "ORDER_PORTAL",
      status: "APPROVED",
      approvedAt: new Date(),
      approvedByUserId: values.approvedByUserId === undefined ? actors.approver.id : values.approvedByUserId,
      fulfillmentStatus: values.fulfillmentStatus ?? "OUT_FOR_DELIVERY",
      tokenHandoffAt: values.tokenHandoffAt ?? null,
      subtotalCents: 71_000,
      taxCents: 1_000,
      totalCents: 71_000,
      budgetTracked: false,
    }).returning({ id: orders.id, tid: orders.tid })
    await db.insert(orderItems).values({
      orderId: row.id, organizationId, globalProductId: productId, productName: "Rice", productCode: "RICE", unit: "kg", quantity: 1, priceCents: 71_000, taxCents: 1_000,
    })
    return row
  }

  const deliver = async (orderId: number) => {
    signIn(actors.warehouse)
    return progressRoute.POST(
      request(`http://localhost/api/v1/warehouse/orders/${orderId}/progress`, "POST", { fulfillmentStatus: "DELIVERED" }),
      params(orderId),
    )
  }

  const noticesFor = async (orderId: number) => db
    .select({ userId: notifications.userId, targetRole: notifications.targetRole, message: notifications.message })
    .from(notifications)
    .where(and(eq(notifications.orderId, orderId), eq(notifications.type, "ORDER_DELIVERED")))

  const outboxFor = async (orderId: number) => db
    .select({ recipientUserId: emailOutbox.recipientUserId, recipientRole: emailOutbox.recipientRole, status: emailOutbox.status, eventKey: emailOutbox.eventKey })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.orderId, orderId), eq(emailOutbox.template, "ORDER_DELIVERED")))

  beforeAll(async () => {
    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "WAREHOUSE",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT OD A ${suffix}`, code: `ITODA_${suffix}`, orderApproverRole: "BRANCH_ADMIN" }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT OD B ${suffix}`, code: `ITODB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id
    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: orgA, name: `IT OD A1 ${suffix}`, status: "active" },
      { organizationId: orgA, name: `IT OD A2 ${suffix}`, status: "active" },
      { organizationId: orgB, name: `IT OD B1 ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchB1 = b1.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-od-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-od-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`, isActive: true,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("raiser", "ORDER_PORTAL", orgA, branchA1)
    await person("approver", "BRANCH_ADMIN", orgA, branchA1)
    await person("movedApprover", "BRANCH_ADMIN", orgA, branchA2)
    await person("headOffice", "HEAD_OFFICE", orgA, null)
    await person("outsider", "BRANCH_ADMIN", orgB, branchB1)
    await person("warehouse", "WAREHOUSE", null, null)

    await db.insert(warehouseAssignments).values([
      { userId: actors.warehouse.id, branchId: branchA1, createdByUserId: actors.superAdmin.id },
      { userId: actors.warehouse.id, branchId: branchB1, createdByUserId: actors.superAdmin.id },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITOD-${suffix}`, name: `IT OD Rice ${suffix}`, basePrice: 71_000, status: "active", unit: "kg", stockQuantity: 100,
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

  it("asks the raiser and the approver to acknowledge, in-app and by email, when the delivery is recorded", async () => {
    const order = await place()
    expect((await deliver(order.id)).status).toBe(200)

    const notices = await noticesFor(order.id)
    expect(notices.map((row) => [row.userId, row.targetRole]).sort()).toEqual([
      [actors.raiser.id, "ORDER_PORTAL"],
      [actors.approver.id, "BRANCH_ADMIN"],
    ].sort())
    expect(notices.every((row) => row.message.includes("acknowledge"))).toBe(true)

    expect(sent.map((mail) => mail.to).sort()).toEqual([actors.raiser.email, actors.approver.email].sort())
    expect(sent.every((mail) => mail.subject === `Order ${order.tid} was delivered — please acknowledge`)).toBe(true)
    const toRaiser = sent.find((mail) => mail.to === actors.raiser.email)
    const toApprover = sent.find((mail) => mail.to === actors.approver.email)
    expect(toRaiser?.text).toContain("/shop")
    expect(toApprover?.text).toContain(`/orders/${order.id}`)
    expect((await outboxFor(order.id)).every((row) => row.status === "SENT")).toBe(true)
  })

  it("shows the notice in each recipient's own notification list", async () => {
    const order = await place()
    expect((await deliver(order.id)).status).toBe(200)

    signIn(actors.raiser)
    const forRaiser = await (await notificationsRoute.GET()).json()
    const raiserItem = forRaiser.items.find((item: { message: string }) => item.message.includes(order.tid))
    expect(raiserItem?.title).toBe("Order delivered — please acknowledge")

    signIn(actors.outsider)
    const forOutsider = await (await notificationsRoute.GET()).json()
    expect(forOutsider.items.some((item: { message: string }) => item.message.includes(order.tid))).toBe(false)
  })

  it("tells Head Office when Head Office approved it", async () => {
    const order = await place({ approvedByUserId: actors.headOffice.id })
    expect((await deliver(order.id)).status).toBe(200)
    expect((await noticesFor(order.id)).map((row) => row.userId).sort())
      .toEqual([actors.raiser.id, actors.headOffice.id].sort())
  })

  it("tells only the raiser for an order approved at creation", async () => {
    const order = await place({ approvedByUserId: null })
    expect((await deliver(order.id)).status).toBe(200)
    expect((await noticesFor(order.id)).map((row) => row.userId)).toEqual([actors.raiser.id])
  })

  it("does not tell an approver who no longer reaches the branch", async () => {
    const order = await place({ approvedByUserId: actors.movedApprover.id })
    expect((await deliver(order.id)).status).toBe(200)
    expect((await noticesFor(order.id)).map((row) => row.userId)).toEqual([actors.raiser.id])
  })

  it("tells no one when the token was already handed over, because the delivery fulfils the order", async () => {
    const order = await place({ tokenHandoffAt: new Date() })
    const response = await deliver(order.id)
    expect(response.status).toBe(200)
    expect((await response.json()).fulfilled).toBe(true)
    expect(await noticesFor(order.id)).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it("tells no one about an Order Desk order", async () => {
    const order = await place({ createdByRole: "ORDER_DESK" })
    expect((await deliver(order.id)).status).toBe(200)
    expect(await noticesFor(order.id)).toHaveLength(0)
  })

  it("queues nothing for a stage before delivery", async () => {
    const order = await place({ fulfillmentStatus: "IN_PROCESS" })
    signIn(actors.warehouse)
    const moved = await progressRoute.POST(
      request(`http://localhost/api/v1/warehouse/orders/${order.id}/progress`, "POST", { fulfillmentStatus: "OUT_FOR_DELIVERY" }),
      params(order.id),
    )
    expect(moved.status).toBe(200)
    expect(await noticesFor(order.id)).toHaveLength(0)
  })

  it("queues each recipient once, and nothing when the delivery rolls back", async () => {
    const order = await place({ fulfillmentStatus: "DELIVERED" })
    await queueOrderDeliveredNotifications(db, { orderId: order.id })
    await queueOrderDeliveredNotifications(db, { orderId: order.id })
    expect(await noticesFor(order.id)).toHaveLength(2)

    const other = await place({ fulfillmentStatus: "DELIVERED" })
    await expect(db.transaction(async (tx) => {
      await queueOrderDeliveredNotifications(tx, { orderId: other.id })
      throw new Error("rolled back")
    })).rejects.toThrow("rolled back")
    expect(await noticesFor(other.id)).toHaveLength(0)
    expect(await outboxFor(other.id)).toHaveLength(0)
  })

  it("does not send the email once the order has been acknowledged", async () => {
    const order = await place({ fulfillmentStatus: "DELIVERED" })
    const queued = await queueOrderDeliveredNotifications(db, { orderId: order.id })
    expect(queued.recipientCount).toBe(2)

    await db.update(orders).set({ status: "FULFILLED", fulfilledAt: new Date() }).where(eq(orders.id, order.id))
    const result = await processOrderEmailOutbox({ eventKeys: queued.eventKeys, limit: queued.eventKeys.length })
    expect(result.skipped).toBe(2)
    expect(sent).toHaveLength(0)
  })

  it("does not send to an approver who is no longer the order's approver", async () => {
    const order = await place({ fulfillmentStatus: "DELIVERED" })
    const queued = await queueOrderDeliveredNotifications(db, { orderId: order.id })

    await db.update(orders).set({ approvedByUserId: actors.headOffice.id }).where(eq(orders.id, order.id))
    const result = await processOrderEmailOutbox({ eventKeys: queued.eventKeys, limit: queued.eventKeys.length })
    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(1)
    expect(sent.map((mail) => mail.to)).toEqual([actors.raiser.email])
  })
})
