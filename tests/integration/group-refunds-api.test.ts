import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as historyRoute from "@/app/api/v1/group-portal/refunds/route"
import * as workspaceRoute from "@/app/api/v1/group-portal/refunds/[groupOrderId]/route"
import {
  auditLogs,
  branches,
  budgets,
  globalProducts,
  groupOrders,
  groups,
  notifications,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
  roles,
  systemLogs,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { createGroupRefundRequests, loadGroupRefundWorkspace } from "@/lib/server/group-order-refunds"
import { OUT_OF_SCOPE_REASON } from "@/lib/server/group-refund-rules"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Group Order Portal refund requests, end to end against Postgres.
 *
 * One envelope fans out to four branch orders, each in a state that decides
 * its refund eligibility differently:
 *
 * ```text
 * envelope (requester's own)
 *   North   FULFILLED + DELIVERED a day ago     -> refundable
 *             Rice  4 x 10.00 (whole units)
 *             Flour 3 x 20.00 (decimal, step 0.5)
 *   South   APPROVED, not delivered              -> "fulfilled and delivered"
 *   Outside FULFILLED + DELIVERED, branch not in the requester's group -> out of scope
 *   Old     FULFILLED + DELIVERED 8 days ago    -> "refund period has ended"
 * other envelope (same tenant, another requester) -> 404
 * ```
 *
 * Only identity, the mail transport and the rate limiter are faked. The
 * pricing of each line, the remaining-capacity arithmetic, the PENDING rows,
 * the audit trail and the Super Admin notification are the real code.
 */

const mocks = vi.hoisted(() => ({
  sendGroupRefundRequestEmail: vi.fn(async () => true),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", () => ({ sendGroupRefundRequestEmail: mocks.sendGroupRefundRequestEmail }))

const { getServerSession } = mockedNextAuth

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "group refunds it" }).returning({ id: roles.id })
  return created.id
}

const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS)

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Group Refunds ${suffix}`, code: `ITGRF-${suffix}` })
    .returning({ id: organizations.id })

  const person = async (label: string, role: string, organizationId: number | null) => {
    const [row] = await db.insert(users).values({
      email: `it-grf-${label}-${suffix}@example.test`,
      username: `it-grf-${label}-${suffix}`,
      passwordHash: "not-a-real-hash",
      roleId: await roleId(role),
      organizationId,
      fullName: `${label} ${suffix}`,
    }).returning({ id: users.id })
    return row.id
  }

  const requesterId = await person("requester", "GROUP_ORDER_PORTAL", organization.id)
  const otherRequesterId = await person("other-requester", "GROUP_ORDER_PORTAL", organization.id)
  const headOfficeId = await person("head-office", "HEAD_OFFICE", organization.id)
  const superAdminId = await person("super", "SUPER_ADMIN", null)

  const [group] = await db.insert(groups)
    .values({ organizationId: organization.id, name: `Refund Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [otherGroup] = await db.insert(groups)
    .values({ organizationId: organization.id, name: `Other Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })

  const [north, south, outside, old] = await db.insert(branches).values([
    { organizationId: organization.id, groupId: group.id, name: `North ${suffix}`, status: "active" },
    { organizationId: organization.id, groupId: group.id, name: `South ${suffix}`, status: "active" },
    { organizationId: organization.id, groupId: otherGroup.id, name: `Outside ${suffix}`, status: "active" },
    { organizationId: organization.id, groupId: group.id, name: `Old ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  await db.insert(userGroupAssignments).values({
    userId: requesterId,
    groupId: group.id,
    organizationId: organization.id,
    createdByUserId: headOfficeId,
  })

  const [rice, flour] = await db.insert(globalProducts).values([
    { productCode: `ITGRF-R-${suffix}`, name: `Rice ${suffix}`, basePrice: 1_000, status: "active", unit: "bag" },
    {
      productCode: `ITGRF-F-${suffix}`,
      name: `Flour ${suffix}`,
      basePrice: 2_000,
      status: "active",
      unit: "kg",
      allowDecimalQuantity: true,
      quantityStep: 0.5,
    },
  ]).returning({ id: globalProducts.id })

  const envelope = async (key: string, createdByUserId: string) => {
    const [row] = await db.insert(groupOrders).values({
      reference: `GRF-${key}-${suffix}`,
      organizationId: organization.id,
      groupId: group.id,
      createdByUserId,
      idempotencyKey: `grf-${key}-${suffix}`,
      requestFingerprint: key.repeat(64).slice(0, 64),
      requestedBranchCount: 4,
      createdOrderCount: 4,
    }).returning({ id: groupOrders.id })
    return row.id
  }

  const envelopeId = await envelope("MINE", requesterId)
  const otherEnvelopeId = await envelope("THEIRS", otherRequesterId)

  const order = async (input: {
    key: string
    branchId: number
    status: string
    fulfillmentStatus: string
    groupOrderId: number
    createdByUserId?: string
    fulfilledAt?: Date
    lines: Array<{ productId: number; name: string; quantity: number; priceCents: number }>
  }) => {
    const totalCents = input.lines.reduce((sum, line) => sum + Math.round(line.quantity * line.priceCents), 0)
    const [row] = await db.insert(orders).values({
      tid: `ITGRF-${input.key}-${suffix}`,
      organizationId: organization.id,
      branchId: input.branchId,
      groupOrderId: input.groupOrderId,
      createdByUserId: input.createdByUserId ?? requesterId,
      status: input.status,
      fulfillmentStatus: input.fulfillmentStatus,
      subtotalCents: totalCents,
      taxCents: 0,
      totalCents,
      // A fulfilled order carries its fulfilment time; the seven-day refund
      // window runs from it.
      fulfilledAt: input.status === "FULFILLED" ? (input.fulfilledAt ?? daysAgo(1)) : null,
    }).returning({ id: orders.id })

    const items = await db.insert(orderItems).values(input.lines.map((line) => ({
      organizationId: organization.id,
      orderId: row.id,
      globalProductId: line.productId,
      productName: line.name,
      unit: "unit",
      quantity: line.quantity,
      priceCents: line.priceCents,
    }))).returning({ id: orderItems.id })
    return { id: row.id, itemIds: items.map((item) => item.id), totalCents }
  }

  const delivered = { status: "FULFILLED", fulfillmentStatus: "DELIVERED" }
  const northLines = [
    { productId: rice.id, name: `Rice ${suffix}`, quantity: 4, priceCents: 1_000 },
    { productId: flour.id, name: `Flour ${suffix}`, quantity: 3, priceCents: 2_000 },
  ]
  const northOrder = await order({ key: "N", branchId: north.id, ...delivered, groupOrderId: envelopeId, lines: northLines })
  const southOrder = await order({
    key: "S",
    branchId: south.id,
    status: "APPROVED",
    fulfillmentStatus: "OUT_FOR_DELIVERY",
    groupOrderId: envelopeId,
    lines: [{ productId: rice.id, name: `Rice ${suffix}`, quantity: 1, priceCents: 1_000 }],
  })
  const outsideOrder = await order({
    key: "X",
    branchId: outside.id,
    ...delivered,
    groupOrderId: envelopeId,
    lines: [{ productId: rice.id, name: `Rice ${suffix}`, quantity: 1, priceCents: 1_000 }],
  })
  const oldOrder = await order({
    key: "O",
    branchId: old.id,
    ...delivered,
    groupOrderId: envelopeId,
    fulfilledAt: daysAgo(8),
    lines: [{ productId: rice.id, name: `Rice ${suffix}`, quantity: 1, priceCents: 1_000 }],
  })
  const theirOrder = await order({
    key: "T",
    branchId: north.id,
    ...delivered,
    groupOrderId: otherEnvelopeId,
    createdByUserId: otherRequesterId,
    lines: [{ productId: rice.id, name: `Rice ${suffix}`, quantity: 1, priceCents: 1_000 }],
  })

  return {
    suffix,
    organizationId: organization.id,
    requesterId,
    otherRequesterId,
    headOfficeId,
    superAdminId,
    groupIds: [group.id, otherGroup.id],
    branchIds: { north: north.id, south: south.id, outside: outside.id, old: old.id },
    productIds: [rice.id, flour.id],
    envelopeId,
    otherEnvelopeId,
    northOrder,
    southOrder,
    outsideOrder,
    oldOrder,
    theirOrder,
    riceName: `Rice ${suffix}`,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orderIds = [f.northOrder.id, f.southOrder.id, f.outsideOrder.id, f.oldOrder.id, f.theirOrder.id]
  const userIds = [f.requesterId, f.otherRequesterId, f.headOfficeId, f.superAdminId]
  const refundIds = (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))).map((r) => r.id)
  if (refundIds.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundIds))
  await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
  await db.delete(notifications).where(eq(notifications.organizationId, f.organizationId))
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, f.organizationId))
  await db.delete(systemLogs).where(inArray(systemLogs.userId, userIds))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  await db.delete(groupOrders).where(inArray(groupOrders.id, [f.envelopeId, f.otherEnvelopeId]))
  await db.delete(budgets).where(eq(budgets.organizationId, f.organizationId))
  await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.userId, userIds))
  await db.delete(branches).where(eq(branches.organizationId, f.organizationId))
  await db.delete(groups).where(inArray(groups.id, f.groupIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(globalProducts).where(inArray(globalProducts.id, f.productIds))
  await db.delete(organizations).where(eq(organizations.id, f.organizationId))
}

function signIn(user: { id: string; role: string; organizationId: number | null } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    user === null ? null : ({ user: { ...user, email: "x@example.test", mustChangePassword: false } } as any),
  )
}

function postRefund(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/group-portal/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function workspace(groupOrderId: number | string) {
  const response = await workspaceRoute.GET(new Request("http://localhost/x"), {
    params: Promise.resolve({ groupOrderId: String(groupOrderId) }),
  })
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("group refund requests", () => {
  let f: Fixtures
  const requester = () => ({ id: f.requesterId, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    const orderIds = [f.northOrder.id, f.southOrder.id, f.outsideOrder.id, f.oldOrder.id, f.theirOrder.id]
    const refundIds = (await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))).map((r) => r.id)
    if (refundIds.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundIds))
    await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
    mocks.sendGroupRefundRequestEmail.mockClear()
    signIn(requester())
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  describe("access", () => {
    it("is closed to anonymous callers and to every role but the group requester", async () => {
      signIn(null)
      expect((await workspace(f.envelopeId)).status).toBe(401)
      expect((await historyRoute.POST(postRefund({}))).status).toBe(401)

      for (const role of ["ORDER_PORTAL", "GROUP_USER", "HEAD_OFFICE"]) {
        signIn({ id: f.headOfficeId, role, organizationId: f.organizationId })
        expect((await workspace(f.envelopeId)).status, role).toBe(403)
      }
    })

    it("answers 404 for another requester's group order and for one that does not exist", async () => {
      expect((await workspace(f.otherEnvelopeId)).status).toBe(404)
      expect((await workspace(2_147_483_000)).status).toBe(404)
    })

    it("answers 400 for a malformed id", async () => {
      expect((await workspace("abc")).status).toBe(400)
      expect((await workspace("0")).status).toBe(400)
    })
  })

  describe("the workspace", () => {
    it("offers only the delivered, in-scope, recently fulfilled order and says why each other one is not refundable", async () => {
      const { status, body } = await workspace(f.envelopeId)
      expect(status).toBe(200)
      const item = body.item

      expect(item.refundable.map((order: any) => order.orderId)).toEqual([f.northOrder.id])
      expect(item.refundable[0]).toMatchObject({ totalCents: 10_000, remainingRefundableCents: 10_000 })
      expect(item.refundable[0].lines.map((line: any) => [line.quantityOrdered, line.quantityRemaining, line.priceCents]))
        .toEqual([[4, 4, 1_000], [3, 3, 2_000]])

      const reasons = Object.fromEntries(item.ineligible.map((order: any) => [order.orderId, order.reason]))
      expect(reasons[f.southOrder.id]).toBe("A refund can be requested once this order has been fulfilled and delivered.")
      expect(reasons[f.outsideOrder.id]).toBe(OUT_OF_SCOPE_REASON)
      expect(reasons[f.oldOrder.id]).toMatch(/refund period has ended/)
      expect(reasons[f.theirOrder.id]).toBeUndefined()
    })
  })

  describe("submitting", () => {
    it("records a PENDING request priced from the order, never from the request, and moves no money", async () => {
      const [northBefore] = await db.select().from(orders).where(eq(orders.id, f.northOrder.id))

      const response = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "Damaged on arrival",
        orders: [{ orderId: f.northOrder.id, items: [
          { id: f.northOrder.itemIds[0], quantity: 2 },
          { id: f.northOrder.itemIds[1], quantity: 1.5 },
        ] }],
      }))

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.message).toBe("Refund request submitted")
      expect(body.item).toMatchObject({ requestedOrderCount: 1, skippedOrderCount: 0, totalAmountCents: 5_000 })

      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, f.northOrder.id))
      expect(refund).toMatchObject({
        status: "PENDING",
        amountCents: 5_000,
        reason: "Damaged on arrival",
        requestedByUserId: f.requesterId,
        organizationId: f.organizationId,
      })
      expect(refund.refundNumber).toBe(`Refund-${String(refund.id).padStart(6, "0")}`)

      const lines = await db.select().from(refundItems).where(eq(refundItems.refundId, refund.id))
      expect(lines.map((line) => [line.orderItemId, line.quantity, line.amountCents]).sort())
        .toEqual([[f.northOrder.itemIds[0], 2, 2_000], [f.northOrder.itemIds[1], 1.5, 3_000]].sort())

      const [northAfter] = await db.select().from(orders).where(eq(orders.id, f.northOrder.id))
      expect(northAfter.status).toBe(northBefore.status)
      expect(northAfter.refundAmountCents).toBe(northBefore.refundAmountCents)

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.organizationId, f.organizationId),
        eq(auditLogs.action, "REFUND_REQUESTED"),
        eq(auditLogs.entityId, String(f.northOrder.id)),
      ))
      expect(audit.userId).toBe(f.requesterId)

      const notices = await db.select().from(notifications).where(and(
        eq(notifications.organizationId, f.organizationId),
        eq(notifications.userId, f.superAdminId),
      ))
      expect(notices.at(-1)?.message).toMatch(/PKR 50\.00 across 1 branch order$/)
    })

    it("reduces what the workspace offers by what is already requested", async () => {
      await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "first",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 3 }] }],
      })

      const { body } = await workspace(f.envelopeId)
      const north = body.item.refundable[0]
      expect(north.remainingRefundableCents).toBe(7_000)
      expect(north.lines.map((line: any) => line.quantityRemaining)).toEqual([1, 3])
    })

    it("closes an order once every line has been asked for", async () => {
      await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "all of it",
        requestedOrders: [{ orderId: f.northOrder.id, items: [
          { id: f.northOrder.itemIds[0], quantity: 4 },
          { id: f.northOrder.itemIds[1], quantity: 3 },
        ] }],
      })

      const { body } = await workspace(f.envelopeId)
      expect(body.item.refundable).toEqual([])
      const north = body.item.ineligible.find((order: any) => order.orderId === f.northOrder.id)
      expect(north.reason).toBe("This order has already been fully refunded.")
    })

    it("refuses more than is left on a line", async () => {
      const response = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "too much",
        orders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 5 }] }],
      }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe(`Only 4 of ${f.riceName} is still refundable.`)
    })

    it("refuses a fractional quantity of a whole-unit product, and prices a decimal one exactly", async () => {
      const whole = await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "x",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1.5 }] }],
      })
      expect(whole).toMatchObject({ ok: false, status: 400 })

      expect(await db.select().from(refunds).where(eq(refunds.orderId, f.northOrder.id))).toHaveLength(0)

      // A decimal product's step is not enforced on this path (validateProductQuantity
      // only enforces it for callers that opt in), so 1.25 kg is priced, not refused.
      const decimal = await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "x",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[1], quantity: 1.25 }] }],
      })
      expect(decimal).toMatchObject({ ok: true, submission: { totalAmountCents: 2_500 } })
    })

    it("refuses a line that belongs to another order", async () => {
      const result = await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "x",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.southOrder.itemIds[0], quantity: 1 }] }],
      })
      expect(result).toEqual({ ok: false, status: 400, message: "One or more selected items are not refundable on this order." })
    })

    it("writes the eligible branch and reports each skipped one with its reason", async () => {
      const response = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "mixed",
        orders: [
          { orderId: f.southOrder.id, items: [{ id: f.southOrder.itemIds[0], quantity: 1 }] },
          { orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1 }] },
          { orderId: f.theirOrder.id, items: [{ id: f.theirOrder.itemIds[0], quantity: 1 }] },
        ],
      }))

      expect(response.status).toBe(201)
      const body = await response.json()
      expect(body.message).toBe("Refund request submitted with some branches skipped")
      const byOrder = Object.fromEntries(body.item.results.map((result: any) => [result.orderId, result]))
      expect(byOrder[f.northOrder.id]).toMatchObject({ status: "requested", amountCents: 1_000 })
      expect(byOrder[f.southOrder.id]).toMatchObject({ status: "skipped" })
      expect(byOrder[f.theirOrder.id]).toMatchObject({
        status: "skipped",
        reason: "This order is not part of the selected group order.",
      })
      expect(await db.select().from(refunds).where(eq(refunds.orderId, f.theirOrder.id))).toHaveLength(0)
      // One summary mail for the submission, naming only the branch actually written.
      expect(mocks.sendGroupRefundRequestEmail).toHaveBeenCalledTimes(1)
      expect((mocks.sendGroupRefundRequestEmail.mock.calls[0] as any)[0].branches.map((branch: any) => branch.tid))
        .toEqual([`ITGRF-N-${f.suffix}`])
    })

    it("answers 400 with the reason when nothing is refundable, and 404 for another requester's envelope", async () => {
      const none = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "x",
        orders: [{ orderId: f.outsideOrder.id, items: [{ id: f.outsideOrder.itemIds[0], quantity: 1 }] }],
      }))
      expect(none.status).toBe(400)
      expect((await none.json()).error).toBe(OUT_OF_SCOPE_REASON)

      const theirs = await historyRoute.POST(postRefund({
        groupOrderId: f.otherEnvelopeId,
        reason: "x",
        orders: [{ orderId: f.theirOrder.id, items: [{ id: f.theirOrder.itemIds[0], quantity: 1 }] }],
      }))
      expect(theirs.status).toBe(404)
    })

    it("validates the body: duplicate lines, missing reason, unknown fields", async () => {
      const duplicate = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "x",
        orders: [{ orderId: f.northOrder.id, items: [
          { id: f.northOrder.itemIds[0], quantity: 2 },
          { id: f.northOrder.itemIds[0], quantity: 2 },
        ] }],
      }))
      expect(duplicate.status).toBe(400)

      const noReason = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: " ",
        orders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1 }] }],
      }))
      expect(noReason.status).toBe(400)

      const priced = await historyRoute.POST(postRefund({
        groupOrderId: f.envelopeId,
        reason: "x",
        orders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1, priceCents: 1 }] }],
      }))
      expect(priced.status).toBe(400)
      expect(await db.select().from(refunds).where(eq(refunds.orderId, f.northOrder.id))).toHaveLength(0)
    })

    it("does not let the workspace be read through the service for another tenant", async () => {
      expect(await loadGroupRefundWorkspace({
        userId: f.requesterId,
        organizationId: f.organizationId + 100_000,
        groupOrderId: f.envelopeId,
      })).toBeNull()
    })
  })

  describe("history", () => {
    it("rolls the caller's refunds up under their group order with totals and status counts", async () => {
      await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "one",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1 }] }],
      })
      await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "two",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[1], quantity: 0.5 }] }],
      })

      const response = await historyRoute.GET(new NextRequest("http://localhost/x?page=1&limit=500"))
      const body = await response.json()

      expect(body.pagination).toMatchObject({ page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false })
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({
        groupOrderId: f.envelopeId,
        totalAmountCents: 2_000,
        statusCounts: { PENDING: 2 },
      })
      expect(body.items[0].refunds.map((refund: any) => refund.items.length)).toEqual([1, 1])
    })

    it("shows another requester none of it", async () => {
      await createGroupRefundRequests({
        userId: f.requesterId,
        organizationId: f.organizationId,
        groupOrderId: f.envelopeId,
        reason: "one",
        requestedOrders: [{ orderId: f.northOrder.id, items: [{ id: f.northOrder.itemIds[0], quantity: 1 }] }],
      })
      signIn({ id: f.otherRequesterId, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
      const body = await (await historyRoute.GET(new NextRequest("http://localhost/x"))).json()
      expect(body).toEqual({
        items: [],
        pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
      })
    })
  })
})
