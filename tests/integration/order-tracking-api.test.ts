import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as trackingRoute from "@/app/api/v1/order-tracking/route"
import * as recentRoute from "@/app/api/v1/order-tracking/recent/route"
import { auditLogs, branches, orderItems, orders, organizationSettings, roles, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { HIDE_ORDER_PORTAL_PRICES_SETTING_KEY } from "@/lib/price-visibility"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The requester order tracker (plans/OF-TRACKING-requester-order-tracking.md)
 * against Postgres. On top of the shared group-role fixture this adds:
 *
 *   Alpha North  ORDER_PORTAL "initiator" — own APPROVED order, IN_PROCESS,
 *                with an audit row dating the step
 *   Alpha North  ORDER_PORTAL "colleague" — own PENDING order
 *   Gamma        a branch of tenant A assigned to nobody, with an order
 *
 * Who may track an order must be exactly who may read it on the order page.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => {}),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

async function track(reference: string) {
  const response = await trackingRoute.GET(
    new NextRequest(`http://localhost/api/v1/order-tracking?reference=${encodeURIComponent(reference)}`),
  )
  return { status: response.status, body: await response.json() }
}

async function recent() {
  const response = await recentRoute.GET()
  return { status: response.status, body: await response.json() }
}

async function roleId(name: string) {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (row) return row.id
  const [created] = await db.insert(roles).values({ name, description: "order tracking tests" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("GET /api/v1/order-tracking", () => {
  let f: GroupRoleFixtures
  let initiatorId: string
  let colleagueId: string
  let gammaBranchId: number
  let ownOrder: { id: number; tid: string }
  let colleagueOrder: { id: number; tid: string }
  let gammaOrder: { id: number; tid: string }
  const extraOrderIds: number[] = []

  const actor = (id: string, role: string, organizationId: number | null = f.organizationId): Actor => ({
    id, email: `${role.toLowerCase()}-${f.suffix}@example.test`, role, organizationId,
  })

  async function person(label: string, role: string, branchId: number | null) {
    const [row] = await db.insert(users).values({
      email: `it-tracking-${label}-${f.suffix}@example.test`,
      username: `it-tracking-${label}-${f.suffix}`,
      passwordHash: "not-a-real-hash",
      roleId: await roleId(role),
      organizationId: f.organizationId,
      branchId,
      firstName: label,
      lastName: f.suffix,
      fullName: `${label} ${f.suffix}`,
    }).returning({ id: users.id })
    return row.id
  }

  async function order(key: string, values: Partial<typeof orders.$inferInsert> & { branchId: number; createdByUserId: string }) {
    const [row] = await db.insert(orders).values({
      tid: `ittrk${key}${f.suffix}`.toLowerCase().slice(0, 26),
      organizationId: f.organizationId,
      status: "PENDING",
      subtotalCents: 12_345,
      taxCents: 0,
      totalCents: 12_345,
      ...values,
    }).returning({ id: orders.id, tid: orders.tid })
    extraOrderIds.push(row.id)
    await db.insert(orderItems).values({
      organizationId: f.organizationId,
      orderId: row.id,
      globalProductId: f.productId,
      productName: `Tracked product ${key}`,
      productCode: `TRK-${key}`,
      unit: "kg",
      quantity: 1.5,
      priceCents: 8_230,
    })
    return row
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
    f = await createGroupRoleFixtures()
    initiatorId = await person("initiator", "ORDER_PORTAL", f.alphaNorthId)
    colleagueId = await person("colleague", "ORDER_PORTAL", f.alphaNorthId)
    const [gamma] = await db.insert(branches).values({
      organizationId: f.organizationId,
      name: `Gamma ${f.suffix}`,
      status: "active",
    }).returning({ id: branches.id })
    gammaBranchId = gamma.id

    ownOrder = await order("own", {
      branchId: f.alphaNorthId,
      createdByUserId: initiatorId,
      status: "APPROVED",
      fulfillmentStatus: "IN_PROCESS",
      paymentStatus: "UNPAID",
      approvedAt: new Date("2026-10-02T05:00:00.000Z"),
      approvedByUserId: f.headOfficeId,
    })
    await db.insert(auditLogs).values({
      userId: f.superAdminId,
      organizationId: f.organizationId,
      branchId: f.alphaNorthId,
      action: "ORDER_FULFILLMENT_STATUS_UPDATE",
      entity: "Order",
      entityId: String(ownOrder.id),
      metadata: { tid: ownOrder.tid, from: "NOT_STARTED", to: "IN_PROCESS", actorRole: "SUPER_ADMIN" },
      createdAt: new Date("2026-10-03T05:00:00.000Z"),
    })
    colleagueOrder = await order("colleague", { branchId: f.alphaNorthId, createdByUserId: colleagueId })
    gammaOrder = await order("gamma", { branchId: gammaBranchId, createdByUserId: f.headOfficeId })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await db.delete(organizationSettings).where(eq(organizationSettings.organizationId, f.organizationId))
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, extraOrderIds.map(String)))
    await db.delete(orderItems).where(inArray(orderItems.orderId, extraOrderIds))
    await db.delete(orders).where(inArray(orders.id, extraOrderIds))
    extraOrderIds.length = 0
    await db.delete(branches).where(eq(branches.id, gammaBranchId))
    await destroyGroupRoleFixtures(f, [initiatorId, colleagueId])
  })

  afterAll(async () => {
    await closePool()
  })

  it("refuses an unauthenticated caller with 401 and every non-requester role with 403", async () => {
    signIn(null)
    expect((await track(ownOrder.tid)).status).toBe(401)
    expect((await recent()).status).toBe(401)

    for (const [id, role] of [
      [f.headOfficeId, "HEAD_OFFICE"],
      [f.approverId, "GROUP_USER"],
      [f.superAdminId, "SUPER_ADMIN"],
    ] as const) {
      signIn(actor(id, role, role === "SUPER_ADMIN" ? null : f.organizationId))
      expect((await track(ownOrder.tid)).status, role).toBe(403)
      expect((await recent()).status, role).toBe(403)
    }
  })

  it("tracks the initiator's own order by transaction id, upper-cased id or order id", async () => {
    signIn(actor(initiatorId, "ORDER_PORTAL"))

    for (const reference of [ownOrder.tid, ownOrder.tid.toUpperCase(), String(ownOrder.id), `#${ownOrder.id}`]) {
      const { status, body } = await track(reference)
      expect(status, reference).toBe(200)
      expect(body.item.id).toBe(ownOrder.id)
    }

    const { body } = await track(ownOrder.tid)
    expect(body.item).toMatchObject({
      tid: ownOrder.tid,
      status: "APPROVED",
      fulfillmentStatus: "IN_PROCESS",
      paymentStatus: "UNPAID",
      branchName: f.names.alphaNorth,
      approvedAt: "2026-10-02T05:00:00.000Z",
      inProcessAt: "2026-10-03T05:00:00.000Z",
      outForDeliveryAt: null,
      totalCents: 12_345,
      isGroupOrder: false,
      items: [{ productName: "Tracked product own", productCode: "TRK-own", unit: "kg", quantity: 1.5 }],
    })
    // No person and no internal key crosses to the requester.
    for (const key of ["createdByUserId", "approvedByUserId", "approvalToken", "approvalTokenHash", "organizationId"]) {
      expect(body.item, key).not.toHaveProperty(key)
    }
    expect(body.item.items[0]).not.toHaveProperty("priceCents")
  })

  it("lets the initiator track its branch's group orders but never a colleague's or another raiser's order", async () => {
    signIn(actor(initiatorId, "ORDER_PORTAL"))

    const group = await track(String(f.alphaNorthOrderId))
    expect(group.status).toBe(200)
    expect(group.body.item.isGroupOrder).toBe(true)

    const notFound = (await track(colleagueOrder.tid)).body.error
    expect((await track(colleagueOrder.tid)).status).toBe(404)
    expect((await track(String(f.ordinaryOrderId))).status).toBe(404)
    // A group order at another branch of the same tenant.
    expect((await track(String(f.alphaSouthOrderId))).status).toBe(404)
    // Not found and not yours read the same.
    expect((await track("999999999")).body.error).toBe(notFound)
  })

  it("never resolves another tenant's order, by id or by transaction id", async () => {
    signIn(actor(initiatorId, "ORDER_PORTAL"))
    expect((await track(String(f.foreignOrderId))).status).toBe(404)
    const [foreign] = await db.select({ tid: orders.tid }).from(orders).where(eq(orders.id, f.foreignOrderId))
    expect((await track(foreign.tid)).status).toBe(404)
  })

  it("lets the group initiator track any order at an assigned branch and nothing beyond its assignments", async () => {
    signIn(actor(f.requesterId, "GROUP_ORDER_PORTAL"))

    expect((await track(String(f.alphaSouthOrderId))).status).toBe(200)
    expect((await track(String(f.betaOrderId))).status).toBe(200)
    // Raised by Head Office at an assigned branch: readable on the order page, so trackable.
    expect((await track(String(f.ordinaryOrderId))).status).toBe(200)
    expect((await track(colleagueOrder.tid)).status).toBe(200)

    // A branch of its own tenant it is not assigned to.
    expect((await track(gammaOrder.tid)).status).toBe(404)
    // The stale assignment to another tenant's branch grants nothing.
    expect((await track(String(f.foreignOrderId))).status).toBe(404)
  })

  it("refuses a malformed reference with 400 before querying", async () => {
    signIn(actor(initiatorId, "ORDER_PORTAL"))
    for (const reference of ["", "   ", "1;DROP", "a".repeat(65), "%27"]) {
      expect((await track(reference)).status, reference).toBe(400)
    }
  })

  it("withholds the order total when the organization hides prices from the role", async () => {
    await db.insert(organizationSettings).values({
      organizationId: f.organizationId,
      key: HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
      value: true,
    })
    signIn(actor(initiatorId, "ORDER_PORTAL"))
    const { status, body } = await track(ownOrder.tid)
    expect(status).toBe(200)
    expect(body.item.totalCents).toBeNull()
  })

  it("lists recent orders inside each role's own reach only", async () => {
    signIn(actor(initiatorId, "ORDER_PORTAL"))
    const mine = await recent()
    expect(mine.status).toBe(200)
    expect(mine.body.items.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b))
      .toEqual([f.alphaNorthOrderId, ownOrder.id].sort((a, b) => a - b))
    expect(mine.body.items[0]).not.toHaveProperty("totalCents")

    signIn(actor(f.requesterId, "GROUP_ORDER_PORTAL"))
    const group = await recent()
    expect(group.body.items.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b))
      .toEqual([f.alphaNorthOrderId, f.alphaSouthOrderId, f.betaOrderId].sort((a, b) => a - b))
  })
})
