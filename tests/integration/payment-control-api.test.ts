import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray } from "drizzle-orm"

import * as statusRoute from "@/app/api/v1/payment-control/route"
import * as grantRoute from "@/app/api/v1/payment-control/exceptions/route"
import * as revokeRoute from "@/app/api/v1/payment-control/exceptions/[id]/revoke/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import {
  auditLogs,
  branchInventory,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  invoiceSequences,
  orderItems,
  orders,
  organizationInventory,
  paymentControlExceptions,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { NOT_CONFIGURED_OVERDUE_SUMMARY, type OverduePaymentSummary } from "@/lib/payment-control-policy"
import {
  PAYMENT_CONTROL_EXCEPTION_GRANTED_AUDIT_ACTION,
  PAYMENT_CONTROL_EXCEPTION_REVOKED_AUDIT_ACTION,
  resolveBranchPaymentControl,
} from "@/lib/server/payment-control"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The overdue-payment seam is the one thing this suite fakes: production has
 * no source (plan §"What the investigation found"), so the tests supply one
 * per branch to prove that the real resolver, the real routes and the real
 * order paths block, except, expire, revoke and clear against Postgres.
 */
const mocks = vi.hoisted(() => ({
  overdueByBranch: new Map<number, OverduePaymentSummary>(),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// The order routes read the request headers for their audit rows; there is
// no Next request store under vitest.
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
vi.mock("@/lib/server/overdue-payment-source", () => ({
  overduePaymentSource: vi.fn(async (_client: unknown, scope: { branchId: number }) =>
    mocks.overdueByBranch.get(scope.branchId) ?? NOT_CONFIGURED_OVERDUE_SUMMARY),
}))

const { getServerSession } = mockedNextAuth
const { GET: readStatus } = statusRoute
const { POST: grant } = grantRoute
const { POST: revoke } = revokeRoute
const { POST: createOrder } = ordersRoute
const { POST: createGroupOrder } = groupOrdersRoute

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const json = (url: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
})

const overdue = (count: number): OverduePaymentSummary => ({
  configured: true,
  overdueCount: count,
  items: Array.from({ length: count }, (_, index) => ({
    reference: `INV-${index + 1}`,
    overdueSince: new Date(Date.UTC(2026, 7, 1 + index)),
    amountCents: 10_000,
  })),
})

let idempotencyCounter = 0
const idempotencyKey = () => `pc-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`

describe.skipIf(!hasTestDatabase)("branch payment control", () => {
  let f: GroupRoleFixtures
  let inventoryId: number

  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })

  const exceptionRows = (branchId: number) => db
    .select()
    .from(paymentControlExceptions)
    .where(eq(paymentControlExceptions.branchId, branchId))
    .orderBy(desc(paymentControlExceptions.id))

  const auditRows = (branchId: number, action: string) => db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.branchId, branchId), eq(auditLogs.action, action)))
    .orderBy(desc(auditLogs.id))

  const status = (branchId: number) => resolveBranchPaymentControl(db, { organizationId: f.organizationId, branchId })

  const grantFor = (branchId: number, reason?: string) =>
    grant(json("http://localhost/api/v1/payment-control/exceptions", reason ? { branchId, reason } : { branchId }))
      .then(async (response) => ({ status: response.status, body: await response.json() }))

  const revokeFor = (exceptionId: number, reason?: string) =>
    revoke(
      json(`http://localhost/api/v1/payment-control/exceptions/${exceptionId}/revoke`, reason ? { reason } : {}),
      { params: Promise.resolve({ id: String(exceptionId) }) },
    ).then(async (response) => ({ status: response.status, body: await response.json() }))

  const orderFor = (branchId: number) => createOrder(json(
    "http://localhost/api/v1/orders",
    { branchId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
    { "Idempotency-Key": idempotencyKey() },
  )).then(async (response) => ({ status: response.status, body: await response.json() }))

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

  // The real order routes write rows the fixture helper does not know about
  // (orders and lines, group envelopes and their audit, the invoice counter),
  // so everything the throwaway tenants own goes first, in foreign-key order.
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
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    mocks.overdueByBranch.clear()
    vi.mocked(getServerSession).mockReset()
  })

  describe("with no overdue-payment source connected", () => {
    it("every branch is NOT_CONFIGURED and ordering is allowed — nothing in production is blocked by this change", async () => {
      const result = await status(f.alphaNorthId)
      expect(result.state).toBe("NOT_CONFIGURED")
      expect(result.orderingAllowed).toBe(true)
      expect(result.timeline).toEqual([])
    })

    it("an order goes through exactly as before", async () => {
      signIn(headOffice())
      const { status: code } = await orderFor(f.alphaNorthId)
      expect(code).toBe(200)
    })
  })

  describe("with a source", () => {
    it("below the threshold → WARNING and the order is accepted", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(1))
      signIn(headOffice())

      expect((await status(f.alphaNorthId)).state).toBe("WARNING")
      const { status: code } = await orderFor(f.alphaNorthId)
      expect(code).toBe(200)
    })

    it("at the threshold → BLOCKED: a direct API order is refused with the stable code and no row is written", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(headOffice())
      const before = (await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.alphaNorthId))).length

      const { status: code, body } = await orderFor(f.alphaNorthId)

      expect(code).toBe(409)
      expect(body.code).toBe("PAYMENT_CONTROL_BLOCKED")
      expect(body.paymentControl).toEqual({
        code: "PAYMENT_CONTROL_BLOCKED",
        state: "BLOCKED",
        reason: "THRESHOLD_REACHED",
        overdueCount: 2,
        threshold: 2,
        exceptionExpiredAt: null,
      })
      expect(body.error).toBe("You have 2 unpaid invoices. Please pay your dues before placing a new order.")
      const after = (await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.alphaNorthId))).length
      expect(after).toBe(before)
    })

    it("the block follows the branch, not the caller: a clear branch of the same tenant still orders", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      mocks.overdueByBranch.set(f.alphaSouthId, overdue(0))
      signIn(headOffice())
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
      expect((await orderFor(f.alphaSouthId)).status).toBe(200)
    })

    it("a group order reports the blocked branch as failed and still creates the others", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(requester())

      const response = await createGroupOrder(json(
        "http://localhost/api/v1/group-portal/orders",
        { groupId: f.alphaGroupId, entries: [{ branchIds: [f.alphaNorthId, f.alphaSouthId], items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
        { "Idempotency-Key": idempotencyKey() },
      ))
      const body = await response.json()
      expect(response.status).toBe(201)
      const byBranch = new Map<number, { status: string; reason?: string; orderId?: number }>(
        body.item.results.map((result: { branchId: number; status: string; reason?: string; orderId?: number }) => [result.branchId, result]),
      )
      expect(byBranch.get(f.alphaNorthId)).toMatchObject({
        status: "failed",
        reason: "You have 2 unpaid invoices. Please pay your dues before placing a new order.",
        code: "PAYMENT_CONTROL_BLOCKED",
        unpaidInvoiceCount: 2,
      })
      expect(byBranch.get(f.alphaSouthId)).toMatchObject({ status: "created" })
    })

    it("existing orders are untouched by a block", async () => {
      const [existing] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, f.alphaNorthOrderId))
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(headOffice())
      await orderFor(f.alphaNorthId)
      const [after] = await db.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, f.alphaNorthOrderId))
      expect(after).toEqual(existing)
    })
  })

  describe("the Head Office exception", () => {
    let exceptionId: number

    it("cannot be granted by an approver, a requester, or a foreign Head Office", async () => {
      for (const actor of [approver(), requester()]) {
        signIn(actor)
        expect((await grantFor(f.alphaNorthId)).status).toBe(403)
      }
      signIn(foreignHeadOffice())
      expect((await grantFor(f.alphaNorthId)).status).toBe(404)
      expect(await exceptionRows(f.alphaNorthId)).toHaveLength(0)
    })

    it("is granted by Head Office for one month, audited in the same transaction", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(headOffice())

      const { status: code, body } = await grantFor(f.alphaNorthId, "Cheque in transit")

      expect(code).toBe(201)
      expect(body.orderingAllowed).toBe(true)
      expect(body.exceptionActive).toBe(true)
      expect(body.reason).toBe("EXCEPTION_ACTIVE")
      const [row] = await exceptionRows(f.alphaNorthId)
      exceptionId = row.id
      expect(row.grantedByUserId).toBe(f.headOfficeId)
      expect(row.reason).toBe("Cheque in transit")
      expect(row.revokedAt).toBeNull()
      expect(row.expiresAt.getTime() - row.startAt.getTime()).toBeGreaterThan(27 * 24 * 60 * 60 * 1000)
      expect(row.expiresAt.getTime() - row.startAt.getTime()).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000)

      const [audit] = await auditRows(f.alphaNorthId, PAYMENT_CONTROL_EXCEPTION_GRANTED_AUDIT_ACTION)
      expect(audit.userId).toBe(f.headOfficeId)
      expect(audit.organizationId).toBe(f.organizationId)
      expect(audit.entity).toBe("BRANCH")
      expect(audit.entityId).toBe(String(f.alphaNorthId))
      expect(audit.metadata).toMatchObject({
        exceptionId,
        actorRole: "HEAD_OFFICE",
        reason: "Cheque in transit",
        expiresAt: row.expiresAt.toISOString(),
        stateBefore: { state: "BLOCKED", orderingAllowed: false, overdueCount: 2, threshold: 2 },
      })
    })

    it("lets the blocked branch order again, through both paths", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(headOffice())
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      signIn(requester())
      const response = await createGroupOrder(json(
        "http://localhost/api/v1/group-portal/orders",
        { groupId: f.alphaGroupId, entries: [{ branchIds: [f.alphaNorthId], items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
        { "Idempotency-Key": idempotencyKey() },
      ))
      const body = await response.json()
      expect(body.item.results[0]).toMatchObject({ branchId: f.alphaNorthId, status: "created" })
    })

    it("a second grant while one is in force is a 409 and writes nothing", async () => {
      signIn(headOffice())
      const { status: code, body } = await grantFor(f.alphaNorthId)
      expect(code).toBe(409)
      expect(body.exception.id).toBe(exceptionId)
      expect(await exceptionRows(f.alphaNorthId)).toHaveLength(1)
    })

    it("an ordering-side read of the status shows the exception without the granter or the reason", async () => {
      signIn(requester())
      const response = await readStatus(new NextRequest(`http://localhost/api/v1/payment-control?branchId=${f.alphaNorthId}`))
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.canManageExceptions).toBe(false)
      expect(body.exception).toMatchObject({ id: exceptionId, active: true, reason: null, grantedBy: null })
    })

    it("a requester cannot read a branch outside its assignment", async () => {
      signIn(requester())
      const response = await readStatus(new NextRequest(`http://localhost/api/v1/payment-control?branchId=${f.foreignBranchId}`))
      expect(response.status).toBe(403)
    })

    it("a foreign Head Office cannot read or revoke it", async () => {
      signIn(foreignHeadOffice())
      expect((await readStatus(new NextRequest(`http://localhost/api/v1/payment-control?branchId=${f.alphaNorthId}`))).status).toBe(404)
      expect((await revokeFor(exceptionId)).status).toBe(404)
      const [row] = await exceptionRows(f.alphaNorthId)
      expect(row.revokedAt).toBeNull()
    })

    it("stops authorising at its expiry instant, with no job having run", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      const [row] = await exceptionRows(f.alphaNorthId)

      const justBefore = await resolveBranchPaymentControl(db, { organizationId: f.organizationId, branchId: f.alphaNorthId }, new Date(row.expiresAt.getTime() - 1))
      expect(justBefore.orderingAllowed).toBe(true)
      const atExpiry = await resolveBranchPaymentControl(db, { organizationId: f.organizationId, branchId: f.alphaNorthId }, row.expiresAt)
      expect(atExpiry.orderingAllowed).toBe(false)
      expect(atExpiry.reason).toBe("EXCEPTION_EXPIRED")
    })

    it("payments cleared while it is live → CLEAR, ordering allowed on the normal footing", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(0))
      const result = await status(f.alphaNorthId)
      expect(result.state).toBe("CLEAR")
      expect(result.reason).toBe("NO_OVERDUE_PAYMENTS")
      expect(result.orderingAllowed).toBe(true)
    })

    it("is revoked early by Head Office, audited, and the branch is refused again", async () => {
      mocks.overdueByBranch.set(f.alphaNorthId, overdue(2))
      signIn(headOffice())

      const { status: code, body } = await revokeFor(exceptionId, "Paid by another route")

      expect(code).toBe(200)
      expect(body.orderingAllowed).toBe(false)
      expect(body.reason).toBe("EXCEPTION_REVOKED")
      const [row] = await exceptionRows(f.alphaNorthId)
      expect(row.revokedAt).not.toBeNull()
      expect(row.revokedByUserId).toBe(f.headOfficeId)
      expect(row.revokeReason).toBe("Paid by another route")
      const [audit] = await auditRows(f.alphaNorthId, PAYMENT_CONTROL_EXCEPTION_REVOKED_AUDIT_ACTION)
      expect(audit.metadata).toMatchObject({ exceptionId, revokeReason: "Paid by another route", stateBefore: { orderingAllowed: true } })

      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it("cannot be revoked twice", async () => {
      signIn(headOffice())
      expect((await revokeFor(exceptionId)).status).toBe(409)
    })

    it("a new grant is allowed once the old one is no longer in force, and Super Admin may grant it", async () => {
      signIn(superAdmin())
      const { status: code } = await grantFor(f.alphaNorthId)
      expect(code).toBe(201)
      expect(await exceptionRows(f.alphaNorthId)).toHaveLength(2)
      const [latest] = await exceptionRows(f.alphaNorthId)
      expect(latest.grantedByUserId).toBe(f.superAdminId)
    })
  })
})
