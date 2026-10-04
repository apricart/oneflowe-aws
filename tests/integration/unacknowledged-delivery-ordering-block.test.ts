import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray, like } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as preCheckRoute from "@/app/api/v1/orders/delivery-acknowledgement/route"
import * as sendTokenRoute from "@/app/api/v1/orders/[id]/send-token-email/route"
import * as fulfillmentStatusRoute from "@/app/api/v1/orders/[id]/fulfillment-status/route"
import {
  auditLogs,
  branchInventory,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  invoiceSequences,
  orderItems,
  orders,
  organizationAllowedIps,
  organizationInventory,
  organizationSettings,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { resolveBranchDeliveryAcknowledgement } from "@/lib/server/unacknowledged-delivery-block"
import { UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION } from "@/lib/unacknowledged-delivery-block"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The unacknowledged-delivery ordering block against Postgres
 * (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md).
 *
 * Nothing about the count is faked: the real gate reads the real organization
 * toggle and counts real order rows, and the real order, group-order,
 * pre-check, token hand-off and delivery routes act on the result. Only the
 * session, rate limiting, cache and mail are stubbed.
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
vi.mock("@/lib/server/order-notifications", () => ({
  queueOrderCreatedNotifications: vi.fn(async () => ({ eventKeys: [], recipientCount: 0 })),
  attemptImmediateOrderEmailDelivery: vi.fn(async () => undefined),
}))
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return { ...actual, sendOrderTokenEmail: vi.fn(async () => undefined) }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const request = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const read = async (response: Response) => ({ status: response.status, body: await response.json() })

const message = (count: number) =>
  `Your branch has ${count} delivered order${count === 1 ? "" : "s"} awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order.`
const SEEDED_TID_PREFIX = "UAD-"
// Seeded deliveries are dated in a month with no budget row, so settling one
// through the hand-off moves no ledger and cannot fail on a hold it never took.
const SEEDED_CREATED_AT = new Date("2025-01-15T10:00:00.000Z")

let idempotencyCounter = 0
const idempotencyKey = () => `uad-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`
let seededCounter = 0

async function roleIdOf(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by integration tests" }).returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("blocking new orders on unacknowledged deliveries", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  let orderPortalUserId: string
  let branchAdminUserId: string
  const createdOrganizationIds: number[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const emptyApprover = (): Actor => ({ id: f.emptyApproverId, email: `eap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  // Real rows pinned to Alpha North: the request scope reads the branch from
  // the user row, not from the session.
  const orderPortal = (): Actor => ({ id: orderPortalUserId, email: `op-${f.suffix}@example.test`, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const branchAdmin = (): Actor => ({ id: branchAdminUserId, email: `ba-${f.suffix}@example.test`, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaNorthId })

  const setToggle = (organizationId: number, enabled: boolean) =>
    db.update(organizations).set({ blockOrderingOnUnacknowledgedDeliveries: enabled }).where(eq(organizations.id, organizationId))

  /** An order as the delivery flow leaves it; any column can be overridden. */
  async function delivery(input: {
    organizationId?: number
    branchId: number
    status?: string
    fulfillmentStatus?: string
    createdByUserId?: string
    groupOrderId?: number
    approvalToken?: string
    paymentStatus?: string
    receiptData?: Record<string, unknown>
  }): Promise<number> {
    seededCounter += 1
    const [row] = await db
      .insert(orders)
      .values({
        tid: `${SEEDED_TID_PREFIX}${f.suffix}-${seededCounter}`.slice(0, 26),
        organizationId: input.organizationId ?? f.organizationId,
        branchId: input.branchId,
        createdByUserId: input.createdByUserId ?? f.headOfficeId,
        groupOrderId: input.groupOrderId,
        status: input.status ?? "APPROVED",
        fulfillmentStatus: input.fulfillmentStatus ?? "DELIVERED",
        deliveredAt: new Date("2025-01-16T10:00:00.000Z"),
        approvalToken: input.approvalToken ?? null,
        ...(input.paymentStatus ? { paymentStatus: input.paymentStatus } : {}),
        ...(input.receiptData ? { receiptData: input.receiptData as any } : {}),
        createdAt: SEEDED_CREATED_AT,
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      })
      .returning({ id: orders.id })
    return row.id
  }

  const status = (branchId: number, organizationId = f.organizationId) =>
    resolveBranchDeliveryAcknowledgement(db, { organizationId, branchId })

  const orderFor = (branchId: number, actor: Actor = headOffice()) => {
    signIn(actor)
    return ordersRoute.POST(request(
      "POST",
      "http://localhost/api/v1/orders",
      { branchId, organizationId: f.organizationId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
      { "Idempotency-Key": idempotencyKey() },
    )).then(read)
  }

  const groupOrder = (branchIds: number[]) => {
    signIn(requester())
    return groupOrdersRoute.POST(request(
      "POST",
      "http://localhost/api/v1/group-portal/orders",
      { groupId: f.alphaGroupId, entries: [{ branchIds, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
      { "Idempotency-Key": idempotencyKey() },
    )).then(read)
  }

  const preCheck = (actor: Actor | null, branchId?: number | string) => {
    signIn(actor)
    const query = branchId === undefined ? "" : `?branchId=${branchId}`
    return preCheckRoute.GET(request("GET", `http://localhost/api/v1/orders/delivery-acknowledgement${query}`)).then(async (response) => ({
      status: response.status,
      cacheControl: response.headers.get("Cache-Control"),
      body: await response.json(),
    }))
  }

  const ordersAt = async (branchId: number) =>
    (await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, branchId))).length

  const patchOrganization = (organizationId: number, body: unknown) =>
    organizationRoute.PATCH(
      request("PATCH", `http://localhost/api/v1/organizations/${organizationId}`, body),
      { params: Promise.resolve({ id: String(organizationId) }) },
    ).then(read)

  const toggleAudits = (organizationId: number) => db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION)))
    .orderBy(desc(auditLogs.id))

  async function pinnedUser(label: string, roleName: string): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-uad-${label}-${f.suffix}@example.test`,
        username: `it-uad-${label}-${f.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: await roleIdOf(roleName),
        organizationId: f.organizationId,
        branchId: f.alphaNorthId,
        firstName: label,
        lastName: f.suffix,
        fullName: `${label} ${f.suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    orderPortalUserId = await pinnedUser("order-portal", "ORDER_PORTAL")
    branchAdminUserId = await pinnedUser("branch-admin", "BRANCH_ADMIN")
    const [item] = await db
      .insert(organizationInventory)
      .values({ organizationId: f.organizationId, globalProductId: f.productId, assignedByUserId: f.headOfficeId, isActive: true })
      .returning({ id: organizationInventory.id })
    inventoryId = item.id
    await db.insert(branchInventory).values([f.alphaNorthId, f.alphaSouthId].map((branchId) => ({
      branchId,
      organizationId: f.organizationId,
      organizationInventoryId: inventoryId,
      assignedByUserId: f.headOfficeId,
    })))
    await db.update(globalProducts).set({ stockQuantity: 1_000 }).where(eq(globalProducts.id, f.productId))
  })

  afterAll(async () => {
    if (!f) return
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(inArray(groupOrders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(branchInventory).where(eq(branchInventory.organizationInventoryId, inventoryId))
    await db.delete(organizationInventory).where(eq(organizationInventory.id, inventoryId))
    if (createdOrganizationIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, createdOrganizationIds))
      await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, createdOrganizationIds))
      await db.delete(organizationAllowedIps).where(inArray(organizationAllowedIps.organizationId, createdOrganizationIds))
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds))
    }
    await destroyGroupRoleFixtures(f, [orderPortalUserId, branchAdminUserId])
    await closePool()
  })

  // Each case states its own deliveries and toggles; nothing carries over.
  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await db.delete(orders).where(and(
      inArray(orders.organizationId, [f.organizationId, f.foreignOrganizationId]),
      like(orders.tid, `${SEEDED_TID_PREFIX}%`),
    ))
    for (const organizationId of [f.organizationId, f.foreignOrganizationId]) {
      await setToggle(organizationId, false)
      await db.update(organizations).set({ blockOrderingOnUnpaidInvoices: false }).where(eq(organizations.id, organizationId))
    }
  })

  describe("with the toggle off (the default)", () => {
    it("a new organization row defaults to off", async () => {
      const [row] = await db
        .select({ enabled: organizations.blockOrderingOnUnacknowledgedDeliveries })
        .from(organizations)
        .where(eq(organizations.id, f.foreignOrganizationId))
      expect(row.enabled).toBe(false)
    })

    it("nothing is blocked, even with unacknowledged deliveries — ordering is exactly as before", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })

      expect(await status(f.alphaNorthId)).toEqual({ enabled: false, orderingAllowed: true, unacknowledgedCount: 0, threshold: 2 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })
  })

  describe("with the toggle on", () => {
    beforeEach(async () => {
      await setToggle(f.organizationId, true)
    })

    it("none → allowed", async () => {
      expect(await status(f.alphaNorthId)).toEqual({ enabled: true, orderingAllowed: true, unacknowledgedCount: 0, threshold: 2 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("one → still allowed", async () => {
      await delivery({ branchId: f.alphaNorthId })
      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 1 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("two → refused with 409, the popup's message, and no row written", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      const before = await ordersAt(f.alphaNorthId)

      const { status: code, body } = await orderFor(f.alphaNorthId)

      expect(code).toBe(409)
      expect(body).toEqual({
        error: message(2),
        code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED",
        deliveryAcknowledgement: { code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedCount: 2, threshold: 2 },
      })
      expect(await ordersAt(f.alphaNorthId)).toBe(before)
    })

    it("more than two → still refused, and the message carries the real count", async () => {
      for (let index = 0; index < 3; index += 1) await delivery({ branchId: f.alphaNorthId })
      const { status: code, body } = await orderFor(f.alphaNorthId)
      expect(code).toBe(409)
      expect(body.error).toBe(message(3))
    })

    it("counts only APPROVED + DELIVERED — every other state is left out", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId, status: "FULFILLED" })
      await delivery({ branchId: f.alphaNorthId, status: "PARTIAL" })
      await delivery({ branchId: f.alphaNorthId, status: "PARTIALLY_FULFILLED" })
      await delivery({ branchId: f.alphaNorthId, status: "REFUNDED" })
      await delivery({ branchId: f.alphaNorthId, status: "REJECTED" })
      await delivery({ branchId: f.alphaNorthId, status: "PENDING", fulfillmentStatus: "NOT_STARTED" })
      await delivery({ branchId: f.alphaNorthId, fulfillmentStatus: "NOT_STARTED" })
      await delivery({ branchId: f.alphaNorthId, fulfillmentStatus: "IN_PROCESS" })
      await delivery({ branchId: f.alphaNorthId, fulfillmentStatus: "OUT_FOR_DELIVERY" })
      // fulfillment_status is NOT NULL in the schema; the null read is covered
      // by the pure rule's test.

      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 1 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("reads the statuses case-insensitively, as the dashboard does", async () => {
      await delivery({ branchId: f.alphaNorthId, status: "approved", fulfillmentStatus: "delivered" })
      await delivery({ branchId: f.alphaNorthId, status: "Approved", fulfillmentStatus: "Delivered" })
      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: false, unacknowledgedCount: 2 })
    })

    it("counts every order at the branch — a colleague's and a group order alike", async () => {
      await delivery({ branchId: f.alphaNorthId, createdByUserId: f.requesterId, groupOrderId: f.alphaEnvelopeId })
      await delivery({ branchId: f.alphaNorthId, createdByUserId: f.headOfficeId })
      expect((await orderFor(f.alphaNorthId, orderPortal())).status).toBe(409)
    })

    it("the block follows the branch: another branch's deliveries do not count", async () => {
      await delivery({ branchId: f.alphaSouthId })
      await delivery({ branchId: f.alphaSouthId })

      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 0 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
      expect((await orderFor(f.alphaSouthId)).status).toBe(409)
    })

    it.each([
      ["Super Admin", () => superAdmin()],
      ["Head Office", () => headOffice()],
      ["Branch Admin", () => branchAdmin()],
      ["Order Portal", () => orderPortal()],
    ])("blocks %s ordering for that branch", async (_label, actor) => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      const { status: code, body } = await orderFor(f.alphaNorthId, actor())
      expect(code).toBe(409)
      expect(body.code).toBe("UNACKNOWLEDGED_DELIVERIES_BLOCKED")
    })

    it("recording a delivery through the real route moves an order into the count", async () => {
      await delivery({ branchId: f.alphaNorthId })
      const pendingId = await delivery({ branchId: f.alphaNorthId, fulfillmentStatus: "OUT_FOR_DELIVERY" })
      expect((await status(f.alphaNorthId)).orderingAllowed).toBe(true)

      signIn(superAdmin())
      const delivered = await fulfillmentStatusRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${pendingId}/fulfillment-status`, { fulfillmentStatus: "DELIVERED" }),
        { params: Promise.resolve({ id: String(pendingId) }) },
      )
      expect(delivered.status).toBe(200)

      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: false, unacknowledgedCount: 2 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it("acknowledging one delivery (handing the token over) unblocks the branch", async () => {
      const acknowledgedId = await delivery({ branchId: f.alphaNorthId, createdByUserId: f.requesterId, approvalToken: "UAD-TOKEN" })
      await delivery({ branchId: f.alphaNorthId })
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(requester())
      const handoff = await read(await sendTokenRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${acknowledgedId}/send-token-email`),
        { params: Promise.resolve({ id: String(acknowledgedId) }) },
      ))
      expect(handoff.status).toBe(200)
      expect(handoff.body).toMatchObject({ fulfilled: true, status: "FULFILLED" })

      const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, acknowledgedId))
      expect(row.status).toBe("FULFILLED")
      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 1 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("switching the toggle off lifts the block at once", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: false })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("does not stop an edit of a pending order — only new orders are gated", async () => {
      const created = await orderFor(f.alphaNorthId, orderPortal())
      expect(created.status).toBe(200)
      const [pending] = await db.select({ id: orders.id }).from(orders).where(eq(orders.tid, created.body.order.tid))
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      expect((await status(f.alphaNorthId)).orderingAllowed).toBe(false)

      signIn(orderPortal())
      const edited = await orderRoute.PUT(
        request("PUT", `http://localhost/api/v1/orders/${pending.id}`, { items: [{ organizationInventoryId: inventoryId, quantity: 2 }] }),
        { params: Promise.resolve({ id: String(pending.id) }) },
      )
      expect(edited.status).toBe(200)
    })

    it("a group order fails only the blocked branch, with the code and count, and creates the others", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })

      const { status: code, body } = await groupOrder([f.alphaNorthId, f.alphaSouthId])

      expect(code).toBe(201)
      const byBranch = new Map<number, Record<string, unknown>>(
        body.item.results.map((result: Record<string, unknown>) => [result.branchId as number, result]),
      )
      expect(byBranch.get(f.alphaNorthId)).toMatchObject({
        status: "failed",
        reason: message(2),
        code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED",
        unacknowledgedDeliveryCount: 2,
      })
      expect(byBranch.get(f.alphaNorthId)).not.toHaveProperty("unpaidInvoiceCount")
      expect(byBranch.get(f.alphaSouthId)).toMatchObject({ status: "created" })
      expect(byBranch.get(f.alphaSouthId)).not.toHaveProperty("code")
    })

    it("with both blocks on and both true, payment control answers first", async () => {
      await db.update(organizations).set({ blockOrderingOnUnpaidInvoices: true }).where(eq(organizations.id, f.organizationId))
      await delivery({ branchId: f.alphaNorthId, status: "FULFILLED", paymentStatus: "UNPAID", receiptData: { invoiceNumber: "INV-UAD-1" } })
      await delivery({ branchId: f.alphaNorthId, status: "FULFILLED", paymentStatus: "UNPAID", receiptData: { invoiceNumber: "INV-UAD-2" } })
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })

      const { status: code, body } = await orderFor(f.alphaNorthId)
      expect(code).toBe(409)
      expect(body.code).toBe("PAYMENT_CONTROL_BLOCKED")
    })

    it("with both toggles on, a branch clear of unpaid invoices is still stopped by this block", async () => {
      await db.update(organizations).set({ blockOrderingOnUnpaidInvoices: true }).where(eq(organizations.id, f.organizationId))
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })

      const { status: code, body } = await orderFor(f.alphaNorthId)
      expect(code).toBe(409)
      expect(body.code).toBe("UNACKNOWLEDGED_DELIVERIES_BLOCKED")
    })
  })

  describe("the pre-check route", () => {
    beforeEach(async () => {
      await setToggle(f.organizationId, true)
    })

    it("tells an Order Portal user their own branch is blocked, uncached, with no amounts or references", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })

      const { status: code, cacheControl, body } = await preCheck(orderPortal())
      expect(code).toBe(200)
      expect(cacheControl).toBe("private, no-store, max-age=0")
      expect(body).toEqual({ branchId: f.alphaNorthId, enabled: true, orderingAllowed: false, unacknowledgedCount: 2, threshold: 2 })
    })

    it("reports allowed below the threshold and when the toggle is off", async () => {
      await delivery({ branchId: f.alphaNorthId })
      expect((await preCheck(orderPortal())).body).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 1 })

      await setToggle(f.organizationId, false)
      await delivery({ branchId: f.alphaNorthId })
      expect((await preCheck(orderPortal())).body).toEqual({ branchId: f.alphaNorthId, enabled: false, orderingAllowed: true, unacknowledgedCount: 0, threshold: 2 })
    })

    it("an Order Portal user cannot read another branch", async () => {
      expect((await preCheck(orderPortal(), f.alphaSouthId)).status).toBe(403)
    })

    it("a Branch Admin reads its own branch", async () => {
      expect((await preCheck(branchAdmin())).status).toBe(200)
      expect((await preCheck(branchAdmin(), f.alphaSouthId)).status).toBe(403)
    })

    it("a group requester reads an assigned branch, never an unassigned one, and must name it", async () => {
      await delivery({ branchId: f.alphaSouthId })
      await delivery({ branchId: f.alphaSouthId })
      expect((await preCheck(requester(), f.alphaSouthId)).body).toMatchObject({ orderingAllowed: false, unacknowledgedCount: 2 })
      expect((await preCheck(requester(), f.foreignBranchId)).status).not.toBe(200)
      expect((await preCheck(requester())).status).toBe(400)
    })

    it("a group approver with no assignments is refused rather than widened", async () => {
      expect((await preCheck(emptyApprover(), f.alphaNorthId)).status).toBe(403)
      expect((await preCheck(approver(), f.alphaNorthId)).status).toBe(200)
    })

    it("Head Office reads its own tenant's branch; another tenant's is not found", async () => {
      expect((await preCheck(headOffice(), f.alphaNorthId)).status).toBe(200)
      expect((await preCheck(foreignHeadOffice(), f.alphaNorthId)).status).toBe(404)
      expect((await preCheck(headOffice())).status).toBe(400)
    })

    it("Super Admin reads any branch; a missing branch is 404 and a malformed id 400", async () => {
      expect((await preCheck(superAdmin(), f.foreignBranchId)).status).toBe(200)
      expect((await preCheck(superAdmin(), 2_147_000_000)).status).toBe(404)
      expect((await preCheck(superAdmin(), "abc")).status).toBe(400)
    })

    it("an unauthenticated caller gets 401", async () => {
      expect((await preCheck(null, f.alphaNorthId)).status).toBe(401)
    })

    it("a role outside the ordering and managing roles is refused with 403", async () => {
      const viewer: Actor = { ...headOffice(), role: "VIEWER" }
      const { status: code, body } = await preCheck(viewer, f.alphaNorthId)
      expect(code).toBe(403)
      expect(body).not.toHaveProperty("unacknowledgedCount")
    })

    it("a session with a pending password change is refused with 403 and learns nothing", async () => {
      await delivery({ branchId: f.alphaNorthId })
      await delivery({ branchId: f.alphaNorthId })
      vi.mocked(getServerSession).mockResolvedValue({ user: { ...orderPortal(), mustChangePassword: true } } as any)

      const response = await preCheckRoute.GET(request("GET", "http://localhost/api/v1/orders/delivery-acknowledgement"))
      expect(response.status).toBe(403)
      expect(await response.json()).not.toHaveProperty("unacknowledgedCount")
    })
  })

  describe("the orders list's Delivered · Unfulfilled view", () => {
    const list = (actor: Actor | null, query: string) => {
      signIn(actor)
      return ordersRoute.GET(request("GET", `http://localhost/api/v1/orders?${query}`)).then(read)
    }

    it("returns exactly the approved, delivered orders, with a count that pages them", async () => {
      const northDelivered = await delivery({ branchId: f.alphaNorthId, approvalToken: "UADTOKEN1" })
      const southDelivered = await delivery({ branchId: f.alphaSouthId })
      const dispatched = await delivery({ branchId: f.alphaNorthId, fulfillmentStatus: "DISPATCHED" })
      const fulfilled = await delivery({ branchId: f.alphaNorthId, status: "FULFILLED" })
      const pending = await delivery({ branchId: f.alphaNorthId, status: "PENDING", fulfillmentStatus: "NOT_STARTED" })

      const { status: code, body } = await list(headOffice(), "status=approved&delivery=unacknowledged&limit=500")
      expect(code).toBe(200)
      const ids = body.items.map((item: { id: number }) => item.id)
      expect(ids).toEqual(expect.arrayContaining([northDelivered, southDelivered]))
      for (const excluded of [dispatched, fulfilled, pending]) expect(ids).not.toContain(excluded)
      for (const item of body.items) {
        expect(String(item.status).toUpperCase()).toBe("APPROVED")
        expect(String(item.fulfillmentStatus).toUpperCase()).toBe("DELIVERED")
      }
      expect(body.summary.deliveredUnacknowledged).toBe(body.items.length)
      expect(body.pagination.total).toBe(body.items.length)
      // The other cards still describe the whole scope, not the selected tab.
      expect(body.summary.all).toBeGreaterThanOrEqual(body.items.length + 3)
    })

    it("narrows the same way without a status, since every such order is approved", async () => {
      const delivered = await delivery({ branchId: f.alphaNorthId })
      const fulfilled = await delivery({ branchId: f.alphaNorthId, status: "FULFILLED" })

      const { body } = await list(headOffice(), "delivery=unacknowledged&limit=500")
      const ids = body.items.map((item: { id: number }) => item.id)
      expect(ids).toContain(delivered)
      expect(ids).not.toContain(fulfilled)
    })

    it("refuses an unknown delivery value instead of returning the unfiltered list", async () => {
      expect((await list(headOffice(), "delivery=everything")).status).toBe(400)
    })

    it("keeps the tenant fence: another organization's Head Office sees none of these orders", async () => {
      const ours = await delivery({ branchId: f.alphaNorthId })

      const { status: code, body } = await list(foreignHeadOffice(), "status=approved&delivery=unacknowledged&limit=500")
      expect(code).toBe(200)
      expect(body.items.map((item: { id: number }) => item.id)).not.toContain(ours)
    })

    it("keeps the branch fence: a Branch Admin sees only its own branch", async () => {
      const north = await delivery({ branchId: f.alphaNorthId })
      const south = await delivery({ branchId: f.alphaSouthId })

      const { body } = await list(branchAdmin(), "delivery=unacknowledged&limit=500")
      const ids = body.items.map((item: { id: number }) => item.id)
      expect(ids).toContain(north)
      expect(ids).not.toContain(south)
    })

    it("an unauthenticated caller gets 401", async () => {
      expect((await list(null, "delivery=unacknowledged")).status).toBe(401)
    })
  })

  describe("tenant isolation", () => {
    it("the toggle belongs to one organization: another tenant's deliveries block nothing while it is off", async () => {
      await setToggle(f.organizationId, true)
      await delivery({ organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })
      await delivery({ organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })

      expect(await status(f.foreignBranchId, f.foreignOrganizationId)).toMatchObject({ enabled: false, orderingAllowed: true })
      expect(await status(f.alphaNorthId)).toMatchObject({ enabled: true, unacknowledgedCount: 0 })
    })

    it("the count is fenced by the organization as well as the branch", async () => {
      await setToggle(f.organizationId, true)
      // A row naming this tenant's branch under another tenant must not count
      // toward it: the count carries both predicates.
      await delivery({ organizationId: f.foreignOrganizationId, branchId: f.alphaNorthId })
      await delivery({ organizationId: f.foreignOrganizationId, branchId: f.alphaNorthId })

      expect(await status(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 0 })
    })
  })

  describe("who may set the toggle", () => {
    it("Super Admin switches it on in Edit Company, audited with what it replaced", async () => {
      signIn(superAdmin())
      const { status: code, body } = await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })

      expect(code).toBe(200)
      expect(body.item.blockOrderingOnUnacknowledgedDeliveries).toBe(true)
      const [row] = await db.select({ enabled: organizations.blockOrderingOnUnacknowledgedDeliveries }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.enabled).toBe(true)

      const [audit] = await toggleAudits(f.organizationId)
      expect(audit.userId).toBe(f.superAdminId)
      expect(audit.entityId).toBe(String(f.organizationId))
      expect(audit.metadata).toEqual({ previousBlockOrderingOnUnacknowledgedDeliveries: false, blockOrderingOnUnacknowledgedDeliveries: true })
    })

    it("saving the same value again writes no second audit row, and the other toggle is untouched", async () => {
      signIn(superAdmin())
      await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })
      const before = (await toggleAudits(f.organizationId)).length
      await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })
      expect(await toggleAudits(f.organizationId)).toHaveLength(before)

      const [row] = await db.select({ unpaid: organizations.blockOrderingOnUnpaidInvoices }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.unpaid).toBe(false)
    })

    it.each([
      ["Head Office", () => headOffice()],
      ["Branch Admin", () => branchAdmin()],
      ["a group approver", () => approver()],
      ["a group requester", () => requester()],
      ["an Order Portal user", () => orderPortal()],
    ])("%s cannot change it — 403 and the column is untouched", async (_label, actor) => {
      signIn(actor())
      const { status: code } = await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })
      expect(code).toBe(403)
      const [row] = await db.select({ enabled: organizations.blockOrderingOnUnacknowledgedDeliveries }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.enabled).toBe(false)
    })

    it("an unauthenticated caller gets 401", async () => {
      signIn(null)
      expect((await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })).status).toBe(401)
    })

    it("a non-boolean is refused with 400", async () => {
      signIn(superAdmin())
      const { status: code } = await patchOrganization(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: "true" })
      expect(code).toBe(400)
    })

    it("Super Admin can create an organization with it on, and the creation audit records it", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status: code, body } = await read(await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: `UAD Company ${suffix}`, code: `UAD${suffix}`, blockOrderingOnUnacknowledgedDeliveries: true },
      )))

      expect(code).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(body.item.blockOrderingOnUnacknowledgedDeliveries).toBe(true)
      expect(body.item.blockOrderingOnUnpaidInvoices).toBe(false)
      const [audit] = await db
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, body.item.id), eq(auditLogs.action, "CREATE_ORGANIZATION")))
      expect(audit.metadata).toMatchObject({ blockOrderingOnUnacknowledgedDeliveries: true })
    })

    it("an organization created without it is off", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status: code, body } = await read(await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: `UAD Default ${suffix}`, code: `UADD${suffix}` },
      )))
      expect(code).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(body.item.blockOrderingOnUnacknowledgedDeliveries).toBe(false)
    })

    it("Head Office cannot create an organization at all, with or without it", async () => {
      signIn(headOffice())
      const response = await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: "Sneaky Company", code: "SNEAKY2", blockOrderingOnUnacknowledgedDeliveries: false },
      ))
      expect(response.status).toBe(403)
    })
  })
})
