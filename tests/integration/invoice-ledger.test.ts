import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like, sql } from "drizzle-orm"

import * as refundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as receiptRoute from "@/app/api/v1/receipts/[orderId]/route"
import * as creditNoteDownloadRoute from "@/app/api/v1/receipts/[orderId]/credit-notes/[creditNoteId]/download/route"
import * as deleteOrderRoute from "@/app/api/v1/admin/delete-order/route"
import {
  auditLogs,
  branches,
  creditNoteLines,
  creditNotes,
  invoiceLines,
  invoiceSequences,
  invoices,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { karachiDate } from "@/lib/invoice-ledger"
import { planLegacyInvoice } from "@/lib/invoice-ledger-backfill"
import { issueCreditNoteForRefund } from "@/lib/server/credit-notes"
import { issueTaxInvoiceAtDelivery } from "@/lib/server/invoice-issuance"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"

/**
 * The invoice ledger against Postgres (plans/OF-INVOICE-invoice-ledger.md):
 * tax invoices issued, numbered and dated at delivery; credit notes on
 * approved refunds; documents printed from their own rows; and the database
 * refusing to change or delete an issued document.
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

const request = (method: string, url: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const TID_PREFIX = "ILG"
// Two lines at 18%, tax-inclusive: 2 × 1,180 (net 2,000 + tax 360) and 1 × 590 (net 500 + tax 90).
const LINES = [
  { name: "Tea 600pcs", priceCents: 1_180, quantity: 2, taxCents: 360 },
  { name: "Sugar 1kg", priceCents: 590, quantity: 1, taxCents: 90 },
]

describe.skipIf(!hasTestDatabase)("the invoice ledger", () => {
  let f: GroupRoleFixtures
  let seq = 0
  const ownOrderIds: number[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })

  async function seedApprovedOrder(input: { invoiceNumber?: string } = {}): Promise<{ orderId: number; itemIds: number[] }> {
    seq += 1
    const [order] = await db.insert(orders).values({
      tid: `${TID_PREFIX}${f.suffix}${seq}`.slice(0, 26),
      organizationId: f.organizationId,
      branchId: f.alphaNorthId,
      createdByUserId: f.requesterId,
      approvedByUserId: f.approverId,
      status: "APPROVED",
      fulfillmentStatus: "NOT_STARTED",
      budgetTracked: false,
      subtotalCents: 2_500,
      taxCents: 450,
      totalCents: 2_950,
      approvedAt: new Date(),
      receiptData: {
        ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
        date: "10/01/2026",
        buyerName: "Alpha North",
        buyerAddress: "Plot 1, Clifton, Karachi",
        organizationName: "Integration Org",
        items: [],
        subtotal: 25,
        tax: 4.5,
        discount: 0,
        deliveryCharges: 0,
        totalAmount: 29.5,
      } as any,
    }).returning({ id: orders.id })
    ownOrderIds.push(order.id)
    const items = await db.insert(orderItems).values(LINES.map((line) => ({
      organizationId: f.organizationId,
      orderId: order.id,
      globalProductId: f.productId,
      productName: line.name,
      unit: "pcs",
      quantity: line.quantity,
      priceCents: line.priceCents,
      taxRateBp: 1_800,
      taxCents: line.taxCents,
    }))).returning({ id: orderItems.id })
    return { orderId: order.id, itemIds: items.map((item) => item.id) }
  }

  async function deliver(orderId: number) {
    for (const nextStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      const outcome = await progressOrderFulfillment({
        orderId,
        nextStatus,
        deliveryChallanId: null,
        challanRequired: false,
        actor: { id: f.superAdminId, role: "SUPER_ADMIN" },
        authorize: async () => true,
      })
      expect(outcome.kind).toBe("updated")
    }
  }

  const invoiceOf = async (orderId: number) => {
    const [row] = await db.select().from(invoices).where(eq(invoices.orderId, orderId))
    return row
  }

  const sequenceValue = async () => {
    const [row] = await db.select({ lastValue: invoiceSequences.lastValue }).from(invoiceSequences)
      .where(eq(invoiceSequences.organizationId, f.organizationId))
    return row?.lastValue ?? 0
  }

  const organizationCode = async () => {
    const [row] = await db.select({ code: organizations.code }).from(organizations).where(eq(organizations.id, f.organizationId))
    return String(row.code).toUpperCase()
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  afterAll(async () => {
    if (!f) return
    await purgeInvoiceLedger({ organizationIds: [f.organizationId, f.foreignOrganizationId] })
    if (ownOrderIds.length > 0) {
      const refundRows = await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.orderId, ownOrderIds))
      if (refundRows.length > 0) await db.delete(refundItems).where(inArray(refundItems.refundId, refundRows.map((row) => row.id)))
      await db.delete(refunds).where(inArray(refunds.orderId, ownOrderIds))
      await db.delete(orderItems).where(inArray(orderItems.orderId, ownOrderIds))
      await db.delete(orders).where(inArray(orders.id, ownOrderIds))
    }
    await db.delete(orders).where(like(orders.tid, `${TID_PREFIX}%${f.suffix}%`))
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("issuing the tax invoice at delivery", () => {
    it("numbers it from the organization's series, dates it today in Karachi, and freezes its lines", async () => {
      const { orderId } = await seedApprovedOrder()
      const before = await sequenceValue()
      await deliver(orderId)

      const invoice = await invoiceOf(orderId)
      const code = await organizationCode()
      expect(invoice).toMatchObject({
        organizationId: f.organizationId,
        branchId: f.alphaNorthId,
        origin: "ISSUED_AT_SUPPLY",
        status: "ISSUED",
        number: `${code}-APR-${String(before + 1).padStart(6, "0")}`,
        issueDate: karachiDate(new Date()),
        netCents: 2_500,
        taxCents: 450,
        totalCents: 2_950,
        legacySnapshot: null,
      })
      expect(invoice.buyer).toMatchObject({ buyerAddress: "Plot 1, Clifton, Karachi", branchName: f.names.alphaNorth })
      expect(await sequenceValue()).toBe(before + 1)

      const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.lineNo)
      expect(lines.map((line) => [line.productName, Number(line.quantity), line.netCents, line.taxCents, line.grossCents]))
        .toEqual([["Tea 600pcs", 2, 2_000, 360, 2_360], ["Sugar 1kg", 1, 500, 90, 590]])

      // The order's snapshot now names its number, so older readers see it too.
      const [order] = await db.select({ receiptData: orders.receiptData }).from(orders).where(eq(orders.id, orderId))
      expect((order.receiptData as any).invoiceNumber).toBe(invoice.number)

      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ISSUE_TAX_INVOICE"), eq(auditLogs.entityId, String(invoice.id))))
      expect(audit.metadata).toMatchObject({ orderId, number: invoice.number, totalCents: 2_950 })
    })

    it("keeps a number drawn at creation before the switch, and draws none", async () => {
      const reserved = `${await organizationCode()}-APR-777001`
      const { orderId } = await seedApprovedOrder({ invoiceNumber: reserved })
      const before = await sequenceValue()
      await deliver(orderId)
      expect((await invoiceOf(orderId)).number).toBe(reserved)
      expect(await sequenceValue()).toBe(before)
    })

    it("invoices only what refunds approved before delivery left", async () => {
      const { orderId, itemIds } = await seedApprovedOrder()
      const [refund] = await db.insert(refunds).values({
        organizationId: f.organizationId,
        orderId,
        amountCents: 1_180,
        status: "APPROVED",
        processedByUserId: f.superAdminId,
      }).returning({ id: refunds.id })
      await db.insert(refundItems).values({ refundId: refund.id, orderItemId: itemIds[0], quantity: 1, amountCents: 1_180 })
      await db.update(orders).set({ refundAmountCents: 1_180, statusAtRefund: "APPROVED" }).where(eq(orders.id, orderId))

      await deliver(orderId)
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ netCents: 1_500, taxCents: 270, discountCents: 0, totalCents: 1_770 })
      const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoice.id)).orderBy(invoiceLines.lineNo)
      expect(lines.map((line) => [Number(line.quantity), line.grossCents])).toEqual([[1, 1_180], [1, 590]])
    })

    it("draws consecutive numbers with no gaps when several deliveries race", async () => {
      const seeded = await Promise.all(Array.from({ length: 5 }, () => seedApprovedOrder()))
      const before = await sequenceValue()
      await Promise.all(seeded.map(({ orderId }) => deliver(orderId)))
      const numbers = (await Promise.all(seeded.map(({ orderId }) => invoiceOf(orderId))))
        .map((invoice) => Number(invoice.number.slice(-6)))
        .sort((a, b) => a - b)
      expect(numbers).toEqual([before + 1, before + 2, before + 3, before + 4, before + 5])
    })

    it("issues nothing twice for the same order", async () => {
      const { orderId } = await seedApprovedOrder()
      await deliver(orderId)
      const first = await invoiceOf(orderId)
      const again = await db.transaction((tx) => issueTaxInvoiceAtDelivery(tx, { orderId, actor: { id: f.superAdminId, role: "SUPER_ADMIN" } }))
      expect(again).toEqual({ kind: "exists", invoiceId: first.id })
    })
  })

  describe("credit notes", () => {
    let orderId: number
    let itemIds: number[]

    beforeAll(async () => {
      ({ orderId, itemIds } = await seedApprovedOrder())
      await deliver(orderId)
    })

    const refund = (items: Array<{ id: number; quantity: number }>) => {
      signIn(superAdmin())
      return refundsRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${orderId}/refunds`, { items, reason: "Damaged in transit" }),
        { params: Promise.resolve({ id: String(orderId) }) },
      )
    }

    it("issues a numbered credit note for a refund against the issued invoice, with its tax", async () => {
      const response = await refund([{ id: itemIds[0], quantity: 1 }])
      expect(response.status).toBeLessThan(300)

      const invoice = await invoiceOf(orderId)
      const notes = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoice.id))
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({
        number: `${await organizationCode()}-CN-000001`,
        netCents: 1_000,
        taxCents: 180,
        totalCents: 1_180,
        reason: "Damaged in transit",
        issueDate: karachiDate(new Date()),
      })
      expect(invoice).toMatchObject({ status: "PARTIALLY_CREDITED", creditedTotalCents: 1_180, creditedTaxCents: 180 })

      const [row] = await db.select({ taxRefundCents: refunds.taxRefundCents }).from(refunds).where(eq(refunds.id, notes[0].refundId))
      expect(row.taxRefundCents).toBe(180)
      const lines = await db.select().from(creditNoteLines).where(eq(creditNoteLines.creditNoteId, notes[0].id))
      expect(lines.map((line) => [line.description, Number(line.quantity), line.grossCents])).toEqual([["Tea 600pcs", 1, 1_180]])
    })

    it("credits the rest with a second note and marks the invoice credited", async () => {
      const response = await refund([{ id: itemIds[0], quantity: 1 }, { id: itemIds[1], quantity: 1 }])
      expect(response.status).toBeLessThan(300)
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ status: "CREDITED", creditedTotalCents: 2_950 })
      const numbers = (await db.select({ number: creditNotes.number }).from(creditNotes).where(eq(creditNotes.invoiceId, invoice.id)))
        .map((row) => row.number).sort()
      expect(numbers.map((number) => number.slice(-6))).toEqual(["000001", "000002"])
    })

    it("issues nothing twice for the same refund", async () => {
      const [note] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, (await invoiceOf(orderId)).id)).limit(1)
      const again = await db.transaction((tx) => issueCreditNoteForRefund(tx, {
        refundId: note.refundId, orderId, actor: { id: f.superAdminId, role: "SUPER_ADMIN" }, reason: null,
      }))
      expect(again).toEqual({ kind: "exists", creditNoteId: note.id })
    })

    it("lets the customer's Head Office download it, and nobody outside the organization", async () => {
      const [note] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, (await invoiceOf(orderId)).id)).limit(1)
      const download = (actor: Actor, noteId: number, forOrder = orderId) => {
        signIn(actor)
        return creditNoteDownloadRoute.GET(
          request("GET", `http://localhost/api/v1/receipts/${forOrder}/credit-notes/${noteId}/download`),
          { params: Promise.resolve({ orderId: String(forOrder), creditNoteId: String(noteId) }) },
        )
      }

      const ok = await download(headOffice(), note.id)
      expect(ok.status).toBe(200)
      expect(ok.headers.get("content-type")).toBe("application/pdf")
      expect(Buffer.from(await ok.arrayBuffer()).toString("latin1")).toContain("CREDIT NOTE")

      expect((await download(foreignHeadOffice(), note.id)).status).toBe(403)
      // A credit note is only reachable through its own order.
      const other = await seedApprovedOrder()
      expect((await download(headOffice(), note.id, other.orderId)).status).toBe(404)
    })
  })

  describe("reprinting", () => {
    it("prints a delivered invoice from its own record, whatever changed since", async () => {
      const { orderId } = await seedApprovedOrder()
      await deliver(orderId)
      const issued = await invoiceOf(orderId)

      await db.update(branches).set({ address: "Somewhere else entirely" }).where(eq(branches.id, f.alphaNorthId))
      await db.update(organizations).set({ ntnNumber: "9999999-9", strnNumber: "1111" }).where(eq(organizations.id, f.organizationId))
      try {
        signIn(headOffice())
        const response = await receiptRoute.GET(
          request("GET", `http://localhost/api/v1/receipts/${orderId}`),
          { params: Promise.resolve({ orderId: String(orderId) }) },
        )
        const body = await response.json()
        expect(response.status).toBe(200)
        expect(body.receiptData).toMatchObject({
          frozen: true,
          invoiceNumber: issued.number,
          date: issued.issueDate,
          buyerAddress: "Plot 1, Clifton, Karachi",
          documentTitle: "INVOICE",
          invoiceStatus: "ISSUED",
          totalAmount: 29.5,
        })
        expect(body.receiptData.organizationNtn).not.toBe("9999999-9")
        expect(body.receiptData).not.toHaveProperty("fulfilledByName")
      } finally {
        await db.update(organizations).set({ ntnNumber: null, strnNumber: null }).where(eq(organizations.id, f.organizationId))
      }
    })
  })

  describe("immutability, enforced by the database", () => {
    let invoiceId: number

    beforeAll(async () => {
      const { orderId } = await seedApprovedOrder()
      await deliver(orderId)
      invoiceId = (await invoiceOf(orderId)).id
    })

    it("refuses any change to an issued invoice but its credited totals and status", async () => {
      await expect(db.update(invoices).set({ totalCents: 1 }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoices).set({ number: "X-APR-000001" }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoices).set({ buyer: {} }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoices).set({ status: "ISSUED" }).where(eq(invoices.id, invoiceId))).resolves.toBeDefined()
    })

    it("refuses to delete an invoice, change its lines, or delete the order behind it", async () => {
      await expect(db.delete(invoices).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoiceLines).set({ grossCents: 1, netCents: 1, taxCents: 0 }).where(eq(invoiceLines.invoiceId, invoiceId))).rejects.toThrow()
      await expect(db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId))).rejects.toThrow()
      const [{ orderId }] = await db.select({ orderId: invoices.orderId }).from(invoices).where(eq(invoices.id, invoiceId))
      await expect(db.delete(orders).where(eq(orders.id, orderId))).rejects.toThrow()
    })

    it("the admin delete refuses a delivered order", async () => {
      const [{ orderId }] = await db.select({ orderId: invoices.orderId }).from(invoices).where(eq(invoices.id, invoiceId))
      signIn(superAdmin())
      const response = await deleteOrderRoute.DELETE(request("DELETE", `http://localhost/api/v1/admin/delete-order?id=${orderId}`))
      expect(response.status).toBe(409)
      expect((await response.json()).error).toMatch(/tax invoice/)
    })
  })

  describe("an order delivered and refunded before the ledger existed", () => {
    it("is copied in with its refund as credit, and a later refund issues a credit note against it", async () => {
      // Delivered and fulfilled under the old system, with its number drawn at
      // creation and one line refunded (an app refund: no tax recorded).
      const number = `${await organizationCode()}-APR-999${String(seq + 1).padStart(3, "0")}`
      const { orderId, itemIds } = await seedApprovedOrder({ invoiceNumber: number })
      await db.update(orders).set({
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        deliveredAt: new Date("2026-09-20T06:00:00Z"),
        fulfilledAt: new Date("2026-09-21T06:00:00Z"),
        refundAmountCents: 590,
        statusAtRefund: "FULFILLED",
      }).where(eq(orders.id, orderId))
      const [oldRefund] = await db.insert(refunds).values({
        organizationId: f.organizationId, orderId, amountCents: 590, status: "APPROVED", processedByUserId: f.superAdminId,
      }).returning({ id: refunds.id })
      await db.insert(refundItems).values({ refundId: oldRefund.id, orderItemId: itemIds[1], quantity: 1, amountCents: 590 })

      // The backfill's own rule, applied to that order as the script reads it.
      const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
      const plan = planLegacyInvoice({
        orderId, tid: order.tid, organizationId: f.organizationId, branchId: f.alphaNorthId,
        status: order.status, fulfillmentStatus: order.fulfillmentStatus, statusAtRefund: order.statusAtRefund,
        refundAmountCents: order.refundAmountCents, subtotalCents: order.subtotalCents, taxCents: order.taxCents,
        totalCents: order.totalCents, receiptData: order.receiptData as any, createdAt: order.createdAt!,
        deliveredAt: order.deliveredAt, fulfilledAt: order.fulfilledAt,
        organizationName: "Integration Org", organizationCode: "X", organizationNtn: null, organizationStrn: null,
        branchName: f.names.alphaNorth, branchCostCenterId: null,
        approvedRefunds: [{ amountCents: 590, taxRefundCents: 0, lines: [{ grossCents: 590, taxRateBp: 1_800 }] }],
      })
      if (plan.kind !== "insert") throw new Error("expected the backfill to copy the order")
      expect(plan.row).toMatchObject({ number, status: "PARTIALLY_CREDITED", creditedTotalCents: 590, creditedTaxCents: 90, creditedNetCents: 500 })
      await db.insert(invoices).values({
        ...plan.row,
        issuedAt: new Date(plan.row.issuedAt),
        seller: {},
        legacySnapshot: order.receiptData as any,
        backfillBatch: "aaaaaaaaaaaaaaaa",
      })

      // After the deploy, Super Admin refunds the rest of it.
      signIn(superAdmin())
      const response = await refundsRoute.POST(
        request("POST", `http://localhost/api/v1/orders/${orderId}/refunds`, { items: [{ id: itemIds[0], quantity: 2 }], reason: "Expired stock" }),
        { params: Promise.resolve({ id: String(orderId) }) },
      )
      expect(response.status).toBeLessThan(300)

      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ number, origin: "LEGACY_SNAPSHOT", status: "CREDITED", creditedTotalCents: 2_950, creditedTaxCents: 450 })
      const notes = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoice.id))
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ totalCents: 2_360, taxCents: 360, netCents: 2_000 })

      // The old refund is untouched; the new one carries its tax.
      const refundRows = await db.select({ id: refunds.id, amountCents: refunds.amountCents, taxRefundCents: refunds.taxRefundCents })
        .from(refunds).where(eq(refunds.orderId, orderId)).orderBy(refunds.id)
      expect(refundRows.map((row) => [row.amountCents, row.taxRefundCents])).toEqual([[590, 0], [2_360, 360]])

      // It still prints as the legacy invoice it was, with its credit note listed.
      signIn(headOffice())
      const preview = await receiptRoute.GET(
        request("GET", `http://localhost/api/v1/receipts/${orderId}`),
        { params: Promise.resolve({ orderId: String(orderId) }) },
      )
      const body = await preview.json()
      expect(body.receiptData.frozen).toBeUndefined()
      expect(body.receiptData.invoiceNumber).toBe(number)
      expect(body.receiptData.creditNotes).toEqual([expect.objectContaining({ number: notes[0].number, total: 23.6 })])
    })
  })

  describe("the backfill of invoices supplied before the ledger", () => {
    it("copies a delivered order with its own number, printed date and refunds, and only its batch can roll it back", async () => {
      seq += 1
      const number = `${await organizationCode()}-APR-888${String(seq).padStart(3, "0")}`
      const [order] = await db.insert(orders).values({
        tid: `${TID_PREFIX}B${f.suffix}${seq}`.slice(0, 26),
        organizationId: f.organizationId,
        branchId: f.alphaNorthId,
        createdByUserId: f.requesterId,
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        budgetTracked: false,
        subtotalCents: 2_500,
        taxCents: 450,
        totalCents: 2_950,
        refundAmountCents: 590,
        receiptData: { invoiceNumber: number, date: "08/24/2026", buyerName: "Alpha North" } as any,
        createdAt: new Date("2026-08-24T06:00:00Z"),
        deliveredAt: new Date("2026-08-26T06:00:00Z"),
      }).returning()
      ownOrderIds.push(order.id)

      const plan = planLegacyInvoice({
        orderId: order.id, tid: order.tid, organizationId: f.organizationId, branchId: f.alphaNorthId,
        status: "FULFILLED", fulfillmentStatus: "DELIVERED", statusAtRefund: null, refundAmountCents: 590,
        subtotalCents: 2_500, taxCents: 450, totalCents: 2_950, receiptData: order.receiptData as any,
        createdAt: order.createdAt!, deliveredAt: order.deliveredAt, fulfilledAt: null,
        organizationName: "Integration Org", organizationCode: "X", organizationNtn: null, organizationStrn: null,
        branchName: "Alpha North", branchCostCenterId: null,
        approvedRefunds: [{ amountCents: 590, taxRefundCents: 0, lines: [{ grossCents: 590, taxRateBp: 1_800 }] }],
      })
      expect(plan.kind).toBe("insert")
      if (plan.kind !== "insert") return
      expect(plan.row).toMatchObject({ number, issueDate: "2026-08-24", status: "PARTIALLY_CREDITED", creditedTotalCents: 590, creditedTaxCents: 90 })

      const batch = "0123456789abcdef"
      await db.insert(invoices).values({
        organizationId: plan.row.organizationId,
        branchId: plan.row.branchId,
        orderId: plan.row.orderId,
        number: plan.row.number,
        issueDate: plan.row.issueDate,
        issuedAt: new Date(plan.row.issuedAt),
        origin: plan.row.origin,
        status: plan.row.status,
        seller: {},
        buyer: plan.row.buyer,
        netCents: plan.row.netCents,
        taxCents: plan.row.taxCents,
        totalCents: plan.row.totalCents,
        creditedNetCents: plan.row.creditedNetCents,
        creditedTaxCents: plan.row.creditedTaxCents,
        creditedTotalCents: plan.row.creditedTotalCents,
        legacySnapshot: order.receiptData as any,
        backfillBatch: batch,
      })

      await expect(db.delete(invoices).where(eq(invoices.orderId, order.id))).rejects.toThrow()
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oneflowe.invoice_ledger_rollback_batch', 'fedcba9876543210', true)`)
        await tx.delete(invoices).where(eq(invoices.orderId, order.id))
      })).rejects.toThrow()
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oneflowe.invoice_ledger_rollback_batch', ${batch}, true)`)
        await tx.delete(invoices).where(eq(invoices.orderId, order.id))
      })
      expect(await invoiceOf(order.id)).toBeUndefined()
    })
  })
})
