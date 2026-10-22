import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { randomUUID } from "node:crypto"
import { and, eq, inArray, or } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import sharp from "sharp"

import * as attachmentsRoute from "@/app/api/v1/support/attachments/route"
import * as statsRoute from "@/app/api/v1/support/stats/route"
import * as messagesRoute from "@/app/api/v1/support/threads/[id]/messages/route"
import * as threadRoute from "@/app/api/v1/support/threads/[id]/route"
import * as threadsRoute from "@/app/api/v1/support/threads/route"
import {
  auditLogs,
  branches,
  emailOutbox,
  notifications,
  orders,
  organizations,
  roles,
  supportAttachments,
  supportThreads,
  systemLogs,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { deliverClaimedSupportEmail } from "@/lib/server/support-notifications"

import { hasTestDatabase } from "./helpers/support-fixtures"

/**
 * The warehouse's support queue (plans/OF-WAREHOUSE-support-queue.md), end to
 * end against real rows: the routes called directly as each person, with only
 * identity, rate limiting, S3 and the mail provider faked.
 *
 * ```text
 * Org A   A1 Lahore    ← W, by branch        threads tA1 (raised there), tHoOrderA1 (Head Office, cites order A1)
 *         A2 Multan    ← W, by city          thread  tA2
 *         A3 Karachi   (nobody)              threads tA3, tHoOrderA3 (cites order A3); tHoPlain (Head Office, no order)
 * Org B   B1 Quetta    ← W2, by branch       thread  tB1
 * ```
 *
 * W must read exactly tA1, tA2 and tHoOrderA1, be mailed for exactly those,
 * and act on nothing else.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/server/order-notifications", () => ({
  attemptImmediateEmailDelivery: vi.fn(async () => undefined),
}))
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return { ...actual, isImageStorageConfigured: () => true, putImage: vi.fn(async () => undefined), getImage: vi.fn() }
})
vi.mock("@/lib/email/support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email/support")>()
  return { ...actual, sendSupportEmail: vi.fn(async () => "provider-message-id") }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { ...actor, mustChangePassword: false } } as any)
}

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function parseBody(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function read(response: Response): Promise<{ status: number; body: any }> {
  return { status: response.status, body: parseBody(await response.text()) }
}

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const listThreads = (search = "") => threadsRoute.GET(new NextRequest(`http://localhost/api/v1/support/threads${search}`)).then(read)
const getThread = (id: number) => threadRoute.GET(jsonRequest(`/api/v1/support/threads/${id}`, "GET"), params(id)).then(read)
const patchThread = (id: number, body: unknown) =>
  threadRoute.PATCH(jsonRequest(`/api/v1/support/threads/${id}`, "PATCH", body), params(id)).then(read)
const postMessage = (id: number, message: string) =>
  messagesRoute.POST(jsonRequest(`/api/v1/support/threads/${id}/messages`, "POST", { message }), params(id)).then(read)
const raise = (body: Record<string, unknown>) =>
  threadsRoute.POST(jsonRequest("/api/v1/support/threads", "POST", { category: "OTHER", message: "Please help.", ...body })).then(read)

async function upload(threadId?: number) {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).png().toBuffer()
  const form = new FormData()
  form.append("file", new File([new Uint8Array(png)], "screen.png", { type: "image/png" }))
  if (threadId !== undefined) form.append("threadId", String(threadId))
  return attachmentsRoute.POST(new NextRequest("http://localhost/api/v1/support/attachments", { method: "POST", body: form })).then(read)
}

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by the warehouse support test" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("the warehouse's support queue", () => {
  const suffix = randomUUID().slice(0, 8)
  const city = `ITWS Multan ${suffix}`
  const org = { a: 0, b: 0 }
  const branch = { a1: 0, a2: 0, a3: 0, b1: 0 }
  const order = { a1: 0, a3: 0 }
  const thread = { a1: 0, a2: 0, a3: 0, hoOrderA1: 0, hoOrderA3: 0, hoPlain: 0, b1: 0 }
  const people: Record<string, Actor> = {}
  const userIds: string[] = []

  const W = () => people.warehouse
  const W2 = () => people.warehouseB
  const inReach = () => [thread.a1, thread.a2, thread.hoOrderA1]
  const outOfReach = () => [thread.a3, thread.hoOrderA3, thread.hoPlain, thread.b1]

  beforeAll(async () => {
    const [a] = await db.insert(organizations).values({ name: `ITWS Org A ${suffix}`, code: `ITWSA${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `ITWS Org B ${suffix}`, code: `ITWSB${suffix}` }).returning({ id: organizations.id })
    org.a = a.id
    org.b = b.id

    const [a1, a2, a3, b1] = await db.insert(branches).values([
      { organizationId: org.a, name: `ITWS A1 ${suffix}`, city: `ITWS Lahore ${suffix}`, status: "active" },
      // Spelt differently from the assignment: the city key normalises both.
      { organizationId: org.a, name: `ITWS A2 ${suffix}`, city: `  ${city.toUpperCase()} `, status: "active" },
      { organizationId: org.a, name: `ITWS A3 ${suffix}`, city: `ITWS Karachi ${suffix}`, status: "active" },
      { organizationId: org.b, name: `ITWS B1 ${suffix}`, city: `ITWS Quetta ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    branch.a1 = a1.id
    branch.a2 = a2.id
    branch.a3 = a3.id
    branch.b1 = b1.id

    const person = async (key: string, role: string, organizationId: number | null, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `itws-${key}-${suffix}@example.test`,
        username: `itws-${key}-${suffix}`,
        passwordHash: "x",
        roleId: await roleId(role),
        organizationId,
        branchId,
        fullName: `ITWS ${key}`,
      }).returning({ id: users.id })
      userIds.push(row.id)
      people[key] = { id: row.id, role, organizationId, branchId }
    }
    await person("warehouse", "WAREHOUSE", null, null)
    await person("warehouseB", "WAREHOUSE", null, null)
    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("opA1", "ORDER_PORTAL", org.a, branch.a1)
    await person("opA2", "ORDER_PORTAL", org.a, branch.a2)
    await person("opA3", "ORDER_PORTAL", org.a, branch.a3)
    await person("hoA", "HEAD_OFFICE", org.a, null)
    await person("opB1", "ORDER_PORTAL", org.b, branch.b1)

    await db.insert(warehouseAssignments).values([
      { userId: W().id, branchId: branch.a1 },
      { userId: W2().id, branchId: branch.b1 },
    ])
    await db.insert(warehouseCityAssignments).values({ userId: W().id, cityKey: city.toLowerCase() })
    await db.insert(warehouseCityOrganizations).values({ userId: W().id, organizationId: org.a })

    const place = async (tid: string, branchId: number, createdByUserId: string) => {
      const [row] = await db.insert(orders).values({
        tid,
        organizationId: org.a,
        branchId,
        createdByUserId,
        createdByRole: "ORDER_PORTAL",
        status: "APPROVED",
        fulfillmentStatus: "NOT_STARTED",
        approvedAt: new Date(),
        subtotalCents: 1000,
        totalCents: 1000,
        budgetTracked: false,
      }).returning({ id: orders.id })
      return row.id
    }
    order.a1 = await place(`ITWS${suffix}A1`, branch.a1, people.opA1.id)
    order.a3 = await place(`ITWS${suffix}A3`, branch.a3, people.opA3.id)

    // Raised through the route, as the customers would, so the notifications
    // queued with each are the real ones.
    const raiseAs = async (key: string, subject: string, orderId?: number) => {
      signIn(people[key])
      const created = await raise({ subject: `${subject} ${suffix}`, ...(orderId ? { orderId } : {}) })
      expect(created.status, `${key} raises ${subject}`).toBe(201)
      return created.body.id as number
    }
    thread.a1 = await raiseAs("opA1", "at A1")
    thread.a2 = await raiseAs("opA2", "at A2")
    thread.a3 = await raiseAs("opA3", "at A3")
    thread.hoOrderA1 = await raiseAs("hoA", "about order A1", order.a1)
    thread.hoOrderA3 = await raiseAs("hoA", "about order A3", order.a3)
    thread.hoPlain = await raiseAs("hoA", "organization-wide")
    thread.b1 = await raiseAs("opB1", "at B1")
  })

  afterAll(async () => {
    if (!org.a) return
    const organizationIds = [org.a, org.b]
    const threadIds = Object.values(thread).filter((id) => id > 0)
    if (threadIds.length > 0) {
      await db.delete(emailOutbox).where(inArray(emailOutbox.supportThreadId, threadIds))
      await db.delete(notifications).where(inArray(notifications.supportThreadId, threadIds))
    }
    await db.delete(supportThreads).where(inArray(supportThreads.organizationId, organizationIds))
    await db.delete(supportAttachments).where(inArray(supportAttachments.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(warehouseAssignments).where(inArray(warehouseAssignments.userId, userIds))
    await db.delete(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, userIds))
    await db.delete(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, userIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, userIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, userIds)))
    await db.delete(users).where(inArray(users.id, userIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  const ourThreads = (body: any): number[] =>
    body.items.map((item: any) => item.id as number).filter((id: number) => Object.values(thread).includes(id)).sort((x: number, y: number) => x - y)
  const sorted = (values: number[]) => [...values].sort((x, y) => x - y)

  it("lists the threads at its branches — by branch or by city — and those citing an order there, nothing else", async () => {
    signIn(W())
    const listed = await listThreads("?pageSize=50")
    expect(listed.status).toBe(200)
    expect(ourThreads(listed.body)).toEqual(sorted(inReach()))
    // Every row it was given is one of its own, not only the ones this test planted.
    expect(listed.body.total).toBe(3)
  })

  it("cannot narrow its way into a tenant it does not serve", async () => {
    signIn(W())
    const narrowed = await listThreads(`?organizationId=${org.b}`)
    expect(narrowed.status).toBe(200)
    expect(narrowed.body.items).toEqual([])
    expect(narrowed.body.total).toBe(0)
  })

  it("counts the KPI figures over the same threads", async () => {
    signIn(W())
    const stats = await statsRoute.GET().then(read)
    expect(stats.status).toBe(200)
    expect(stats.body.total).toBe(3)
    expect(stats.body.open).toBe(3)
  })

  it("opens a thread in reach on Apricart's side, and answers 404 for every other", async () => {
    signIn(W())
    for (const id of inReach()) {
      const opened = await getThread(id)
      expect(opened.status, String(id)).toBe(200)
      expect(opened.body.viewer).toMatchObject({ side: "APRICART", canManage: true })
    }
    for (const id of outOfReach()) {
      expect((await getThread(id)).status, String(id)).toBe(404)
    }
  })

  it("replies as Apricart in reach, and cannot reply outside it", async () => {
    signIn(W())
    const replied = await postMessage(thread.a1, "We are checking the delivery.")
    expect(replied.status).toBe(201)
    expect(replied.body.status).toBe("AWAITING_CUSTOMER")
    for (const id of outOfReach()) {
      expect((await postMessage(id, "Not mine.")).status, String(id)).toBe(404)
    }
  })

  it("triages in reach, is never made the assignee, and touches nothing outside", async () => {
    signIn(W())
    expect((await patchThread(thread.a2, { priority: "HIGH", assignedToUserId: W().id })).status).toBe(200)
    const [row] = await db
      .select({ priority: supportThreads.priority, assignedToUserId: supportThreads.assignedToUserId })
      .from(supportThreads)
      .where(eq(supportThreads.id, thread.a2))
    expect(row).toEqual({ priority: "HIGH", assignedToUserId: null })

    expect((await patchThread(thread.hoOrderA1, { status: "RESOLVED" })).status).toBe(200)
    for (const id of outOfReach()) {
      expect((await patchThread(id, { status: "CLOSED" })).status, String(id)).toBe(404)
    }
    const untouched = await db.select({ status: supportThreads.status }).from(supportThreads).where(inArray(supportThreads.id, outOfReach()))
    expect(untouched.every((entry) => entry.status === "OPEN")).toBe(true)
  })

  it("raises no thread, and uploads only to a thread in reach", async () => {
    signIn(W())
    expect((await raise({ subject: `warehouse raise ${suffix}` })).status).toBe(403)
    expect((await upload()).status).toBe(403)
    expect((await upload(thread.a3)).status).toBe(404)
    const uploaded = await upload(thread.a1)
    expect(uploaded.status).toBe(201)
  })

  it("is mailed for the threads it serves only, and given no bell row", async () => {
    const opened = await db
      .select({ threadId: emailOutbox.supportThreadId, recipient: emailOutbox.recipientUserId })
      .from(emailOutbox)
      .where(and(
        inArray(emailOutbox.supportThreadId, Object.values(thread)),
        eq(emailOutbox.template, "SUPPORT_THREAD_OPENED"),
      ))
    const mailed = (userId: string) => sorted(opened.filter((row) => row.recipient === userId).map((row) => row.threadId as number))

    expect(mailed(W().id)).toEqual(sorted(inReach()))
    expect(mailed(W2().id)).toEqual([thread.b1])
    // The whole queue is still mailed for every thread.
    expect(mailed(people.superAdmin.id)).toEqual(sorted(Object.values(thread)))

    const bell = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(inArray(notifications.userId, [W().id, W2().id]), inArray(notifications.supportThreadId, Object.values(thread))))
    expect(bell).toEqual([])
  })

  it("is re-checked at send time: a branch withdrawn since queueing is not mailed", async () => {
    const queued = async (threadId: number) => {
      const [row] = await db
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.supportThreadId, threadId), eq(emailOutbox.recipientUserId, W().id), eq(emailOutbox.template, "SUPPORT_THREAD_OPENED")))
      return { ...row, attempts: 1 }
    }

    expect(await deliverClaimedSupportEmail(await queued(thread.hoOrderA1))).toBe("sent")

    await db.delete(warehouseAssignments).where(and(eq(warehouseAssignments.userId, W().id), eq(warehouseAssignments.branchId, branch.a1)))
    expect(await deliverClaimedSupportEmail(await queued(thread.a1))).toBe("skipped")
    // The city assignment still covers A2.
    expect(await deliverClaimedSupportEmail(await queued(thread.a2))).toBe("sent")

    signIn(W())
    expect(ourThreads((await listThreads("?pageSize=50")).body)).toEqual([thread.a2])
    expect((await getThread(thread.a1)).status).toBe(404)
    await db.insert(warehouseAssignments).values({ userId: W().id, branchId: branch.a1 })
  })

  it("reads nothing once deactivated, whatever is still assigned", async () => {
    await db.update(users).set({ isActive: false }).where(eq(users.id, W2().id))
    signIn(W2())
    const listed = await listThreads()
    expect(listed.status).toBe(200)
    expect(listed.body.items).toEqual([])
    expect((await getThread(thread.b1)).status).toBe(404)
  })

  it("leaves Super Admin's whole queue as it was", async () => {
    signIn(people.superAdmin)
    const listed = await listThreads("?pageSize=50")
    for (const id of Object.values(thread)) {
      expect(listed.body.items.some((item: any) => item.id === id), String(id)).toBe(true)
    }
  })
})
