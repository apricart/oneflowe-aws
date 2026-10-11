import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray, like } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as receiptRoute from "@/app/api/v1/receipts/[orderId]/route"
import * as deleteOrderRoute from "@/app/api/v1/admin/delete-order/route"
import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import {
  auditLogs,
  organizationAllowedIps,
  organizationSettings,
  orders,
  organizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { deriveInvoiceStatus, type InvoiceStatus } from "@/lib/invoice-status"
import { invoiceStatusSql } from "@/lib/server/invoice-status-sql"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Phase 1 of plans/OF-INVOICE-invoice-ledger.md against Postgres: the derived
 * invoice status (and its SQL twin), the Orders list filter and sort, the
 * invoice title and STRN on the invoice page, the STRN on the organization
 * routes, and the invoice number on the order-deletion audit row.
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

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const request = (method: string, url: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const read = async (response: Response) => ({ status: response.status, body: await response.json() })

const TID_PREFIX = "IVS"

describe.skipIf(!hasTestDatabase)("invoice status, customer STRN and the deletion audit", () => {
  let f: GroupRoleFixtures
  let seq = 0
  const createdOrganizationIds: number[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })

  const tid = (label: string) => `${TID_PREFIX}${label}${f.suffix}${(seq += 1)}`.slice(0, 26)

  async function seedOrder(input: {
    label: string
    status: string
    fulfillmentStatus?: string
    statusAtRefund?: string | null
    refundAmountCents?: number | null
    receiptData?: unknown
    organizationId?: number
    branchId?: number
  }): Promise<number> {
    const [row] = await db.insert(orders).values({
      tid: tid(input.label),
      organizationId: input.organizationId ?? f.organizationId,
      branchId: input.branchId ?? f.alphaNorthId,
      createdByUserId: f.headOfficeId,
      status: input.status,
      fulfillmentStatus: input.fulfillmentStatus ?? "NOT_STARTED",
      statusAtRefund: input.statusAtRefund ?? null,
      refundAmountCents: input.refundAmountCents ?? null,
      budgetTracked: false,
      subtotalCents: 8_475,
      taxCents: 1_525,
      totalCents: 10_000,
      receiptData: (input.receiptData ?? {
        invoiceNumber: `IVS-${f.suffix}-${seq}`,
        date: "10/09/2026",
        items: [],
        subtotal: 84.75,
        tax: 15.25,
        discount: 0,
        deliveryCharges: 0,
        totalAmount: 100,
      }) as any,
    }).returning({ id: orders.id })
    return row.id
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  afterAll(async () => {
    if (!f) return
    await db.delete(orders).where(like(orders.tid, `${TID_PREFIX}%${f.suffix}%`))
    if (createdOrganizationIds.length > 0) {
      await db.delete(auditLogs).where(inArray(auditLogs.organizationId, createdOrganizationIds))
      await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, createdOrganizationIds))
      await db.delete(organizationAllowedIps).where(inArray(organizationAllowedIps.organizationId, createdOrganizationIds))
      await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds))
    }
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("invoiceStatusSql is deriveInvoiceStatus, in SQL", () => {
    it("agrees on every combination of status, delivery, status at refund and refund", async () => {
      const statuses = ["PENDING", "APPROVED", "FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED", "REFUNDED", "REJECTED", "CANCELLED", " approved ", "Fulfilled"]
      const fulfilment = ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]
      const atRefund = [null, "APPROVED", "FULFILLED", "PARTIALLY_FULFILLED"]
      const refundsCents = [null, 0, 500]

      const rows = statuses.flatMap((status) => fulfilment.flatMap((fulfillmentStatus) =>
        atRefund.flatMap((statusAtRefund) => refundsCents.map((refundAmountCents) => ({
          tid: tid("P"),
          organizationId: f.organizationId,
          branchId: f.alphaNorthId,
          createdByUserId: f.headOfficeId,
          status,
          fulfillmentStatus,
          statusAtRefund,
          refundAmountCents,
          budgetTracked: false,
          subtotalCents: 10_000,
          taxCents: 0,
          totalCents: 10_000,
        })))))
      const inserted = await db.insert(orders).values(rows).returning({ id: orders.id })
      expect(inserted).toHaveLength(480)

      const stored = await db.select({
        id: orders.id,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        statusAtRefund: orders.statusAtRefund,
        refundAmountCents: orders.refundAmountCents,
        sqlStatus: invoiceStatusSql,
      }).from(orders).where(inArray(orders.id, inserted.map((row) => row.id)))

      const mismatches = stored
        .map((row) => ({ ...row, tsStatus: deriveInvoiceStatus(row) }))
        .filter((row) => row.tsStatus !== row.sqlStatus)
      expect(mismatches).toEqual([])
      // Every status the rule can produce was produced, so the agreement is not vacuous.
      expect(new Set(stored.map((row) => row.sqlStatus))).toEqual(new Set<InvoiceStatus>([
        "NOT_ISSUED", "PROFORMA_AVAILABLE", "ISSUED", "PARTIALLY_CREDITED", "CREDITED", "CANCELLED",
      ]))
    })
  })

  describe("the Orders list", () => {
    const listUrl = (query: string) => `http://localhost/api/v1/orders?q=${TID_PREFIX}L&limit=50&${query}`

    beforeAll(async () => {
      await seedOrder({ label: "L", status: "PENDING" })
      await seedOrder({ label: "L", status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })
      await seedOrder({ label: "L", status: "FULFILLED", fulfillmentStatus: "DELIVERED" })
      await seedOrder({ label: "L", status: "FULFILLED", fulfillmentStatus: "DELIVERED", statusAtRefund: "FULFILLED", refundAmountCents: 500 })
    })

    it("returns each order's invoice status", async () => {
      signIn(headOffice())
      const { status, body } = await read(await ordersRoute.GET(request("GET", listUrl(""))))
      expect(status).toBe(200)
      const statuses = body.items.map((item: any) => item.invoiceStatus).sort()
      expect(statuses).toEqual(["ISSUED", "NOT_ISSUED", "PARTIALLY_CREDITED", "PROFORMA_AVAILABLE"])
    })

    it("filters by invoice status, and the page total counts only the filtered rows", async () => {
      signIn(headOffice())
      const { status, body } = await read(await ordersRoute.GET(request("GET", listUrl("invoiceStatus=proforma_available"))))
      expect(status).toBe(200)
      expect(body.items.map((item: any) => item.invoiceStatus)).toEqual(["PROFORMA_AVAILABLE"])
      expect(body.pagination.total).toBe(1)
    })

    it("refuses an unknown invoice status instead of widening the list", async () => {
      signIn(headOffice())
      const { status } = await read(await ordersRoute.GET(request("GET", listUrl("invoiceStatus=PAID"))))
      expect(status).toBe(400)
    })

    it("sorts by the document's stage", async () => {
      signIn(headOffice())
      const { status, body } = await read(await ordersRoute.GET(request("GET", listUrl("sort=invoiceStatus&dir=asc"))))
      expect(status).toBe(200)
      expect(body.items.map((item: any) => item.invoiceStatus))
        .toEqual(["NOT_ISSUED", "PROFORMA_AVAILABLE", "ISSUED", "PARTIALLY_CREDITED"])
    })

    it("never shows another organization's orders, whatever the filter", async () => {
      await seedOrder({ label: "L", status: "APPROVED", organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })
      signIn(headOffice())
      const { body } = await read(await ordersRoute.GET(request("GET", listUrl("invoiceStatus=PROFORMA_AVAILABLE"))))
      expect(body.items.every((item: any) => item.organizationId === f.organizationId)).toBe(true)
      expect(body.items).toHaveLength(1)
    })
  })

  describe("the invoice page", () => {
    beforeAll(async () => {
      await db.update(organizations).set({ strnNumber: "3277876-1" }).where(eq(organizations.id, f.organizationId))
    })

    afterAll(async () => {
      await db.update(organizations).set({ strnNumber: null }).where(eq(organizations.id, f.organizationId))
    })

    const invoiceOf = async (orderId: number) => {
      signIn(headOffice())
      return read(await receiptRoute.GET(
        request("GET", `http://localhost/api/v1/receipts/${orderId}`),
        { params: Promise.resolve({ orderId: String(orderId) }) },
      ))
    }

    it("titles an approved, undelivered order a proforma and prints the customer's STRN", async () => {
      const orderId = await seedOrder({ label: "R", status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
      const { status, body } = await invoiceOf(orderId)
      expect(status).toBe(200)
      expect(body.invoiceStatus).toBe("PROFORMA_AVAILABLE")
      expect(body.receiptData).toMatchObject({
        invoiceStatus: "PROFORMA_AVAILABLE",
        invoiceStatusLabel: "Proforma available",
        documentTitle: "PROFORMA INVOICE",
        organizationStrn: "3277876-1",
      })
    })

    it("keeps a delivered order an INVOICE, printed as it was before the STRN existed", async () => {
      const orderId = await seedOrder({ label: "R", status: "FULFILLED", fulfillmentStatus: "DELIVERED" })
      const { status, body } = await invoiceOf(orderId)
      expect(status).toBe(200)
      expect(body.receiptData).toMatchObject({ invoiceStatus: "ISSUED", documentTitle: "INVOICE" })
      expect(body.receiptData).not.toHaveProperty("organizationStrn")
    })

    it("marks a partly refunded delivered order partially credited", async () => {
      const orderId = await seedOrder({ label: "R", status: "FULFILLED", fulfillmentStatus: "DELIVERED", refundAmountCents: 2_000 })
      const { body } = await invoiceOf(orderId)
      expect(body.receiptData).toMatchObject({ invoiceStatus: "PARTIALLY_CREDITED", documentTitle: "INVOICE" })
    })
  })

  describe("the customer's STRN on the organization", () => {
    const patch = (organizationId: number, body: unknown) => organizationRoute.PATCH(
      request("PATCH", `http://localhost/api/v1/organizations/${organizationId}`, body),
      { params: Promise.resolve({ id: String(organizationId) }) },
    )

    const taxAudits = () => db
      .select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
      .from(auditLogs)
      .where(and(eq(auditLogs.organizationId, f.organizationId), eq(auditLogs.action, "UPDATE_ORGANIZATION_TAX_IDENTIFIERS")))
      .orderBy(desc(auditLogs.id))

    it("Super Admin sets it on edit; it is trimmed, stored and audited with what it replaced", async () => {
      signIn(superAdmin())
      const { status, body } = await read(await patch(f.organizationId, { strnNumber: " 1700000-2 " }))
      expect(status).toBe(200)
      expect(body.item.strnNumber).toBe("1700000-2")

      const [audit] = await taxAudits()
      expect(audit.userId).toBe(f.superAdminId)
      expect(audit.metadata).toEqual({ previousStrnNumber: null, strnNumber: "1700000-2" })
    })

    it("re-saving the same value writes no audit row; clearing it does", async () => {
      signIn(superAdmin())
      const before = (await taxAudits()).length
      expect((await patch(f.organizationId, { strnNumber: "1700000-2", ntnNumber: null })).status).toBe(200)
      expect(await taxAudits()).toHaveLength(before)

      const cleared = await read(await patch(f.organizationId, { strnNumber: "" }))
      expect(cleared.body.item.strnNumber).toBeNull()
      const [audit] = await taxAudits()
      expect(audit.metadata).toEqual({ previousStrnNumber: "1700000-2", strnNumber: null })
    })

    it("refuses characters an invoice should not print", async () => {
      signIn(superAdmin())
      expect((await patch(f.organizationId, { strnNumber: "17<script>" })).status).toBe(400)
      expect((await patch(f.organizationId, { strnNumber: "x".repeat(33) })).status).toBe(400)
    })

    it("Head Office cannot change it", async () => {
      signIn(headOffice())
      expect((await patch(f.organizationId, { strnNumber: "999" })).status).toBe(403)
      const [row] = await db.select({ strnNumber: organizations.strnNumber }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.strnNumber).toBeNull()
    })

    it("is stored when the organization is created with one", async () => {
      signIn(superAdmin())
      const code = `IVS${f.suffix.toUpperCase()}`
      const { status, body } = await read(await organizationsRoute.POST(request(
        "POST",
        "http://localhost/api/v1/organizations",
        { name: `IVS Strn ${f.suffix}`, code, ntnNumber: "1234567-8", strnNumber: "3277876123456" },
      )))
      expect(status).toBe(201)
      createdOrganizationIds.push(body.item.id)
      const [row] = await db.select({ ntn: organizations.ntnNumber, strn: organizations.strnNumber })
        .from(organizations).where(eq(organizations.id, body.item.id))
      expect(row).toEqual({ ntn: "1234567-8", strn: "3277876123456" })
    })
  })

  describe("deleting an order", () => {
    it("records the invoice number and delivery stage it held", async () => {
      const orderId = await seedOrder({ label: "D", status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })
      const [{ receiptData }] = await db
        .select({ receiptData: orders.receiptData })
        .from(orders).where(eq(orders.id, orderId))
      const invoiceNumber = (receiptData as { invoiceNumber: string }).invoiceNumber

      signIn(superAdmin())
      const response = await deleteOrderRoute.DELETE(request("DELETE", `http://localhost/api/v1/admin/delete-order?id=${orderId}`))
      expect(response.status).toBe(200)

      const [audit] = await db
        .select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DELETE_ORDER"), eq(auditLogs.entityId, String(orderId))))
      expect((audit.metadata as any).before).toMatchObject({
        invoiceNumber,
        fulfillmentStatus: "IN_PROCESS",
        status: "APPROVED",
      })
      expect(invoiceNumber).toMatch(/^IVS-/)
    })
  })
})
