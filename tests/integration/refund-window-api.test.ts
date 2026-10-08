import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import * as orderRefundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as adminRefundsRoute from "@/app/api/v1/admin/refunds/route"
import * as adminRefundRoute from "@/app/api/v1/admin/refunds/[id]/route"
import {
  auditLogs,
  branches,
  budgets,
  globalProducts,
  notifications,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { closePool, db } from "@/lib/db"
import { REFUND_NOT_YET_AVAILABLE_REASON, REFUND_WINDOW_CLOSED_REASON } from "@/lib/refund-window"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The refund window, end to end against Postgres
 * (`plans/OF-REFUND-seven-day-requester-window.md`).
 *
 * Every requester may ask from fulfilment until seven days after it; Super
 * Admin approves, rejects or refunds directly at any time. Only identity, the
 * rate limiter and outbound email are faked.
 *
 * ```text
 * organization A, branch A1 (budget rows below), branch A2 (no budget rows)
 *   fresh      FULFILLED+DELIVERED, fulfilled 1 day ago               -> requesters may ask
 *   lastDay    FULFILLED+DELIVERED, fulfilled 6 d 23 h ago            -> still open
 *   expired    FULFILLED+DELIVERED, fulfilled 8 days ago              -> closed for requesters
 *   approved   APPROVED, out for delivery, not fulfilled              -> not yet, for every requester
 *   crossMonth created mid last month, fulfilled 2 days ago           -> open: not a month rule
 *   old        created 3 months ago, fulfilled 2 days later, with a
 *              PENDING request raised in time                         -> Super Admin approves now
 *   oldReject  as old, PENDING request                                -> Super Admin rejects now
 *   lateDirect (A2) FULFILLED+DELIVERED, fulfilled 30 days ago        -> Super Admin refunds directly
 * organization B: a Head Office user who must never reach A's orders
 *
 * Product price 1,000 a unit; every order is 2 units = 2,000.
 * Branch A1 budget rows: last month, three months ago, this month — each
 * allocated 100,000, spent 2,000 for the month's order (0 this month).
 * ```
 */

const mocks = vi.hoisted(() => ({ sendRefundRequestEmail: vi.fn(async () => true) }))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendRefundRequestEmail: mocks.sendRefundRequestEmail,
}))

const { getServerSession } = mockedNextAuth

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const UNIT_PRICE = 1_000
const ORDER_TOTAL = 2 * UNIT_PRICE

const ago = (ms: number) => new Date(Date.now() - ms)

/** Noon UTC on the 15th, `offset` months from now: inside one UTC month in every zone. */
function midMonth(offset: number): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 15, 12))
}

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }
type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "refund window it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [orgA, orgB] = await db.insert(organizations).values([
    { name: `IT Refund Window A ${suffix}`, code: `ITRWA-${suffix}` },
    { name: `IT Refund Window B ${suffix}`, code: `ITRWB-${suffix}` },
  ]).returning({ id: organizations.id })

  const [a1, a2, b1] = await db.insert(branches).values([
    { organizationId: orgA.id, name: `A1 ${suffix}`, status: "active" },
    { organizationId: orgA.id, name: `A2 ${suffix}`, status: "active" },
    { organizationId: orgB.id, name: `B1 ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
    const [row] = await db.insert(users).values({
      email: `it-rw-${label}-${suffix}@example.test`,
      username: `it-rw-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      roleId: await roleId(role),
      organizationId,
      branchId,
      fullName: `${label} ${suffix}`,
    }).returning({ id: users.id })
    return { id: row.id, role, organizationId, branchId } satisfies Actor
  }

  const actors = {
    superAdmin: await person("super", "SUPER_ADMIN", null, null),
    headOffice: await person("head-office", "HEAD_OFFICE", orgA.id, null),
    branchAdmin: await person("branch-admin", "BRANCH_ADMIN", orgA.id, a1.id),
    orderPortal: await person("order-portal", "ORDER_PORTAL", orgA.id, a1.id),
    foreignHeadOffice: await person("foreign-ho", "HEAD_OFFICE", orgB.id, null),
    foreignOrderPortal: await person("foreign-op", "ORDER_PORTAL", orgB.id, b1.id),
  }

  const [product] = await db.insert(globalProducts).values({
    productCode: `ITRW-${suffix}`,
    name: `Paper ${suffix}`,
    basePrice: UNIT_PRICE,
    status: "active",
    unit: "ream",
  }).returning({ id: globalProducts.id })

  const order = async (input: {
    key: string
    branchId?: number
    status?: string
    fulfillmentStatus?: string
    createdAt: Date
    fulfilledAt: Date | null
  }) => {
    const status = input.status ?? "FULFILLED"
    const fulfillmentStatus = input.fulfillmentStatus ?? "DELIVERED"
    const [row] = await db.insert(orders).values({
      tid: `ITRW-${input.key}-${suffix}`,
      organizationId: orgA.id,
      branchId: input.branchId ?? a1.id,
      createdByUserId: actors.orderPortal.id,
      status,
      fulfillmentStatus,
      subtotalCents: ORDER_TOTAL,
      taxCents: 0,
      totalCents: ORDER_TOTAL,
      createdAt: input.createdAt,
      approvedAt: input.createdAt,
      deliveredAt: fulfillmentStatus === "DELIVERED" ? input.fulfilledAt : null,
      fulfilledAt: input.fulfilledAt,
    }).returning({ id: orders.id })
    const [item] = await db.insert(orderItems).values({
      organizationId: orgA.id,
      orderId: row.id,
      globalProductId: product.id,
      productName: `Paper ${suffix}`,
      unit: "ream",
      quantity: 2,
      priceCents: UNIT_PRICE,
    }).returning({ id: orderItems.id })
    return { id: row.id, itemId: item.id, createdAt: input.createdAt }
  }

  const threeMonthsAgo = midMonth(-3)
  const created = {
    fresh: await order({ key: "FRESH", createdAt: ago(2 * DAY), fulfilledAt: ago(DAY) }),
    lastDay: await order({ key: "LASTDAY", createdAt: ago(8 * DAY), fulfilledAt: ago(7 * DAY - HOUR) }),
    expired: await order({ key: "EXPIRED", createdAt: ago(10 * DAY), fulfilledAt: ago(8 * DAY) }),
    approved: await order({
      key: "APPROVED",
      status: "APPROVED",
      fulfillmentStatus: "OUT_FOR_DELIVERY",
      createdAt: ago(DAY),
      fulfilledAt: null,
    }),
    crossMonth: await order({ key: "CROSS", createdAt: midMonth(-1), fulfilledAt: ago(2 * DAY) }),
    old: await order({ key: "OLD", createdAt: threeMonthsAgo, fulfilledAt: new Date(threeMonthsAgo.getTime() + 2 * DAY) }),
    oldReject: await order({ key: "OLDREJ", createdAt: threeMonthsAgo, fulfilledAt: new Date(threeMonthsAgo.getTime() + 2 * DAY) }),
    lateDirect: await order({ key: "LATE", branchId: a2.id, createdAt: ago(32 * DAY), fulfilledAt: ago(30 * DAY) }),
  }

  const periods = {
    current: budgetPeriodOf(new Date()),
    lastMonth: budgetPeriodOf(midMonth(-1)),
    threeMonthsAgo: budgetPeriodOf(threeMonthsAgo),
  }
  await db.insert(budgets).values([
    { organizationId: orgA.id, branchId: a1.id, period: periods.current, amountAllocatedCents: 100_000 },
    { organizationId: orgA.id, branchId: a1.id, period: periods.lastMonth, amountAllocatedCents: 100_000, amountSpentCents: ORDER_TOTAL },
    // Both old orders were spent from that month's row.
    { organizationId: orgA.id, branchId: a1.id, period: periods.threeMonthsAgo, amountAllocatedCents: 100_000, amountSpentCents: 2 * ORDER_TOTAL },
  ])

  return {
    suffix,
    organizationIds: [orgA.id, orgB.id],
    orgA: orgA.id,
    branchIds: { a1: a1.id, a2: a2.id, b1: b1.id },
    actors,
    productId: product.id,
    orders: created,
    periods,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orderIds = Object.values(f.orders).map((order) => order.id)
  const userIds = Object.values(f.actors).map((actor) => actor.id)
  const refundIds = (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))).map((r) => r.id)
  if (refundIds.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundIds))
  await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
  await db.delete(notifications).where(inArray(notifications.organizationId, f.organizationIds))
  await db.delete(notifications).where(inArray(notifications.userId, userIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, f.organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds))
  await db.delete(systemLogs).where(inArray(systemLogs.userId, userIds))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  await db.delete(budgets).where(inArray(budgets.organizationId, f.organizationIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.organizationId, f.organizationIds))
  await db.delete(globalProducts).where(eq(globalProducts.id, f.productId))
  await db.delete(organizations).where(inArray(organizations.id, f.organizationIds))
}

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null
      ? null
      : ({ user: { ...actor, email: "x@example.test", fullName: "IT", mustChangePassword: false } } as any),
  )
}

const json = (url: string, method: string, body: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

type OrderFixture = { id: number; itemId: number }

const requestRefund = async (order: OrderFixture, quantity = 1) => read(await orderRefundsRoute.POST(
  json(`http://localhost/api/v1/orders/${order.id}/refunds`, "POST", {
    items: [{ id: order.itemId, quantity }],
    reason: "One ream arrived damaged",
  }),
  { params: Promise.resolve({ id: String(order.id) }) },
))

const approveAsSuperAdmin = async (order: OrderFixture, refundRequestId?: number) => read(await adminRefundsRoute.POST(
  json("http://localhost/api/v1/admin/refunds", "POST", {
    orderId: order.id,
    items: [{ itemId: order.itemId, quantity: 1 }],
    ...(refundRequestId === undefined ? {} : { refundRequestId }),
  }),
))

const cancelAsSuperAdmin = async (refundId: number) => read(await adminRefundRoute.PATCH(
  json(`http://localhost/api/v1/admin/refunds/${refundId}`, "PATCH", { action: "cancel" }),
  { params: Promise.resolve({ id: String(refundId) }) },
))

async function refundRows(orderId: number) {
  return db.select({ id: refunds.id, status: refunds.status, amountCents: refunds.amountCents, requestedByUserId: refunds.requestedByUserId })
    .from(refunds).where(eq(refunds.orderId, orderId))
}

async function budgetRow(branchId: number, period: string) {
  const [row] = await db.select().from(budgets).where(and(eq(budgets.branchId, branchId), eq(budgets.period, period)))
  return row
}

/** A PENDING request as a requester would have raised it inside the window. */
async function seedPendingRequest(f: Fixtures, order: OrderFixture): Promise<number> {
  const [row] = await db.insert(refunds).values({
    organizationId: f.orgA,
    orderId: order.id,
    amountCents: UNIT_PRICE,
    reason: "Raised inside the window",
    status: "PENDING",
    requestedByUserId: f.actors.orderPortal.id,
  }).returning({ id: refunds.id })
  await db.insert(refundItems).values({ refundId: row.id, orderItemId: order.itemId, quantity: 1, amountCents: UNIT_PRICE })
  return row.id
}

describe.skipIf(!hasTestDatabase)("refund window", () => {
  let f: Fixtures

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    const orderIds = Object.values(f.orders).map((order) => order.id)
    const refundIds = (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))).map((r) => r.id)
    if (refundIds.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundIds))
    await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
    await db.update(orders).set({ refundAmountCents: 0, status: "FULFILLED", refundedAt: null, refundedByUserId: null })
      .where(inArray(orders.id, orderIds.filter((id) => id !== f.orders.approved.id)))
    mocks.sendRefundRequestEmail.mockClear()
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  describe("access", () => {
    it("is 401 without a session", async () => {
      signIn(null)
      expect((await requestRefund(f.orders.fresh)).status).toBe(401)
      expect((await approveAsSuperAdmin(f.orders.fresh)).status).toBe(401)
    })

    it("keeps another tenant out, and says nothing about the order's state", async () => {
      for (const actor of [f.actors.foreignHeadOffice, f.actors.foreignOrderPortal]) {
        signIn(actor)
        // Both an open and a closed order answer the same 403.
        expect((await requestRefund(f.orders.fresh)).status, actor.role).toBe(403)
        expect((await requestRefund(f.orders.expired)).status, actor.role).toBe(403)
      }
      expect(await refundRows(f.orders.fresh.id)).toEqual([])
    })

    it("does not let a requester approve: the Super Admin routes stay Super Admin only", async () => {
      for (const actor of [f.actors.headOffice, f.actors.branchAdmin, f.actors.orderPortal]) {
        signIn(actor)
        expect((await approveAsSuperAdmin(f.orders.fresh)).status, actor.role).toBe(403)
      }
      const pendingId = await seedPendingRequest(f, f.orders.fresh)
      signIn(f.actors.headOffice)
      expect((await cancelAsSuperAdmin(pendingId)).status).toBe(403)
      expect((await refundRows(f.orders.fresh.id))[0].status).toBe("PENDING")
    })
  })

  describe("requesters have seven days from fulfilment", () => {
    const requesters = () => [f.actors.headOffice, f.actors.branchAdmin, f.actors.orderPortal]

    it("lets every requester ask on an order fulfilled a day ago, as a PENDING request that moves no money", async () => {
      const before = await budgetRow(f.branchIds.a1, f.periods.current)
      for (const actor of requesters()) {
        signIn(actor)
        const response = await requestRefund(f.orders.fresh)
        expect(response.status, actor.role).toBe(200)
        const rows = await refundRows(f.orders.fresh.id)
        expect(rows.find((row) => row.requestedByUserId === actor.id)?.status, actor.role).toBe("PENDING")
        // Clear it so the next requester has the same capacity.
        await db.delete(refundItems).where(inArray(refundItems.refundId, rows.map((row) => row.id)))
        await db.delete(refunds).where(eq(refunds.orderId, f.orders.fresh.id))
      }
      expect(await budgetRow(f.branchIds.a1, f.periods.current)).toMatchObject({
        amountSpentCents: before.amountSpentCents,
        amountCreditedCents: before.amountCreditedCents,
      })
    })

    it("is still open in the last hour of the seventh day", async () => {
      signIn(f.actors.orderPortal)
      expect((await requestRefund(f.orders.lastDay)).status).toBe(200)
    })

    it("is not a calendar month: an order from last month fulfilled two days ago is open", async () => {
      signIn(f.actors.orderPortal)
      expect((await requestRefund(f.orders.crossMonth)).status).toBe(200)
    })

    it("is closed to every requester eight days after fulfilment", async () => {
      for (const actor of requesters()) {
        signIn(actor)
        const response = await requestRefund(f.orders.expired)
        expect(response.status, actor.role).toBe(400)
        expect(response.body.error, actor.role).toBe(REFUND_WINDOW_CLOSED_REASON)
      }
      expect(await refundRows(f.orders.expired.id)).toEqual([])
    })

    it("is not yet open before fulfilment — Head Office and Branch Admin included", async () => {
      for (const actor of requesters()) {
        signIn(actor)
        const response = await requestRefund(f.orders.approved)
        expect(response.status, actor.role).toBe(400)
        expect(response.body.error, actor.role).toBe(REFUND_NOT_YET_AVAILABLE_REASON)
      }
      expect(await refundRows(f.orders.approved.id)).toEqual([])
    })
  })

  describe("Super Admin has no time limit", () => {
    it("approves, months later, a request raised in time, and gives it back on the order's own month", async () => {
      const pendingId = await seedPendingRequest(f, f.orders.old)
      const oldBefore = await budgetRow(f.branchIds.a1, f.periods.threeMonthsAgo)
      const currentBefore = await budgetRow(f.branchIds.a1, f.periods.current)

      signIn(f.actors.superAdmin)
      const response = await approveAsSuperAdmin(f.orders.old, pendingId)
      expect(response.status).toBe(200)

      const [refund] = await refundRows(f.orders.old.id)
      expect(refund).toMatchObject({ id: pendingId, status: "APPROVED", amountCents: UNIT_PRICE })
      const [order] = await db.select({ refundAmountCents: orders.refundAmountCents }).from(orders).where(eq(orders.id, f.orders.old.id))
      expect(Number(order.refundAmountCents)).toBe(UNIT_PRICE)

      // Back to the month the money was spent from, not to this month — and
      // withdrawn from that month's spend, not credited on top of it, so the
      // ledger agrees with the order-side netting (planRefundLedgerMove).
      expect(await budgetRow(f.branchIds.a1, f.periods.threeMonthsAgo)).toMatchObject({
        amountSpentCents: oldBefore.amountSpentCents - UNIT_PRICE,
        amountCreditedCents: oldBefore.amountCreditedCents,
      })
      expect(await budgetRow(f.branchIds.a1, f.periods.current)).toMatchObject({
        amountSpentCents: currentBefore.amountSpentCents,
        amountCreditedCents: currentBefore.amountCreditedCents,
      })
    })

    it("approves a cross-month request into last month's row, not this month's", async () => {
      signIn(f.actors.orderPortal)
      expect((await requestRefund(f.orders.crossMonth)).status).toBe(200)
      const [pending] = await refundRows(f.orders.crossMonth.id)
      const lastBefore = await budgetRow(f.branchIds.a1, f.periods.lastMonth)
      const currentBefore = await budgetRow(f.branchIds.a1, f.periods.current)

      signIn(f.actors.superAdmin)
      expect((await approveAsSuperAdmin(f.orders.crossMonth, pending.id)).status).toBe(200)

      expect(await budgetRow(f.branchIds.a1, f.periods.lastMonth)).toMatchObject({
        amountSpentCents: lastBefore.amountSpentCents - UNIT_PRICE,
        amountCreditedCents: lastBefore.amountCreditedCents,
      })
      expect(await budgetRow(f.branchIds.a1, f.periods.current)).toMatchObject({
        amountSpentCents: currentBefore.amountSpentCents,
        amountCreditedCents: currentBefore.amountCreditedCents,
      })
    })

    it("rejects, months later, a pending request, and moves no money", async () => {
      const pendingId = await seedPendingRequest(f, f.orders.oldReject)
      const before = await budgetRow(f.branchIds.a1, f.periods.threeMonthsAgo)

      signIn(f.actors.superAdmin)
      const response = await cancelAsSuperAdmin(pendingId)
      expect(response.status).toBe(200)

      expect((await refundRows(f.orders.oldReject.id))[0].status).toBe("CANCELLED")
      expect(await budgetRow(f.branchIds.a1, f.periods.threeMonthsAgo)).toMatchObject({
        amountSpentCents: before.amountSpentCents,
        amountCreditedCents: before.amountCreditedCents,
      })
    })

    it("refunds directly, through either route, an order fulfilled a month ago", async () => {
      signIn(f.actors.superAdmin)
      const direct = await requestRefund(f.orders.lateDirect)
      expect(direct.status).toBe(200)
      const [approved] = await refundRows(f.orders.lateDirect.id)
      expect(approved.status).toBe("APPROVED")

      const viaAdmin = await approveAsSuperAdmin(f.orders.lateDirect)
      expect(viaAdmin.status).toBe(200)
      const [order] = await db.select({ refundAmountCents: orders.refundAmountCents, status: orders.status })
        .from(orders).where(eq(orders.id, f.orders.lateDirect.id))
      expect(Number(order.refundAmountCents)).toBe(ORDER_TOTAL)
      expect(order.status).toBe("REFUNDED")
    })

    it("still refuses a refund beyond what the order holds, at any age", async () => {
      signIn(f.actors.superAdmin)
      await approveAsSuperAdmin(f.orders.expired)
      await approveAsSuperAdmin(f.orders.expired)
      // Fully refunded now: a third unit does not exist.
      const third = await approveAsSuperAdmin(f.orders.expired)
      expect(third.status).toBe(400)
    })
  })
})
