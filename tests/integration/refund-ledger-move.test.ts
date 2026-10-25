import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import * as orderRefundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as adminRefundsRoute from "@/app/api/v1/admin/refunds/route"
import * as budgetSummaryRoute from "@/app/api/v1/analytics/budgets/summary/route"
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
import { fulfillApprovedOrder } from "@/lib/server/order-fulfillment"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * How an approved refund moves the money ledger, end to end against Postgres
 * (`plans/OF-BUDGET-refund-ledger-debit.md`).
 *
 * Both refund routes apply `planRefundLedgerMove` to the order's own period:
 * a fulfilled order's refund is withdrawn from spent, an unfulfilled one's is
 * credited with the hold left whole. Every case starts from a fresh fixture.
 *
 * ```text
 * organization, branch "main" — this month's row:
 *   allocated 100,000 | spent 2,000 (the fulfilled order) | held 2,000 (the approved order)
 *   fulfilled  FULFILLED+DELIVERED, 2 x 1,000
 *   approved   APPROVED+DELIVERED,  2 x 1,000, not yet fulfilled
 * branch "repaired" — this month's row says spent 500 although its fulfilled
 *   order is 2,000 (a repaired/imported row)
 * ```
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendRefundRequestEmail: vi.fn(async () => true),
}))

const { getServerSession } = mockedNextAuth

const UNIT_PRICE = 1_000
const ORDER_TOTAL = 2 * UNIT_PRICE
const ALLOCATED = 100_000

type Fixtures = Awaited<ReturnType<typeof createFixtures>>
type OrderFixture = { id: number; itemId: number }

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "refund ledger it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const period = budgetPeriodOf(new Date())
  const [org] = await db.insert(organizations).values({ name: `IT Refund Ledger ${suffix}`, code: `ITRL-${suffix}` })
    .returning({ id: organizations.id })
  const [main, repaired] = await db.insert(branches).values([
    { organizationId: org.id, name: `Main ${suffix}`, status: "active" },
    { organizationId: org.id, name: `Repaired ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const [superAdmin] = await db.insert(users).values({
    email: `it-rl-super-${suffix}@example.test`,
    username: `it-rl-super-${suffix}`,
    passwordHash: "not-a-real-hash",
    roleId: await roleId("SUPER_ADMIN"),
    organizationId: null,
    fullName: `Super ${suffix}`,
  }).returning({ id: users.id })
  const [requester] = await db.insert(users).values({
    email: `it-rl-op-${suffix}@example.test`,
    username: `it-rl-op-${suffix}`,
    passwordHash: "not-a-real-hash",
    roleId: await roleId("ORDER_PORTAL"),
    organizationId: org.id,
    branchId: main.id,
    fullName: `Requester ${suffix}`,
  }).returning({ id: users.id })

  const [product] = await db.insert(globalProducts).values({
    productCode: `ITRL-${suffix}`,
    name: `Toner ${suffix}`,
    basePrice: UNIT_PRICE,
    status: "active",
    unit: "piece",
  }).returning({ id: globalProducts.id })

  const order = async (key: string, branchId: number, status: "FULFILLED" | "APPROVED"): Promise<OrderFixture> => {
    const now = new Date()
    const [row] = await db.insert(orders).values({
      tid: `ITRL-${key}-${suffix}`,
      organizationId: org.id,
      branchId,
      createdByUserId: requester.id,
      status,
      fulfillmentStatus: "DELIVERED",
      subtotalCents: ORDER_TOTAL,
      taxCents: 0,
      totalCents: ORDER_TOTAL,
      createdAt: now,
      approvedAt: now,
      deliveredAt: now,
      fulfilledAt: status === "FULFILLED" ? now : null,
      approvalToken: status === "APPROVED" ? `TOK-${key}-${suffix}` : null,
    }).returning({ id: orders.id })
    const [item] = await db.insert(orderItems).values({
      organizationId: org.id,
      orderId: row.id,
      globalProductId: product.id,
      productName: `Toner ${suffix}`,
      unit: "piece",
      quantity: 2,
      priceCents: UNIT_PRICE,
    }).returning({ id: orderItems.id })
    return { id: row.id, itemId: item.id }
  }

  const created = {
    fulfilled: await order("FUL", main.id, "FULFILLED"),
    approved: await order("APR", main.id, "APPROVED"),
    repaired: await order("REP", repaired.id, "FULFILLED"),
  }

  await db.insert(budgets).values([
    { organizationId: org.id, branchId: main.id, period, amountAllocatedCents: ALLOCATED, amountSpentCents: ORDER_TOTAL, amountHeldCents: ORDER_TOTAL },
    { organizationId: org.id, branchId: repaired.id, period, amountAllocatedCents: ALLOCATED, amountSpentCents: 500 },
  ])

  return {
    organizationId: org.id,
    branchIds: { main: main.id, repaired: repaired.id },
    superAdminId: superAdmin.id,
    userIds: [superAdmin.id, requester.id],
    productId: product.id,
    orders: created,
    period,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orderIds = Object.values(f.orders).map((order) => order.id)
  const refundIds = (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))).map((r) => r.id)
  if (refundIds.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundIds))
  await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
  await db.delete(notifications).where(eq(notifications.organizationId, f.organizationId))
  await db.delete(notifications).where(inArray(notifications.userId, f.userIds))
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, f.organizationId))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, f.userIds))
  await db.delete(systemLogs).where(inArray(systemLogs.userId, f.userIds))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  await db.delete(budgets).where(eq(budgets.organizationId, f.organizationId))
  await db.delete(users).where(inArray(users.id, f.userIds))
  await db.delete(branches).where(eq(branches.organizationId, f.organizationId))
  await db.delete(globalProducts).where(eq(globalProducts.id, f.productId))
  await db.delete(organizations).where(eq(organizations.id, f.organizationId))
}

function signInSuperAdmin(f: Fixtures): void {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null, email: "x@example.test", fullName: "IT", mustChangePassword: false },
  } as any)
}

const json = (url: string, method: string, body: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

const approveViaAdmin = async (order: OrderFixture) => read(await adminRefundsRoute.POST(
  json("http://localhost/api/v1/admin/refunds", "POST", { orderId: order.id, items: [{ itemId: order.itemId, quantity: 1 }] }),
))

const refundViaOrderRoute = async (order: OrderFixture) => read(await orderRefundsRoute.POST(
  json(`http://localhost/api/v1/orders/${order.id}/refunds`, "POST", { items: [{ id: order.itemId, quantity: 1 }], reason: "One unit faulty" }),
  { params: Promise.resolve({ id: String(order.id) }) },
))

async function budgetRow(branchId: number, period: string) {
  const [row] = await db.select().from(budgets).where(and(eq(budgets.branchId, branchId), eq(budgets.period, period)))
  return row
}

const remainingOf = (row: { amountAllocatedCents: number; amountCreditedCents: number; amountSpentCents: number; amountHeldCents: number }) =>
  row.amountAllocatedCents + row.amountCreditedCents - row.amountSpentCents - row.amountHeldCents

async function summary(f: Fixtures, dateFiltered: boolean) {
  // Date-only analytics filters are interpreted in the application's Karachi
  // calendar. A UTC day label is one day behind after 19:00 UTC and would
  // exclude the orders this fixture has just created.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())
  const query = new URLSearchParams({ organizationId: String(f.organizationId), branchIds: String(f.branchIds.main) })
  if (dateFiltered) {
    query.set("preset", "this_month")
    query.set("startDate", `${f.period}-01`)
    query.set("endDate", today)
  }
  const response = await read(await budgetSummaryRoute.GET(new NextRequest(`http://localhost/api/v1/analytics/budgets/summary?${query}`)))
  expect(response.status).toBe(200)
  return response.body.summary as { totalAllocated: number; totalSpent: number; totalHeld: number; totalCredited: number; totalRemaining: number }
}

describe.skipIf(!hasTestDatabase)("refund ledger move", () => {
  let f: Fixtures

  beforeAll(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  beforeEach(async () => {
    if (f) await destroyFixtures(f)
    f = await createFixtures()
    signInSuperAdmin(f)
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  it("withdraws an admin-approved refund of a fulfilled order from spent, not credited", async () => {
    const before = await budgetRow(f.branchIds.main, f.period)
    expect((await approveViaAdmin(f.orders.fulfilled)).status).toBe(200)

    const after = await budgetRow(f.branchIds.main, f.period)
    expect(after).toMatchObject({
      amountSpentCents: before.amountSpentCents - UNIT_PRICE,
      amountHeldCents: before.amountHeldCents,
      amountCreditedCents: before.amountCreditedCents,
    })
    expect(remainingOf(after) - remainingOf(before)).toBe(UNIT_PRICE)
  })

  it("leaves the date-filtered budget summary agreeing with the ledger after the refund", async () => {
    expect((await approveViaAdmin(f.orders.fulfilled)).status).toBe(200)

    const ledger = await summary(f, false)
    const fromOrders = await summary(f, true)
    // allocated 100,000; fulfilled 2,000 less 1,000 refunded; 2,000 held.
    expect(ledger.totalRemaining).toBe(ALLOCATED - (ORDER_TOTAL - UNIT_PRICE) - ORDER_TOTAL)
    expect(fromOrders.totalRemaining).toBe(ledger.totalRemaining)
    expect(fromOrders.totalSpent).toBe(ledger.totalSpent)
    expect(fromOrders.totalCredited).toBe(0)
  })

  it("withdraws a direct refund of a fulfilled order from spent too, so both routes agree", async () => {
    const before = await budgetRow(f.branchIds.main, f.period)
    expect((await refundViaOrderRoute(f.orders.fulfilled)).status).toBe(200)

    expect(await budgetRow(f.branchIds.main, f.period)).toMatchObject({
      amountSpentCents: before.amountSpentCents - UNIT_PRICE,
      amountCreditedCents: before.amountCreditedCents,
    })
  })

  it("credits a direct refund of an approved order and keeps the hold whole, so the order can still be fulfilled", async () => {
    const before = await budgetRow(f.branchIds.main, f.period)
    expect((await refundViaOrderRoute(f.orders.approved)).status).toBe(200)

    const refunded = await budgetRow(f.branchIds.main, f.period)
    expect(refunded).toMatchObject({
      amountHeldCents: before.amountHeldCents,
      amountSpentCents: before.amountSpentCents,
      amountCreditedCents: before.amountCreditedCents + UNIT_PRICE,
    })
    expect(remainingOf(refunded) - remainingOf(before)).toBe(UNIT_PRICE)

    // Debiting the hold here used to leave it short of the order total, and
    // fulfilment — which moves the full total — then failed its ledger check.
    const outcome = await fulfillApprovedOrder({
      orderId: f.orders.approved.id,
      organizationId: f.organizationId,
      branchId: f.branchIds.main,
      fulfilledByUserId: f.superAdminId,
    })
    expect(outcome).toBe("fulfilled")
    const fulfilled = await budgetRow(f.branchIds.main, f.period)
    expect(fulfilled).toMatchObject({ amountHeldCents: 0, amountSpentCents: 2 * ORDER_TOTAL })
    expect(remainingOf(fulfilled)).toBe(remainingOf(refunded))
  })

  it("credits an admin-approved refund of an approved order the same way", async () => {
    const before = await budgetRow(f.branchIds.main, f.period)
    expect((await approveViaAdmin(f.orders.approved)).status).toBe(200)
    expect(await budgetRow(f.branchIds.main, f.period)).toMatchObject({
      amountHeldCents: before.amountHeldCents,
      amountSpentCents: before.amountSpentCents,
      amountCreditedCents: before.amountCreditedCents + UNIT_PRICE,
    })
  })

  it("never takes spent below zero: what a short row cannot cover is credited, so nothing is lost", async () => {
    const before = await budgetRow(f.branchIds.repaired, f.period)
    expect(before.amountSpentCents).toBe(500)
    expect((await approveViaAdmin(f.orders.repaired)).status).toBe(200)

    const after = await budgetRow(f.branchIds.repaired, f.period)
    expect(after).toMatchObject({ amountSpentCents: 0, amountCreditedCents: UNIT_PRICE - 500 })
    expect(remainingOf(after) - remainingOf(before)).toBe(UNIT_PRICE)
  })
})
