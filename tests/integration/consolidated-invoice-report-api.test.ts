import { createHash } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray, like } from "drizzle-orm"
import * as XLSX from "xlsx"

import * as reportRoute from "@/app/api/v1/reports/consolidated-invoice/route"
import * as reportPdfRoute from "@/app/api/v1/reports/consolidated-invoice/pdf/route"
import * as reportXlsxRoute from "@/app/api/v1/reports/consolidated-invoice/xlsx/route"
import * as reportCsvRoute from "@/app/api/v1/reports/consolidated-invoice/csv/route"
import * as refundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import { auditLogs, invoices, orderItems, orders, refundItems, refunds } from "@/db/schema"
import { consolidatedInvoiceDigestInput, karachiToday } from "@/lib/consolidated-invoice"
import { closePool, db } from "@/lib/db"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The Consolidated Invoice Report against Postgres
 * (plans/OF-INVOICE-consolidated-invoices.md). Invoices are issued through
 * the real delivery path and credited through the real refund route, so the
 * report reads the same ledger rows production has.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", () => ({ sendRefundRequestEmail: vi.fn(async () => undefined) }))
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

const TID_PREFIX = "CIR"
const MONTH = karachiToday().slice(0, 7)

describe.skipIf(!hasTestDatabase)("the Consolidated Invoice Report", () => {
  let f: GroupRoleFixtures
  let seq = 0
  let delivered: { orderId: number; itemIds: number[] }
  let credited: { orderId: number; itemIds: number[] }
  let fullyCredited: { orderId: number; itemIds: number[] }
  let proforma: { orderId: number; itemIds: number[] }
  let otherBranch: { orderId: number; itemIds: number[] }
  let foreignOrderId: number

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const roleAs = (role: string): Actor => ({ id: f.approverId, email: `x-${f.suffix}@example.test`, role, organizationId: f.organizationId, branchId: f.alphaNorthId })

  const get = async (query: string, actor: Actor | null = headOffice()) => {
    signIn(actor)
    const response = await reportRoute.GET(new NextRequest(`http://localhost/api/v1/reports/consolidated-invoice?${query}`))
    return { status: response.status, body: await response.json() }
  }

  async function seedOrder(input: { organizationId?: number; branchId?: number } = {}): Promise<{ orderId: number; itemIds: number[] }> {
    seq += 1
    const organizationId = input.organizationId ?? f.organizationId
    const [order] = await db.insert(orders).values({
      tid: `${TID_PREFIX}${f.suffix}${seq}`.slice(0, 26),
      organizationId,
      branchId: input.branchId ?? f.alphaNorthId,
      createdByUserId: f.requesterId,
      approvedByUserId: f.approverId,
      status: "APPROVED",
      fulfillmentStatus: "NOT_STARTED",
      budgetTracked: false,
      subtotalCents: 2_500,
      taxCents: 450,
      totalCents: 2_950,
      approvedAt: new Date(),
      receiptData: { date: "10/01/2026", buyerName: "Branch", items: [] } as any,
    }).returning({ id: orders.id })
    const items = await db.insert(orderItems).values([
      { organizationId, orderId: order.id, globalProductId: f.productId, productName: "Tea", unit: "pcs", quantity: 2, priceCents: 1_180, taxRateBp: 1_800, taxCents: 360 },
      { organizationId, orderId: order.id, globalProductId: f.productId, productName: "Sugar", unit: "kg", quantity: 1, priceCents: 590, taxRateBp: 1_800, taxCents: 90 },
    ]).returning({ id: orderItems.id })
    return { orderId: order.id, itemIds: items.map((item) => item.id) }
  }

  async function deliver(orderId: number) {
    for (const nextStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      const outcome = await progressOrderFulfillment({
        orderId, nextStatus, deliveryChallanId: null, challanRequired: false,
        actor: { id: f.superAdminId, role: "SUPER_ADMIN" }, authorize: async () => true,
      })
      expect(outcome.kind).toBe("updated")
    }
  }

  async function refund(orderId: number, items: Array<{ id: number; quantity: number }>) {
    signIn(superAdmin())
    const response = await refundsRoute.POST(
      new NextRequest(`http://localhost/api/v1/orders/${orderId}/refunds`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, reason: "Damaged" }),
      }),
      { params: Promise.resolve({ id: String(orderId) }) },
    )
    expect(response.status).toBeLessThan(300)
  }

  /** A legacy invoice row, as the backfill writes one, dated as given. */
  async function seedLegacyInvoice(issueDate: string, branchId = f.alphaSouthId): Promise<number> {
    seq += 1
    const [order] = await db.insert(orders).values({
      tid: `${TID_PREFIX}L${f.suffix}${seq}`.slice(0, 26),
      organizationId: f.organizationId, branchId, createdByUserId: f.requesterId,
      status: "FULFILLED", fulfillmentStatus: "DELIVERED", budgetTracked: false,
      subtotalCents: 1_000, taxCents: 180, totalCents: 1_180,
      receiptData: { invoiceNumber: `LEG-${f.suffix}-${seq}` } as any,
    }).returning({ id: orders.id })
    await db.insert(invoices).values({
      organizationId: f.organizationId, branchId, orderId: order.id, number: `LEG-${f.suffix}-${seq}`,
      issueDate, origin: "LEGACY_SNAPSHOT", status: "ISSUED", seller: {}, buyer: { branchName: "Legacy Branch", costCenterId: "LCC" },
      netCents: 1_000, taxCents: 180, totalCents: 1_180, legacySnapshot: {}, backfillBatch: "cccccccccccccccc",
    })
    return order.id
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    delivered = await seedOrder()
    credited = await seedOrder()
    fullyCredited = await seedOrder()
    proforma = await seedOrder()
    otherBranch = await seedOrder({ branchId: f.betaBranchId })
    for (const order of [delivered, credited, fullyCredited, otherBranch]) await deliver(order.orderId)
    // Marked paid as the Super Admin control does it; every other order stays UNPAID.
    await db.update(orders).set({ paymentStatus: "PAID" }).where(eq(orders.id, delivered.orderId))
    // Decided at a level, as an organization using approval levels records it.
    await db.update(orders).set({ approvalLevel: 2 }).where(eq(orders.id, delivered.orderId))
    await db.update(orders).set({ approvalLevel: 1 }).where(eq(orders.id, proforma.orderId))
    await refund(credited.orderId, [{ id: credited.itemIds[1], quantity: 1 }])
    await refund(fullyCredited.orderId, [{ id: fullyCredited.itemIds[0], quantity: 2 }, { id: fullyCredited.itemIds[1], quantity: 1 }])
    const foreign = await seedOrder({ organizationId: f.foreignOrganizationId, branchId: f.foreignBranchId })
    await deliver(foreign.orderId)
    foreignOrderId = foreign.orderId
  })

  afterAll(async () => {
    if (!f) return
    const own = await db.select({ id: orders.id }).from(orders).where(like(orders.tid, `${TID_PREFIX}%${f.suffix}%`))
    const ids = own.map((row) => row.id)
    await destroyGroupRoleFixturesAfter(ids)
  })

  async function destroyGroupRoleFixturesAfter(orderIds: number[]) {
    // destroyGroupRoleFixtures purges the ledger for both organizations first.
    const { purgeInvoiceLedger } = await import("./helpers/invoice-ledger-cleanup")
    await purgeInvoiceLedger({ organizationIds: [f.organizationId, f.foreignOrganizationId] })
    if (orderIds.length > 0) {
      const refundRows = await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, orderIds))
      if (refundRows.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundRows.map((row) => row.id)))
      await db.delete(refunds).where(inArray(refunds.orderId, orderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
      await db.delete(orders).where(inArray(orders.id, orderIds))
    }
    await destroyGroupRoleFixtures(f)
    await closePool()
  }

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("who may read it", () => {
    it("refuses an anonymous caller", async () => {
      expect((await get(`period=month&month=${MONTH}`, null)).status).toBe(401)
    })

    it.each(["BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "VIEWER", "ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE"])(
      "refuses %s",
      async (role) => {
        expect((await get(`period=month&month=${MONTH}`, roleAs(role))).status).toBe(403)
      },
    )

    it("serves Head Office its own organization and Super Admin the one it names", async () => {
      const ho = await get(`period=month&month=${MONTH}`)
      expect(ho.status).toBe(200)
      expect(ho.body.billTo.name).toBe(f.names.organization)
      const sa = await get(`period=month&month=${MONTH}&organizationId=${f.organizationId}`, superAdmin())
      expect(sa.status).toBe(200)
      expect(sa.body.count).toBe(ho.body.count)
    })

    it("asks Super Admin which organization", async () => {
      expect((await get(`period=month&month=${MONTH}`, superAdmin())).status).toBe(400)
    })
  })

  describe("tenant isolation", () => {
    it("pins Head Office to its own organization whatever it sends", async () => {
      const { body } = await get(`period=month&month=${MONTH}&organizationId=${f.foreignOrganizationId}`)
      expect(body.billTo.name).toBe(f.names.organization)
      expect(body.rows.map((row: any) => row.orderId)).not.toContain(foreignOrderId)
    })

    it("never shows another organization's invoice", async () => {
      const { body } = await get(`period=month&month=${MONTH}`, foreignHeadOffice())
      expect(body.rows.map((row: any) => row.orderId)).toEqual([foreignOrderId])
    })

    it("answers another organization's branch or group as not found", async () => {
      expect((await get(`period=month&month=${MONTH}&branchIds=${f.foreignBranchId}`)).status).toBe(404)
      expect((await get(`period=month&month=${MONTH}&groupId=${f.foreignGroupId}`)).status).toBe(404)
    })
  })

  describe("what each mode lists", () => {
    it("lists delivered invoices less their credits, and leaves the fully credited out by default", async () => {
      const { status, body } = await get(`period=month&month=${MONTH}`)
      expect(status).toBe(200)
      const byOrder = new Map(body.rows.map((row: any) => [row.orderId, row]))
      expect([...byOrder.keys()].sort()).toEqual([delivered.orderId, credited.orderId, otherBranch.orderId].sort())
      expect(byOrder.get(delivered.orderId)).toMatchObject({
        valueExclTaxCents: 2_500, taxCents: 450, totalCents: 2_950, quantity: 3, taxRateLabel: "18%", invoiceStatus: "ISSUED",
      })
      // One Sugar line (590: net 500 + tax 90) credited.
      expect(byOrder.get(credited.orderId)).toMatchObject({
        valueExclTaxCents: 2_000, taxCents: 360, totalCents: 2_360, quantity: 2, invoiceStatus: "PARTIALLY_CREDITED",
      })
      expect(body.totals).toMatchObject({ orders: 3, totalCents: 2_950 + 2_360 + 2_950 })
    })

    it("includes the fully credited at zero when asked", async () => {
      const { body } = await get(`period=month&month=${MONTH}&includeCredited=true`)
      const row = body.rows.find((candidate: any) => candidate.orderId === fullyCredited.orderId)
      expect(row).toMatchObject({ totalCents: 0, quantity: 0, invoiceStatus: "CREDITED" })
    })

    it("lists only approved, undelivered orders as proformas, never an invoice", async () => {
      const { status, body } = await get(`period=month&month=${MONTH}&mode=proformas`)
      expect(status).toBe(200)
      expect(body.title).toBe("CONSOLIDATED PROFORMA")
      expect(body.rows.map((row: any) => row.orderId)).toEqual([proforma.orderId])
      expect(body.rows[0]).toMatchObject({ invoiceNumber: "When processed", totalCents: 2_950, invoiceStatus: "PROFORMA_AVAILABLE" })
    })

    it("narrows to a branch, and to a group", async () => {
      const branch = await get(`period=month&month=${MONTH}&branchIds=${f.betaBranchId}`)
      expect(branch.body.rows.map((row: any) => row.orderId)).toEqual([otherBranch.orderId])
      const group = await get(`period=month&month=${MONTH}&groupId=${f.betaGroupId}`)
      expect(group.body.rows.map((row: any) => row.orderId)).toEqual([otherBranch.orderId])
    })
  })

  describe("payment status", () => {
    it("lists only the paid invoices, or only the unpaid, and totals what it lists", async () => {
      const paid = await get(`period=month&month=${MONTH}&paymentStatus=PAID`)
      expect(paid.status).toBe(200)
      expect(paid.body.rows.map((row: any) => row.orderId)).toEqual([delivered.orderId])
      expect(paid.body.rows[0].paymentStatus).toBe("PAID")
      expect(paid.body.totals).toMatchObject({ orders: 1, totalCents: 2_950 })
      expect(paid.body.filterNote).toBe("Paid invoices only")

      const unpaid = await get(`period=month&month=${MONTH}&paymentStatus=UNPAID`)
      expect(unpaid.body.rows.map((row: any) => row.orderId).sort()).toEqual([credited.orderId, otherBranch.orderId].sort())
      expect(unpaid.body.rows.every((row: any) => row.paymentStatus === "UNPAID")).toBe(true)
      expect(unpaid.body.totals).toMatchObject({ orders: 2, totalCents: 2_360 + 2_950 })
      expect(unpaid.body.filterNote).toBe("Unpaid invoices only")

      const all = await get(`period=month&month=${MONTH}`)
      expect(all.body.totals.totalCents).toBe(paid.body.totals.totalCents + unpaid.body.totals.totalCents)
      expect(all.body.filterNote).toBeNull()
    })

    it("combines with the branch filter and the fully credited option", async () => {
      const branch = await get(`period=month&month=${MONTH}&branchIds=${f.betaBranchId}&paymentStatus=PAID`)
      expect(branch.body.rows).toEqual([])
      const credit = await get(`period=month&month=${MONTH}&includeCredited=true&paymentStatus=UNPAID`)
      expect(credit.body.rows.map((row: any) => row.orderId)).toContain(fullyCredited.orderId)
    })

    it("refuses the filter on proformas, and a value it does not know", async () => {
      expect((await get(`period=month&month=${MONTH}&mode=proformas&paymentStatus=UNPAID`)).status).toBe(400)
      expect((await get(`period=month&month=${MONTH}&paymentStatus=paid`)).status).toBe(400)
    })

    it("keeps Head Office inside its organization when filtering", async () => {
      const { body } = await get(`period=month&month=${MONTH}&paymentStatus=UNPAID&organizationId=${f.foreignOrganizationId}`)
      expect(body.rows.map((row: any) => row.orderId)).not.toContain(foreignOrderId)
    })

    it("prints and audits the filter on the PDF", async () => {
      signIn(headOffice())
      const response = await reportPdfRoute.GET(new NextRequest(`http://localhost/api/v1/reports/consolidated-invoice/pdf?period=month&month=${MONTH}&paymentStatus=UNPAID`))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-disposition")).toMatch(/-unpaid\.pdf"$/)
      expect(Buffer.from(await response.arrayBuffer()).toString("latin1")).toContain("Unpaid invoices only")
      const [audit] = await db.select({ metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT"), eq(auditLogs.organizationId, f.organizationId)))
        .orderBy(desc(auditLogs.id)).limit(1)
      expect(audit.metadata).toMatchObject({ paymentStatus: "UNPAID", rowCount: 2 })
    })
  })

  describe("periods", () => {
    it("places an invoice by its own date, month by month and by range", async () => {
      const orderId = await seedLegacyInvoice("2025-08-31")
      const august = await get("period=month&month=2025-08")
      expect(august.body.rows.map((row: any) => row.orderId)).toContain(orderId)
      expect(august.body.rows.find((row: any) => row.orderId === orderId)).toMatchObject({ department: "Legacy Branch", crc: "LCC", invoiceDate: "31 Aug 2025" })
      expect(august.body.footnote).toMatch(/order date/)
      expect((await get("period=month&month=2025-09")).body.rows.map((row: any) => row.orderId)).not.toContain(orderId)
      expect((await get("period=range&from=2025-08-31&to=2025-08-31")).body.count).toBe(1)
    })

    it("refuses a bad period", async () => {
      expect((await get("period=range&from=2025-09-02&to=2025-08-24")).status).toBe(400)
      expect((await get("period=month")).status).toBe(400)
      expect((await get("period=month&month=2025-08&extra=1")).status).toBe(400)
    })
  })

  describe("sorting and the PDF", () => {
    it("sorts as asked, and refuses an unknown column", async () => {
      const { body } = await get(`period=month&month=${MONTH}&sort=total&dir=asc`)
      const totals = body.rows.map((row: any) => row.totalCents)
      expect(totals).toEqual([...totals].sort((a: number, b: number) => a - b))
      expect(body.rows.map((row: any) => row.serial)).toEqual(body.rows.map((_: unknown, index: number) => index + 1))
      expect((await get(`period=month&month=${MONTH}&sort=price`)).status).toBe(400)
    })

    it("downloads the same rows, in the same order, and audits what it printed", async () => {
      const query = `period=month&month=${MONTH}&sort=total&dir=desc`
      const { body } = await get(query)
      signIn(headOffice())
      const response = await reportPdfRoute.GET(new NextRequest(`http://localhost/api/v1/reports/consolidated-invoice/pdf?${query}`))
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/pdf")
      expect(response.headers.get("cache-control")).toContain("no-store")
      const text = Buffer.from(await response.arrayBuffer()).toString("latin1")
      expect(text).toContain("CONSOLIDATED INVOICE")

      const digest = createHash("sha256").update(consolidatedInvoiceDigestInput(body.rows)).digest("hex")
      const [audit] = await db.select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT"), eq(auditLogs.organizationId, f.organizationId)))
        .orderBy(desc(auditLogs.id)).limit(1)
      expect(audit.userId).toBe(f.headOfficeId)
      expect(audit.metadata).toMatchObject({ digest, rowCount: body.rows.length, totalCents: body.totals.totalCents, mode: "invoices" })
    })

    it("refuses the PDF to a role that may not read the report", async () => {
      signIn(roleAs("BRANCH_ADMIN"))
      const response = await reportPdfRoute.GET(new NextRequest(`http://localhost/api/v1/reports/consolidated-invoice/pdf?period=month&month=${MONTH}`))
      expect(response.status).toBe(403)
    })
  })

  describe("approver level", () => {
    it("prints the level the order was approved at beside the approver, blank when it was not levelled", async () => {
      const { body } = await get(`period=month&month=${MONTH}`)
      const byOrder = new Map<number, any>(body.rows.map((row: any) => [row.orderId, row]))
      expect(byOrder.get(delivered.orderId)).toMatchObject({ approverLevel: "Level 2", approvalLevel: 2 })
      expect(byOrder.get(delivered.orderId).approver).not.toBe("")
      expect(byOrder.get(credited.orderId)).toMatchObject({ approverLevel: "", approvalLevel: null })
      const proformas = await get(`period=month&month=${MONTH}&mode=proformas`)
      expect(proformas.body.rows[0]).toMatchObject({ orderId: proforma.orderId, approverLevel: "Level 1" })
    })

    it("sorts by it, unlevelled orders last", async () => {
      const { status, body } = await get(`period=month&month=${MONTH}&sort=approverLevel&dir=asc`)
      expect(status).toBe(200)
      expect(body.rows[0].orderId).toBe(delivered.orderId)
      expect(body.rows.slice(1).every((row: any) => row.approvalLevel === null)).toBe(true)
    })
  })

  describe("Excel and CSV downloads", () => {
    const download = async (format: "xlsx" | "csv", query: string, actor: Actor | null = headOffice()) => {
      signIn(actor)
      const route = format === "xlsx" ? reportXlsxRoute : reportCsvRoute
      return route.GET(new NextRequest(`http://localhost/api/v1/reports/consolidated-invoice/${format}?${query}`))
    }
    const latestAudit = async () => {
      const [audit] = await db.select({ metadata: auditLogs.metadata, userId: auditLogs.userId })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT"), eq(auditLogs.organizationId, f.organizationId)))
        .orderBy(desc(auditLogs.id)).limit(1)
      return audit
    }
    const csvLines = (text: string) => text.replace(/^\uFEFF/, "").trimEnd().split("\r\n")
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"')))
    const sheetRows = (bytes: Uint8Array) => {
      const workbook = XLSX.read(bytes, { type: "array" })
      return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: true, defval: "" })
    }

    it("downloads the CSV with the preview's rows, in its order, filtered and audited", async () => {
      const query = `period=month&month=${MONTH}&paymentStatus=UNPAID&sort=total&dir=desc`
      const { body } = await get(query)
      const response = await download("csv", query)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(response.headers.get("content-disposition")).toMatch(/-unpaid\.csv"$/)
      const [header, ...rest] = csvLines(await response.text())
      const lines = rest.slice(0, -1)
      expect(lines.map((line) => Number(line[header.indexOf("Order ID")]))).toEqual(body.rows.map((row: any) => row.orderId))
      expect(lines.every((line) => line[header.indexOf("Payment Status")] === "Unpaid")).toBe(true)
      expect(rest[rest.length - 1][0]).toBe("Total")

      const digest = createHash("sha256").update(consolidatedInvoiceDigestInput(body.rows)).digest("hex")
      const audit = await latestAudit()
      expect(audit.userId).toBe(f.headOfficeId)
      expect(audit.metadata).toMatchObject({ format: "csv", digest, paymentStatus: "UNPAID", rowCount: body.rows.length })
    })

    it("downloads the workbook with the preview's rows and the approver level", async () => {
      const query = `period=month&month=${MONTH}`
      const { body } = await get(query)
      const response = await download("xlsx", query)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      expect(response.headers.get("content-disposition")).toMatch(/\.xlsx"$/)
      const sheet = sheetRows(new Uint8Array(await response.arrayBuffer()))
      const headerIndex = sheet.findIndex((row) => row[0] === "S. No")
      const header = sheet[headerIndex] as string[]
      const rows = sheet.slice(headerIndex + 1, headerIndex + 1 + body.rows.length)
      expect(rows.map((row) => row[header.indexOf("Order ID")])).toEqual(body.rows.map((row: any) => row.orderId))
      const levelled = rows.find((row) => row[header.indexOf("Order ID")] === delivered.orderId)
      expect(levelled?.[header.indexOf("Approver Level")]).toBe("Level 2")
      expect(sheet[headerIndex + 1 + body.rows.length][header.indexOf("Total Amount")]).toBe(body.totals.totalCents / 100)
      expect((await latestAudit()).metadata).toMatchObject({ format: "xlsx", rowCount: body.rows.length })
    })

    it.each(["xlsx", "csv"] as const)("refuses the %s download to an anonymous caller and to a role that may not read the report", async (format) => {
      expect((await download(format, `period=month&month=${MONTH}`, null)).status).toBe(401)
      expect((await download(format, `period=month&month=${MONTH}`, roleAs("BRANCH_ADMIN"))).status).toBe(403)
      expect((await download(format, `period=month&month=${MONTH}`, roleAs("ORDER_PORTAL"))).status).toBe(403)
    })

    it.each(["xlsx", "csv"] as const)("keeps Head Office's %s download inside its organization", async (format) => {
      const response = await download(format, `period=month&month=${MONTH}&organizationId=${f.foreignOrganizationId}`)
      expect(response.status).toBe(200)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const cells = format === "csv" ? csvLines(new TextDecoder().decode(bytes)).flat() : sheetRows(bytes).flat().map(String)
      expect(cells).not.toContain(String(foreignOrderId))
      expect(cells).toContain(String(delivered.orderId))
      expect((await download(format, `period=month&month=${MONTH}&branchIds=${f.foreignBranchId}`)).status).toBe(404)
    })

    it("refuses a bad query the same way the preview does", async () => {
      expect((await download("csv", `period=month&month=${MONTH}&format=xlsx`)).status).toBe(400)
      expect((await download("xlsx", `period=month&month=${MONTH}&mode=proformas&paymentStatus=PAID`)).status).toBe(400)
    })
  })

  describe("bounds", () => {
    it("refuses more than 1,000 invoices, saying how many", async () => {
      const count = 1_001
      const seeded = await db.insert(orders).values(Array.from({ length: count }, (_, index) => ({
        tid: `${TID_PREFIX}B${f.suffix}${index}`.slice(0, 26),
        organizationId: f.organizationId, branchId: f.alphaSouthId, createdByUserId: f.requesterId,
        status: "FULFILLED", fulfillmentStatus: "DELIVERED", budgetTracked: false,
        subtotalCents: 100, taxCents: 0, totalCents: 100,
      }))).returning({ id: orders.id })
      await db.insert(invoices).values(seeded.map((order, index) => ({
        organizationId: f.organizationId, branchId: f.alphaSouthId, orderId: order.id, number: `BULK-${f.suffix}-${index}`,
        issueDate: "2024-03-15", origin: "LEGACY_SNAPSHOT", status: "ISSUED", seller: {}, buyer: {},
        netCents: 100, taxCents: 0, totalCents: 100, legacySnapshot: {}, backfillBatch: "dddddddddddddddd",
      })))
      const { status, body } = await get("period=month&month=2024-03")
      expect(status).toBe(422)
      expect(body.count).toBe(count)
      // The count honours the payment filter too.
      const unpaid = await get("period=month&month=2024-03&paymentStatus=UNPAID")
      expect(unpaid.status).toBe(422)
      expect(unpaid.body.count).toBe(count)
      const paid = await get("period=month&month=2024-03&paymentStatus=PAID")
      expect(paid.status).toBe(200)
      expect(paid.body.count).toBe(0)
    })
  })
})
