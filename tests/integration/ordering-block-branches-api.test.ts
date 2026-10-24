import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like } from "drizzle-orm"

import * as listRoute from "@/app/api/v1/payment-control/branches/route"
import * as grantRoute from "@/app/api/v1/payment-control/exceptions/route"
import { branches, orders, organizations, paymentControlExceptions } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { resolveBranchPaymentControl } from "@/lib/server/payment-control"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Head Office's Ordering Blocks list against Postgres
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md). The count
 * is the real gate predicate over real order rows, the exceptions are real
 * grants, and only the session is stubbed. Every standing is checked against
 * the gate's own decision, so the page cannot say blocked while an order would
 * go through, or the reverse.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }
type Row = { branchId: number; standing: string; unpaidInvoiceCount: number; orderingAllowed: boolean; exception: { active: boolean } | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const TID_PREFIX = "OBL-"
const DAY_MS = 24 * 60 * 60 * 1000
let invoiceCounter = 0

describe.skipIf(!hasTestDatabase)("the Ordering Blocks list", () => {
  let f: GroupRoleFixtures

  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })

  const configure = (organizationId: number, enabled: boolean, threshold = 3) =>
    db.update(organizations)
      .set({ blockOrderingOnUnpaidInvoices: enabled, unpaidInvoiceBlockThreshold: threshold })
      .where(eq(organizations.id, organizationId))

  async function unpaidInvoices(branchId: number, howMany: number, organizationId = f.organizationId, overrides: Partial<typeof orders.$inferInsert> = {}) {
    for (let index = 0; index < howMany; index += 1) {
      invoiceCounter += 1
      await db.insert(orders).values({
        tid: `${TID_PREFIX}${f.suffix}-${invoiceCounter}`.slice(0, 26),
        organizationId,
        branchId,
        createdByUserId: organizationId === f.organizationId ? f.headOfficeId : f.foreignHeadOfficeId,
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        paymentStatus: "UNPAID",
        receiptData: { invoiceNumber: `INV-OBL-${invoiceCounter}` } as any,
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
      reason: "Cheque in transit",
      startAt: window.startAt,
      expiresAt: window.expiresAt,
      revokedAt: window.revokedAt ?? null,
    })

  async function listAs(actor: Actor | null, query = "?filter=all") {
    signIn(actor)
    const response = await listRoute.GET(new NextRequest(`http://localhost/api/v1/payment-control/branches${query}`))
    return { status: response.status, body: await response.json(), cacheControl: response.headers.get("Cache-Control") }
  }

  const rowOf = (body: { items: Row[] }, branchId: number) => body.items.find((row) => row.branchId === branchId)

  const gateAllows = async (branchId: number) =>
    (await resolveBranchPaymentControl(db, { organizationId: f.organizationId, branchId })).orderingAllowed

  const cleanRows = async () => {
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(orders).where(and(inArray(orders.organizationId, organizationIds), like(orders.tid, `${TID_PREFIX}%`)))
    await db.delete(paymentControlExceptions).where(inArray(paymentControlExceptions.organizationId, organizationIds))
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  afterAll(async () => {
    if (!f) return
    await cleanRows()
    await configure(f.organizationId, false, 2)
    await configure(f.foreignOrganizationId, false, 2)
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await cleanRows()
    await db.update(branches).set({ status: "active" }).where(inArray(branches.id, [f.alphaNorthId, f.alphaSouthId, f.betaBranchId]))
    await configure(f.organizationId, true, 3)
    await configure(f.foreignOrganizationId, true, 3)
  })

  describe("who may ask", () => {
    it("refuses an unauthenticated caller with 401", async () => {
      expect((await listAs(null)).status).toBe(401)
    })

    it.each(["SUPER_ADMIN", "VIEWER", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "WAREHOUSE", "ORDER_DESK", "APRICART_EXECUTIVE"])(
      "refuses %s with 403",
      async (role) => {
        const organizationId = ["VIEWER", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL"].includes(role) ? f.organizationId : null
        expect((await listAs({ id: f.headOfficeId, email: `x-${f.suffix}@example.test`, role, organizationId })).status).toBe(403)
      },
    )

    it("never names another organization from the query string", async () => {
      const { status, body } = await listAs(headOffice(), `?organizationId=${f.foreignOrganizationId}`)
      expect(status).toBe(400)
      expect(body).toEqual({ error: "Unknown field: organizationId" })
    })

    it("is never cached by a shared cache", async () => {
      expect((await listAs(headOffice())).cacheControl).toBe("private, no-store, max-age=0")
    })
  })

  describe("while the organization does not block on unpaid invoices", () => {
    it("answers `enabled: false` and lists nothing, though the branches hold unpaid invoices", async () => {
      await unpaidInvoices(f.alphaNorthId, 5)
      await configure(f.organizationId, false, 3)
      expect((await listAs(headOffice())).body).toEqual({ enabled: false })
    })
  })

  describe("while it does", () => {
    it("places every active branch exactly where the order gate does", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      await unpaidInvoices(f.alphaSouthId, 2)
      await unpaidInvoices(f.betaBranchId, 4)
      await exception(f.betaBranchId, { startAt: new Date(Date.now() - DAY_MS), expiresAt: new Date(Date.now() + 10 * DAY_MS) })

      const { status, body } = await listAs(headOffice())
      expect(status).toBe(200)
      expect(body.enabled).toBe(true)
      expect(body.threshold).toBe(3)
      expect(rowOf(body, f.alphaNorthId)).toMatchObject({ standing: "BLOCKED", unpaidInvoiceCount: 3, orderingAllowed: false, exception: null })
      expect(rowOf(body, f.alphaSouthId)).toMatchObject({ standing: "LAST_ORDER", unpaidInvoiceCount: 2, orderingAllowed: true })
      expect(rowOf(body, f.betaBranchId)).toMatchObject({ standing: "EXCEPTION_ACTIVE", unpaidInvoiceCount: 4, orderingAllowed: true, exception: { active: true, reason: "Cheque in transit" } })

      for (const row of body.items as Row[]) {
        expect(row.orderingAllowed).toBe(await gateAllows(row.branchId))
      }
      expect(body.summary).toMatchObject({ blocked: 1, exceptionActive: 1, lastOrder: 1 })
    })

    it("counts only invoices the Paid/Unpaid control can clear", async () => {
      await unpaidInvoices(f.alphaNorthId, 1)
      await unpaidInvoices(f.alphaNorthId, 1, f.organizationId, { paymentStatus: "PAID" })
      await unpaidInvoices(f.alphaNorthId, 1, f.organizationId, { fulfillmentStatus: "OUT_FOR_DELIVERY" })
      await unpaidInvoices(f.alphaNorthId, 1, f.organizationId, { refundAmountCents: 10_000 })
      expect(rowOf((await listAs(headOffice())).body, f.alphaNorthId)).toMatchObject({ unpaidInvoiceCount: 1, standing: "UNPAID" })
    })

    it("judges an exception by its latest grant: expired or revoked ones leave the branch blocked", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      await unpaidInvoices(f.alphaSouthId, 3)
      await exception(f.alphaNorthId, { startAt: new Date(Date.now() - 40 * DAY_MS), expiresAt: new Date(Date.now() - DAY_MS) })
      await exception(f.alphaSouthId, { startAt: new Date(Date.now() - DAY_MS), expiresAt: new Date(Date.now() + 10 * DAY_MS), revokedAt: new Date(Date.now() - 1_000) })

      const { body } = await listAs(headOffice())
      expect(rowOf(body, f.alphaNorthId)).toMatchObject({ standing: "BLOCKED", exception: { active: false } })
      expect(rowOf(body, f.alphaSouthId)).toMatchObject({ standing: "BLOCKED", exception: { active: false } })
      expect(await gateAllows(f.alphaNorthId)).toBe(false)
      expect(await gateAllows(f.alphaSouthId)).toBe(false)
    })

    it("leaves out an inactive branch, which cannot order", async () => {
      await db.update(branches).set({ status: "inactive" }).where(eq(branches.id, f.betaBranchId))
      const { body } = await listAs(headOffice())
      expect(rowOf(body, f.betaBranchId)).toBeUndefined()
      expect(rowOf(body, f.alphaNorthId)).toBeDefined()
    })

    it("opens on the branches that need attention, and filters to the blocked ones", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      await unpaidInvoices(f.alphaSouthId, 1)

      const attention = (await listAs(headOffice(), "")).body
      expect(attention.items.map((row: Row) => row.branchId)).toEqual([f.alphaNorthId])
      expect(attention.summary.branches).toBeGreaterThanOrEqual(3)

      const blocked = (await listAs(headOffice(), "?filter=blocked")).body
      expect(blocked.items.map((row: Row) => row.branchId)).toEqual([f.alphaNorthId])
    })
  })

  describe("the tenant fence", () => {
    it("never lists another organization's branch or counts its invoices", async () => {
      await unpaidInvoices(f.foreignBranchId, 5, f.foreignOrganizationId)
      // An order of the foreign tenant filed against our branch id can only
      // exist if a composite key was missing; the count is fenced anyway.
      const ours = (await listAs(headOffice())).body
      expect(rowOf(ours, f.foreignBranchId)).toBeUndefined()
      expect((ours.items as Row[]).every((row) => row.unpaidInvoiceCount === 0)).toBe(true)

      const theirs = (await listAs(foreignHeadOffice())).body
      expect(rowOf(theirs, f.foreignBranchId)).toMatchObject({ standing: "BLOCKED", unpaidInvoiceCount: 5 })
      expect(rowOf(theirs, f.alphaNorthId)).toBeUndefined()
    })

    it("never shows another organization's exception", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      await exception(f.alphaNorthId, { startAt: new Date(Date.now() - DAY_MS), expiresAt: new Date(Date.now() + 10 * DAY_MS) })
      const theirs = (await listAs(foreignHeadOffice())).body
      expect((theirs.items as Row[]).some((row) => row.exception !== null)).toBe(false)
    })
  })

  describe("granting from the page", () => {
    it("a grant by Head Office turns the row from blocked to ordering on the exception", async () => {
      await unpaidInvoices(f.alphaNorthId, 3)
      expect(rowOf((await listAs(headOffice())).body, f.alphaNorthId)).toMatchObject({ standing: "BLOCKED" })

      signIn(headOffice())
      const granted = await grantRoute.POST(new NextRequest("http://localhost/api/v1/payment-control/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: f.alphaNorthId, reason: "Cheque in transit" }),
      }))
      expect(granted.status).toBe(201)

      expect(rowOf((await listAs(headOffice())).body, f.alphaNorthId)).toMatchObject({ standing: "EXCEPTION_ACTIVE", orderingAllowed: true, exception: { active: true } })
      expect(await gateAllows(f.alphaNorthId)).toBe(true)
    })

    it("a grant is refused while the organization does not block, and nothing is written", async () => {
      await configure(f.organizationId, false, 3)
      signIn(headOffice())
      const refused = await grantRoute.POST(new NextRequest("http://localhost/api/v1/payment-control/exceptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchId: f.alphaNorthId }),
      }))
      expect(refused.status).toBe(409)
      expect(await db.select().from(paymentControlExceptions).where(eq(paymentControlExceptions.branchId, f.alphaNorthId))).toHaveLength(0)
    })
  })
})
