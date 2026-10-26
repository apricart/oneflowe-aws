import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like } from "drizzle-orm"

import * as alertsRoute from "@/app/api/v1/payment-control/ordering-alerts/route"
import { branches, orders, organizations, paymentControlExceptions, roles, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { resolveBranchPaymentControl } from "@/lib/server/payment-control"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The unpaid-invoice alerts against Postgres
 * (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md). The count is the real
 * gate predicate over real order rows and the exception is the real latest
 * grant; only the session is stubbed. Every "blocked" here is also checked
 * against the gate's own decision, so the alert cannot say blocked while an
 * order would go through, or the reverse.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }
type Entry = { branchId: number; branchName: string; unpaidInvoiceCount: number; threshold: number }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const TID_PREFIX = "UIA-"
const DAY_MS = 24 * 60 * 60 * 1000
let invoiceCounter = 0

describe.skipIf(!hasTestDatabase)("the unpaid-invoice alerts", () => {
  let f: GroupRoleFixtures
  let orderPortalId: string
  let branchAdminId: string

  // The single-branch roles read their branch from their own users row, never
  // the session, so each has a real account: the initiator at North, the
  // approver at South.
  const orderPortal = (): Actor => ({ id: orderPortalId, email: `op-${f.suffix}@example.test`, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const branchAdmin = (): Actor => ({ id: branchAdminId, email: `ba-${f.suffix}@example.test`, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaSouthId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const emptyApprover = (): Actor => ({ id: f.emptyApproverId, email: `ea-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })

  const configure = (organizationId: number, enabled: boolean, threshold = 4) =>
    db.update(organizations)
      .set({ blockOrderingOnUnpaidInvoices: enabled, unpaidInvoiceBlockThreshold: threshold })
      .where(eq(organizations.id, organizationId))

  async function unpaidInvoices(branchId: number, howMany: number, overrides: Partial<typeof orders.$inferInsert> = {}, organizationId = f.organizationId) {
    for (let index = 0; index < howMany; index += 1) {
      invoiceCounter += 1
      await db.insert(orders).values({
        tid: `${TID_PREFIX}${f.suffix}-${invoiceCounter}`.slice(0, 26),
        organizationId,
        branchId,
        createdByUserId: f.headOfficeId,
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        paymentStatus: "UNPAID",
        receiptData: { invoiceNumber: `INV-UIA-${invoiceCounter}` } as any,
        deliveredAt: new Date(Date.UTC(2026, 8, 1)),
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
        ...overrides,
      })
    }
  }

  const exception = (branchId: number, window: { startAt: Date; expiresAt: Date; revokedAt?: Date | null }) =>
    db.insert(paymentControlExceptions).values({
      organizationId: f.organizationId,
      branchId,
      grantedByUserId: f.headOfficeId,
      startAt: window.startAt,
      expiresAt: window.expiresAt,
      revokedAt: window.revokedAt ?? null,
    })

  async function alertsAs(actor: Actor | null) {
    signIn(actor)
    const response = await alertsRoute.GET()
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("Cache-Control") }
  }

  const ids = (entries: Entry[]) => entries.map((entry) => entry.branchId).sort((left, right) => left - right)
  const gateAllows = async (branchId: number) =>
    (await resolveBranchPaymentControl(db, { organizationId: f.organizationId, branchId })).orderingAllowed

  async function branchAccount(roleName: string, label: string, branchId: number): Promise<string> {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, roleName)).limit(1)
    const [row] = await db
      .insert(users)
      .values({
        email: `it-uia-${label}-${f.suffix}@example.test`,
        username: `it-uia-${label}-${f.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: role.id,
        organizationId: f.organizationId,
        branchId,
        firstName: label,
        lastName: f.suffix,
        fullName: `${label} ${f.suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const cleanRows = async () => {
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(orders).where(and(inArray(orders.organizationId, organizationIds), like(orders.tid, `${TID_PREFIX}%`)))
    await db.delete(paymentControlExceptions).where(inArray(paymentControlExceptions.organizationId, organizationIds))
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    orderPortalId = await branchAccount("ORDER_PORTAL", "op", f.alphaNorthId)
    branchAdminId = await branchAccount("BRANCH_ADMIN", "ba", f.alphaSouthId)
  })

  afterAll(async () => {
    if (!f) return
    await cleanRows()
    await destroyGroupRoleFixtures(f, [orderPortalId, branchAdminId].filter(Boolean))
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await cleanRows()
    await db.update(branches).set({ status: "active" }).where(inArray(branches.id, [f.alphaNorthId, f.alphaSouthId, f.betaBranchId]))
    await configure(f.organizationId, true, 4)
    await configure(f.foreignOrganizationId, false, 2)
  })

  describe("who may ask", () => {
    it("refuses an unauthenticated caller with 401", async () => {
      expect((await alertsAs(null)).status).toBe(401)
    })

    it.each(["SUPER_ADMIN", "HEAD_OFFICE", "VIEWER", "WAREHOUSE", "ORDER_DESK", "APRICART_EXECUTIVE"])("refuses %s with 403", async (role) => {
      const { status } = await alertsAs({ id: f.headOfficeId, email: `x-${f.suffix}@example.test`, role, organizationId: role === "HEAD_OFFICE" || role === "VIEWER" ? f.organizationId : null })
      expect(status).toBe(403)
    })

    it("is never cached by a shared cache", async () => {
      expect((await alertsAs(orderPortal())).cacheControl).toBe("private, no-store, max-age=0")
    })
  })

  describe("an Order Initiator", () => {
    it("is told nothing two short of the limit", async () => {
      await unpaidInvoices(f.alphaNorthId, 2)
      expect((await alertsAs(orderPortal())).body).toEqual({ blocked: [], lastOrder: [], otherBranchesCanOrder: true, otherBranchesUnaffected: true })
    })

    it("is warned of its last order one short of the limit", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      const { status, body } = await alertsAs(orderPortal())
      expect(status).toBe(200)
      expect(body).toEqual({
        blocked: [],
        lastOrder: [{ branchId: f.alphaNorthId, branchName: f.names.alphaNorth, unpaidInvoiceCount: 3, threshold: 4 }],
        otherBranchesCanOrder: true,
        otherBranchesUnaffected: false,
      })
      expect(await gateAllows(f.alphaNorthId)).toBe(true)
    })

    it("is told it is blocked at the limit, exactly when the gate refuses", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      const { body } = await alertsAs(orderPortal())
      expect(body.blocked).toEqual([{ branchId: f.alphaNorthId, branchName: f.names.alphaNorth, unpaidInvoiceCount: 4, threshold: 4 }])
      expect(body.lastOrder).toEqual([])
      expect(await gateAllows(f.alphaNorthId)).toBe(false)
    })

    it("is still told it is blocked past the limit, with the real count", async () => {
      await unpaidInvoices(f.alphaNorthId, 6)
      expect((await alertsAs(orderPortal())).body.blocked[0].unpaidInvoiceCount).toBe(6)
    })

    it("is blocked by its first unpaid invoice on a limit of 1, and never warned of a last order", async () => {
      await configure(f.organizationId, true, 1)
      expect((await alertsAs(orderPortal())).body).toMatchObject({ blocked: [], lastOrder: [] })
      await unpaidInvoices(f.alphaNorthId, 1)
      expect(ids((await alertsAs(orderPortal())).body.blocked)).toEqual([f.alphaNorthId])
    })

    it("follows the organization's own limit", async () => {
      await unpaidInvoices(f.alphaNorthId, 2)
      await configure(f.organizationId, true, 2)
      expect((await alertsAs(orderPortal())).body.blocked).toHaveLength(1)
      await configure(f.organizationId, true, 3)
      expect((await alertsAs(orderPortal())).body).toMatchObject({ blocked: [], lastOrder: [{ unpaidInvoiceCount: 2, threshold: 3 }] })
    })

    it("is told nothing while the organization's block is off, however much is unpaid", async () => {
      await unpaidInvoices(f.alphaNorthId, 6)
      await configure(f.organizationId, false, 4)
      expect((await alertsAs(orderPortal())).body).toEqual({ blocked: [], lastOrder: [], otherBranchesCanOrder: false, otherBranchesUnaffected: false })
      expect(await gateAllows(f.alphaNorthId)).toBe(true)
    })

    it("counts exactly what the gate counts", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      await unpaidInvoices(f.alphaNorthId, 1, { paymentStatus: "PAID" })
      await unpaidInvoices(f.alphaNorthId, 1, { fulfillmentStatus: "OUT_FOR_DELIVERY" })
      await unpaidInvoices(f.alphaNorthId, 1, { status: "APPROVED" })
      await unpaidInvoices(f.alphaNorthId, 1, { receiptData: null })
      await unpaidInvoices(f.alphaNorthId, 1, { refundAmountCents: 10_000 })
      expect((await alertsAs(orderPortal())).body).toMatchObject({ blocked: [], lastOrder: [{ unpaidInvoiceCount: 3 }] })
      await unpaidInvoices(f.alphaNorthId, 1)
      expect((await alertsAs(orderPortal())).body).toMatchObject({ blocked: [{ unpaidInvoiceCount: 4 }], lastOrder: [] })
    })

    it("hears only about its own branch, and a branch id in its session does not widen it", async () => {
      await unpaidInvoices(f.alphaSouthId, 4)
      expect((await alertsAs(orderPortal())).body.blocked).toEqual([])
      expect((await alertsAs({ ...orderPortal(), branchId: f.alphaSouthId })).body.blocked).toEqual([])
    })

    it("carries no amount and no invoice reference", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      const [entry] = (await alertsAs(orderPortal())).body.blocked
      expect(Object.keys(entry).sort()).toEqual(["branchId", "branchName", "threshold", "unpaidInvoiceCount"])
    })
  })

  describe("a Head Office exception", () => {
    const now = () => Date.now()

    it("in force: the branch may order, so it is told neither", async () => {
      await unpaidInvoices(f.alphaNorthId, 5)
      await exception(f.alphaNorthId, { startAt: new Date(now() - DAY_MS), expiresAt: new Date(now() + DAY_MS) })
      expect((await alertsAs(orderPortal())).body).toMatchObject({ blocked: [], lastOrder: [] })
      expect(await gateAllows(f.alphaNorthId)).toBe(true)
    })

    it("expired: blocked again", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await exception(f.alphaNorthId, { startAt: new Date(now() - 3 * DAY_MS), expiresAt: new Date(now() - DAY_MS) })
      expect(ids((await alertsAs(orderPortal())).body.blocked)).toEqual([f.alphaNorthId])
      expect(await gateAllows(f.alphaNorthId)).toBe(false)
    })

    it("revoked: blocked again", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await exception(f.alphaNorthId, { startAt: new Date(now() - DAY_MS), expiresAt: new Date(now() + DAY_MS), revokedAt: new Date(now() - 1000) })
      expect(ids((await alertsAs(orderPortal())).body.blocked)).toEqual([f.alphaNorthId])
      expect(await gateAllows(f.alphaNorthId)).toBe(false)
    })
  })

  describe("a Financial Approver", () => {
    it("is told about its own branch only", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await unpaidInvoices(f.alphaSouthId, 4)
      const { body } = await alertsAs(branchAdmin())
      expect(ids(body.blocked)).toEqual([f.alphaSouthId])
    })
  })

  describe("the group roles", () => {
    it("a Group Order Initiator is told each branch's state, and that it can still order elsewhere", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await unpaidInvoices(f.alphaSouthId, 3)
      const { body } = await alertsAs(requester())
      expect(ids(body.blocked)).toEqual([f.alphaNorthId])
      expect(ids(body.lastOrder)).toEqual([f.alphaSouthId])
      expect(body.otherBranchesCanOrder).toBe(true)
      expect(body.otherBranchesUnaffected).toBe(true)
    })

    it("a Group Financial Approver is told only about its assigned branches", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await unpaidInvoices(f.betaBranchId, 4)
      const { body } = await alertsAs(approver())
      expect(body).toEqual({
        blocked: [{ branchId: f.alphaNorthId, branchName: f.names.alphaNorth, unpaidInvoiceCount: 4, threshold: 4 }],
        lastOrder: [],
        otherBranchesCanOrder: true,
        otherBranchesUnaffected: true,
      })
    })

    it("says no branch can order when every assigned branch is blocked", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      await unpaidInvoices(f.alphaSouthId, 4)
      expect((await alertsAs(approver())).body).toMatchObject({ otherBranchesCanOrder: false, otherBranchesUnaffected: false })
    })

    it("an approver with no assignments hears nothing, never the tenant", async () => {
      await unpaidInvoices(f.alphaNorthId, 4)
      expect((await alertsAs(emptyApprover())).body).toEqual({ blocked: [], lastOrder: [], otherBranchesCanOrder: false, otherBranchesUnaffected: false })
    })

    it("leaves out an inactive branch, which cannot order", async () => {
      await unpaidInvoices(f.alphaSouthId, 4)
      await db.update(branches).set({ status: "inactive" }).where(eq(branches.id, f.alphaSouthId))
      expect((await alertsAs(approver())).body).toEqual({ blocked: [], lastOrder: [], otherBranchesCanOrder: true, otherBranchesUnaffected: true })
    })

    it("never names another tenant's branch, even through a stale assignment", async () => {
      await configure(f.foreignOrganizationId, true, 4)
      await unpaidInvoices(f.foreignBranchId, 4, {}, f.foreignOrganizationId)
      const { body } = await alertsAs(requester())
      expect(body.blocked).toEqual([])
      expect(JSON.stringify(body)).not.toContain("Foreign")
    })
  })
})
