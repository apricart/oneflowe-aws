import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray, like } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as paymentStatusRoute from "@/app/api/v1/orders/[id]/payment-status/route"
import * as statusRoute from "@/app/api/v1/payment-control/route"
import * as grantRoute from "@/app/api/v1/payment-control/exceptions/route"
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
  paymentControlExceptions,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { resolveBranchPaymentControl } from "@/lib/server/payment-control"
import { UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION } from "@/lib/unpaid-invoice-block"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The unpaid-invoice ordering block against Postgres
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md).
 *
 * Unlike tests/integration/payment-control-api.test.ts, nothing about the
 * count is faked: the real seam reads the real organization toggle and counts
 * real order rows, and the real order, group-order, payment-status, status and
 * exception routes act on the result. Only the session, rate limiting, cache
 * and mail are stubbed.
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

const BLOCKED_MESSAGE = "You have 2 unpaid invoices. Please pay your dues before placing a new order."
const INVOICE_TID_PREFIX = "UIB-"

let idempotencyCounter = 0
const idempotencyKey = () => `uib-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`
let invoiceCounter = 0

describe.skipIf(!hasTestDatabase)("blocking new orders on unpaid invoices", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  const createdOrganizationIds: number[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  // Role checks run on the session alone, so these borrow a real user id to
  // stand in for the roles the fixture has no account for.
  const branchAdmin = (): Actor => ({ id: f.approverId, email: `ba-${f.suffix}@example.test`, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const orderPortal = (): Actor => ({ id: f.requesterId, email: `op-${f.suffix}@example.test`, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.alphaNorthId })

  const setToggle = (organizationId: number, enabled: boolean) =>
    db.update(organizations).set({ blockOrderingOnUnpaidInvoices: enabled }).where(eq(organizations.id, organizationId))

  /** An invoice row as the fulfilment flow leaves it; any column can be overridden. */
  async function invoice(input: {
    organizationId?: number
    branchId: number
    status?: string
    fulfillmentStatus?: string
    paymentStatus?: string
    receiptData?: unknown
    deliveredAt?: Date
  }): Promise<number> {
    invoiceCounter += 1
    const [row] = await db
      .insert(orders)
      .values({
        tid: `${INVOICE_TID_PREFIX}${f.suffix}-${invoiceCounter}`.slice(0, 26),
        organizationId: input.organizationId ?? f.organizationId,
        branchId: input.branchId,
        createdByUserId: f.headOfficeId,
        status: input.status ?? "FULFILLED",
        fulfillmentStatus: input.fulfillmentStatus ?? "DELIVERED",
        paymentStatus: input.paymentStatus ?? "UNPAID",
        receiptData: (input.receiptData === undefined ? { invoiceNumber: `INV-UIB-${invoiceCounter}` } : input.receiptData) as any,
        deliveredAt: input.deliveredAt ?? new Date(Date.UTC(2026, 8, invoiceCounter % 28 + 1)),
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      })
      .returning({ id: orders.id })
    return row.id
  }

  const status = (branchId: number, organizationId = f.organizationId) =>
    resolveBranchPaymentControl(db, { organizationId, branchId })

  const orderFor = (branchId: number, actor: Actor = headOffice()) => {
    signIn(actor)
    return ordersRoute.POST(request(
      "POST",
      "http://localhost/api/v1/orders",
      { branchId, organizationId: f.organizationId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
      { "Idempotency-Key": idempotencyKey() },
    )).then(read)
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
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION)))
    .orderBy(desc(auditLogs.id))

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
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
    await db.delete(paymentControlExceptions).where(inArray(paymentControlExceptions.organizationId, organizationIds))
    await db.delete(branchInventory).where(eq(branchInventory.organizationInventoryId, inventoryId))
    await db.delete(organizationInventory).where(eq(organizationInventory.id, inventoryId))
    if (createdOrganizationIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, createdOrganizationIds))
      await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, createdOrganizationIds))
      await db.delete(organizationAllowedIps).where(inArray(organizationAllowedIps.organizationId, createdOrganizationIds))
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds))
    }
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  // Each case states its own invoices and toggle; nothing carries over.
  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await db.delete(orders).where(and(
      inArray(orders.organizationId, [f.organizationId, f.foreignOrganizationId]),
      like(orders.tid, `${INVOICE_TID_PREFIX}%`),
    ))
    await db.delete(paymentControlExceptions).where(inArray(paymentControlExceptions.organizationId, [f.organizationId, f.foreignOrganizationId]))
    await setToggle(f.organizationId, false)
    await setToggle(f.foreignOrganizationId, false)
  })

  describe("with the toggle off (the default)", () => {
    it("a new organization row defaults to off", async () => {
      const [row] = await db
        .select({ enabled: organizations.blockOrderingOnUnpaidInvoices })
        .from(organizations)
        .where(eq(organizations.id, f.foreignOrganizationId))
      expect(row.enabled).toBe(false)
    })

    it("nothing is blocked, even with unpaid invoices — ordering is exactly as before", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })

      const result = await status(f.alphaNorthId)
      expect(result.state).toBe("NOT_CONFIGURED")
      expect(result.orderingAllowed).toBe(true)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })
  })

  describe("with the toggle on", () => {
    beforeEach(async () => {
      await setToggle(f.organizationId, true)
    })

    it("no unpaid invoices → CLEAR and the order is accepted", async () => {
      const result = await status(f.alphaNorthId)
      expect(result).toMatchObject({ state: "CLEAR", overdueCount: 0, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("one unpaid invoice → WARNING and the order is still accepted", async () => {
      await invoice({ branchId: f.alphaNorthId })
      expect(await status(f.alphaNorthId)).toMatchObject({ state: "WARNING", overdueCount: 1, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("two unpaid invoices → the order is refused with 409, the popup's message, and no row is written", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      const before = await ordersAt(f.alphaNorthId)

      const { status: code, body } = await orderFor(f.alphaNorthId)

      expect(code).toBe(409)
      expect(body).toEqual({
        error: BLOCKED_MESSAGE,
        code: "PAYMENT_CONTROL_BLOCKED",
        paymentControl: {
          code: "PAYMENT_CONTROL_BLOCKED",
          state: "BLOCKED",
          reason: "THRESHOLD_REACHED",
          overdueCount: 2,
          threshold: 2,
          exceptionExpiredAt: null,
        },
      })
      expect(await ordersAt(f.alphaNorthId)).toBe(before)
    })

    it("more than two → still refused, and the message carries the real count", async () => {
      for (let index = 0; index < 3; index += 1) await invoice({ branchId: f.alphaNorthId })
      const { status: code, body } = await orderFor(f.alphaNorthId)
      expect(code).toBe(409)
      expect(body.error).toBe("You have 3 unpaid invoices. Please pay your dues before placing a new order.")
    })

    it("counts only fulfilled, delivered, invoiced, unpaid orders", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId, paymentStatus: "PAID" })
      await invoice({ branchId: f.alphaNorthId, status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
      await invoice({ branchId: f.alphaNorthId, fulfillmentStatus: "OUT_FOR_DELIVERY" })
      await invoice({ branchId: f.alphaNorthId, status: "REFUNDED" })
      await invoice({ branchId: f.alphaNorthId, status: "PENDING", fulfillmentStatus: "NOT_STARTED" })
      await invoice({ branchId: f.alphaNorthId, receiptData: null })

      expect(await status(f.alphaNorthId)).toMatchObject({ state: "WARNING", overdueCount: 1, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("the block follows the branch: another branch's unpaid invoices do not count", async () => {
      await invoice({ branchId: f.alphaSouthId })
      await invoice({ branchId: f.alphaSouthId })

      expect((await status(f.alphaNorthId)).state).toBe("CLEAR")
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
      expect((await orderFor(f.alphaSouthId)).status).toBe(409)
    })

    it("blocks every role ordering for that branch, Super Admin included", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      expect((await orderFor(f.alphaNorthId, headOffice())).status).toBe(409)
      expect((await orderFor(f.alphaNorthId, superAdmin())).status).toBe(409)
    })

    it("lists the invoices with their numbers and delivery dates, never an amount", async () => {
      const first = new Date("2026-08-01T10:00:00.000Z")
      const second = new Date("2026-08-15T10:00:00.000Z")
      await invoice({ branchId: f.alphaNorthId, deliveredAt: second, receiptData: { invoiceNumber: "INV-B" } })
      await invoice({ branchId: f.alphaNorthId, deliveredAt: first, receiptData: { invoiceNumber: "INV-A" } })

      const result = await status(f.alphaNorthId)
      expect(result.overdueItems).toEqual([
        { reference: "INV-A", overdueSince: first, amountCents: null },
        { reference: "INV-B", overdueSince: second, amountCents: null },
      ])
      expect(result.blockedSince).toEqual(second)
    })

    it("names an invoice without a number by its TID", async () => {
      const id = await invoice({ branchId: f.alphaNorthId, receiptData: { lines: [] } })
      const [row] = await db.select({ tid: orders.tid }).from(orders).where(eq(orders.id, id))
      expect((await status(f.alphaNorthId)).overdueItems.map((item) => item.reference)).toEqual([row.tid])
    })

    it("marking an invoice paid through the Super Admin control unblocks the branch", async () => {
      const firstId = await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(superAdmin())
      const paid = await paymentStatusRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${firstId}/payment-status`, { paymentStatus: "PAID" }),
        { params: Promise.resolve({ id: String(firstId) }) },
      )
      expect(paid.status).toBe(200)

      expect(await status(f.alphaNorthId)).toMatchObject({ state: "WARNING", overdueCount: 1, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("only Super Admin can mark an invoice paid — Head Office cannot clear its own block", async () => {
      const firstId = await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })

      signIn(headOffice())
      const refused = await paymentStatusRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${firstId}/payment-status`, { paymentStatus: "PAID" }),
        { params: Promise.resolve({ id: String(firstId) }) },
      )
      expect(refused.status).toBe(403)
      expect((await status(f.alphaNorthId)).orderingAllowed).toBe(false)
    })

    it("a Head Office exception lets the blocked branch order", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })

      signIn(headOffice())
      const granted = await read(await grantRoute.POST(request(
        "POST",
        "http://localhost/api/v1/payment-control/exceptions",
        { branchId: f.alphaNorthId, reason: "Cheque in transit" },
      )))
      expect(granted.status).toBe(201)
      expect(granted.body).toMatchObject({ state: "BLOCKED", exceptionActive: true, orderingAllowed: true })

      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("switching the toggle off lifts the block at once", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: false })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })

    it("a group order fails only the blocked branch, with the code and count, and creates the others", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      signIn(requester())

      const response = await groupOrdersRoute.POST(request(
        "POST",
        "http://localhost/api/v1/group-portal/orders",
        { groupId: f.alphaGroupId, entries: [{ branchIds: [f.alphaNorthId, f.alphaSouthId], items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
        { "Idempotency-Key": idempotencyKey() },
      ))
      const body = await response.json()

      expect(response.status).toBe(201)
      const byBranch = new Map<number, Record<string, unknown>>(
        body.item.results.map((result: Record<string, unknown>) => [result.branchId as number, result]),
      )
      expect(byBranch.get(f.alphaNorthId)).toMatchObject({
        status: "failed",
        reason: BLOCKED_MESSAGE,
        code: "PAYMENT_CONTROL_BLOCKED",
        unpaidInvoiceCount: 2,
      })
      expect(byBranch.get(f.alphaSouthId)).toMatchObject({ status: "created" })
      expect(byBranch.get(f.alphaSouthId)).not.toHaveProperty("code")
    })

    it("the status read tells a requester their branch is blocked, without amounts", async () => {
      await invoice({ branchId: f.alphaNorthId })
      await invoice({ branchId: f.alphaNorthId })
      signIn(requester())

      const { status: code, body } = await read(await statusRoute.GET(
        request("GET", `http://localhost/api/v1/payment-control?branchId=${f.alphaNorthId}`),
      ))
      expect(code).toBe(200)
      expect(body).toMatchObject({ orderingAllowed: false, overdueCount: 2, threshold: 2, reason: "THRESHOLD_REACHED" })
      expect(body.overdueItems.every((item: { amountCents: unknown }) => item.amountCents === null)).toBe(true)
    })
  })

  describe("tenant isolation", () => {
    it("the toggle belongs to one organization: another tenant's unpaid invoices block nothing while it is off", async () => {
      await setToggle(f.organizationId, true)
      await invoice({ organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })
      await invoice({ organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })

      expect((await status(f.foreignBranchId, f.foreignOrganizationId)).state).toBe("NOT_CONFIGURED")
      expect((await status(f.alphaNorthId)).state).toBe("CLEAR")
    })

    it("the count is fenced by the organization as well as the branch", async () => {
      await setToggle(f.organizationId, true)
      // A row naming this tenant's branch under another tenant must not count
      // toward it: the count carries both predicates.
      await invoice({ organizationId: f.foreignOrganizationId, branchId: f.alphaNorthId })
      await invoice({ organizationId: f.foreignOrganizationId, branchId: f.alphaNorthId })

      expect((await status(f.alphaNorthId)).state).toBe("CLEAR")
    })

    it("a foreign Head Office cannot read another tenant's branch status", async () => {
      await setToggle(f.organizationId, true)
      signIn(foreignHeadOffice())
      const response = await statusRoute.GET(request("GET", `http://localhost/api/v1/payment-control?branchId=${f.alphaNorthId}`))
      expect(response.status).toBe(404)
    })
  })

  describe("who may set the toggle", () => {
    it("Super Admin switches it on in Edit Company, audited with what it replaced", async () => {
      signIn(superAdmin())
      const { status: code, body } = await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })

      expect(code).toBe(200)
      expect(body.item.blockOrderingOnUnpaidInvoices).toBe(true)
      const [row] = await db.select({ enabled: organizations.blockOrderingOnUnpaidInvoices }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.enabled).toBe(true)

      const [audit] = await toggleAudits(f.organizationId)
      expect(audit.userId).toBe(f.superAdminId)
      expect(audit.entityId).toBe(String(f.organizationId))
      expect(audit.metadata).toEqual({ previousBlockOrderingOnUnpaidInvoices: false, blockOrderingOnUnpaidInvoices: true })
    })

    it("saving the same value again writes no second audit row", async () => {
      signIn(superAdmin())
      await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })
      const before = (await toggleAudits(f.organizationId)).length
      await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })
      expect((await toggleAudits(f.organizationId)).length).toBe(before)
    })

    it.each([
      ["Head Office", () => headOffice()],
      ["Branch Admin", () => branchAdmin()],
      ["a group approver", () => approver()],
      ["a group requester", () => requester()],
      ["an Order Portal user", () => orderPortal()],
    ])("%s cannot change it — 403 and the column is untouched", async (_label, actor) => {
      signIn(actor())
      const { status: code } = await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })
      expect(code).toBe(403)
      const [row] = await db.select({ enabled: organizations.blockOrderingOnUnpaidInvoices }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.enabled).toBe(false)
    })

    it("an unauthenticated caller gets 401", async () => {
      signIn(null)
      expect((await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })).status).toBe(401)
    })

    it("a non-boolean is refused with 400", async () => {
      signIn(superAdmin())
      const { status: code } = await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: "true" })
      expect(code).toBe(400)
    })

    it("Super Admin can create an organization with it on, and the creation audit records it", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status: code, body } = await read(await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: `UIB Company ${suffix}`, code: `UIB${suffix}`, blockOrderingOnUnpaidInvoices: true },
      )))

      expect(code).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(body.item.blockOrderingOnUnpaidInvoices).toBe(true)
      const [audit] = await db
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, body.item.id), eq(auditLogs.action, "CREATE_ORGANIZATION")))
      expect(audit.metadata).toMatchObject({ blockOrderingOnUnpaidInvoices: true })
    })

    it("an organization created without it is off", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status: code, body } = await read(await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: `UIB Default ${suffix}`, code: `UIBD${suffix}` },
      )))
      expect(code).toBe(201)
      createdOrganizationIds.push(body.item.id)
      expect(body.item.blockOrderingOnUnpaidInvoices).toBe(false)
    })

    it("Head Office cannot create an organization at all, with or without it", async () => {
      signIn(headOffice())
      const response = await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: "Sneaky Company", code: "SNEAKY", blockOrderingOnUnpaidInvoices: false },
      ))
      expect(response.status).toBe(403)
    })
  })
})
