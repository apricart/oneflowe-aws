import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like } from "drizzle-orm"

import * as refundsRoute from "@/app/api/v1/orders/[id]/refunds/route"
import * as adminRefundsRoute from "@/app/api/v1/admin/refunds/route"
import * as receiptRoute from "@/app/api/v1/receipts/[orderId]/route"
import * as creditNoteDownloadRoute from "@/app/api/v1/receipts/[orderId]/credit-notes/[creditNoteId]/download/route"
import * as deleteOrderRoute from "@/app/api/v1/admin/delete-order/route"
import * as userRoute from "@/app/api/v1/users/[id]/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import {
  auditLogs,
  branches,
  creditNotes,
  invoiceSequences,
  invoices,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
  roles,
  scheduledReports,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { calculateLineCents } from "@/lib/quantity"
import { assignInvoiceNumberAtCreation, InvoiceCodeMissingError } from "@/lib/invoice-number"
import { PENDING_INVOICE_STATUSES } from "@/lib/pending-invoice"
import { invoiceStatusSql } from "@/lib/server/invoice-status-sql"
import { orderStillOwesSql } from "@/lib/server/overdue-payment-source"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"
import { splitInclusiveCents } from "@/lib/tax"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"
import { purgeInvoiceLedger } from "./helpers/invoice-ledger-cleanup"

/**
 * Edge cases of the invoice ledger against Postgres
 * (plans/OF-INVOICE-invoice-ledger.md), beyond invoice-ledger.test.ts: refunds
 * one unit at a time, both refund-approval routes, races between delivery and
 * refunds, documents for every role, and what the database does and does not
 * refuse.
 *
 * Every defect these tests found has been fixed; the comments above each say
 * what used to happen (plans/OF-INVOICE-invoice-ledger.md, "Fixes after the
 * edge-case review").
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", () => ({ sendRefundRequestEmail: vi.fn(async () => undefined) }))
vi.mock("@/lib/session-validation-cache", () => ({ invalidateSessionValidationCache: vi.fn(async () => undefined) }))
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

const TID_PREFIX = "ILE"

type SeedLine = { name: string; priceCents: number; quantity: number; taxRateBp?: number }

describe.skipIf(!hasTestDatabase)("invoice ledger edge cases", () => {
  let f: GroupRoleFixtures
  let seq = 0
  const ownOrderIds: number[] = []
  const ownUserIds: string[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const groupUser = (): Actor => ({ id: f.approverId, email: `approver-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `req-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })

  /** An approved order whose figures are exactly what order creation would write for `lines`. */
  async function seedApprovedOrder(lines: SeedLine[], input: { branchId?: number; createdByUserId?: string } = {}) {
    seq += 1
    const split = lines.map((line) => splitInclusiveCents(calculateLineCents(line.priceCents, line.quantity), line.taxRateBp ?? 1_800))
    const [order] = await db.insert(orders).values({
      tid: `${TID_PREFIX}${f.suffix}${seq}`.slice(0, 26),
      organizationId: f.organizationId,
      branchId: input.branchId ?? f.alphaNorthId,
      createdByUserId: input.createdByUserId ?? f.requesterId,
      approvedByUserId: f.approverId,
      status: "APPROVED",
      fulfillmentStatus: "NOT_STARTED",
      budgetTracked: false,
      subtotalCents: split.reduce((sum, line) => sum + line.netCents, 0),
      taxCents: split.reduce((sum, line) => sum + line.taxCents, 0),
      totalCents: split.reduce((sum, line) => sum + line.grossCents, 0),
      approvedAt: new Date(),
      receiptData: { date: "10/01/2026", buyerName: "Alpha North", buyerAddress: "Plot 1, Clifton, Karachi", items: [] } as any,
    }).returning({ id: orders.id })
    ownOrderIds.push(order.id)
    const items = await db.insert(orderItems).values(lines.map((line, index) => ({
      organizationId: f.organizationId,
      orderId: order.id,
      globalProductId: f.productId,
      productName: line.name,
      unit: "pcs",
      quantity: line.quantity,
      priceCents: line.priceCents,
      taxRateBp: line.taxRateBp ?? 1_800,
      taxCents: split[index].taxCents,
    }))).returning({ id: orderItems.id })
    return { orderId: order.id, itemIds: items.map((item) => item.id) }
  }

  async function progress(orderId: number, nextStatus: "IN_PROCESS" | "OUT_FOR_DELIVERY" | "DELIVERED") {
    return progressOrderFulfillment({
      orderId,
      nextStatus,
      deliveryChallanId: null,
      challanRequired: false,
      actor: { id: f.superAdminId, role: "SUPER_ADMIN" },
      authorize: async () => true,
    })
  }

  async function deliver(orderId: number) {
    for (const nextStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
      expect((await progress(orderId, nextStatus)).kind).toBe("updated")
    }
  }

  /** Super Admin's direct refund. */
  function directRefund(orderId: number, items: Array<{ id: number; quantity: number }>) {
    signIn(superAdmin())
    return refundsRoute.POST(
      request("POST", `http://localhost/api/v1/orders/${orderId}/refunds`, { items, reason: "Damaged in transit" }),
      { params: Promise.resolve({ id: String(orderId) }) },
    )
  }

  const invoiceOf = async (orderId: number) => {
    const [row] = await db.select().from(invoices).where(eq(invoices.orderId, orderId))
    return row
  }

  const orderOf = async (orderId: number) => {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId))
    return row
  }

  const notesOf = async (invoiceId: number) =>
    db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoiceId)).orderBy(creditNotes.id)

  const derivedInvoiceStatus = async (orderId: number) => {
    const [row] = await db.select({ status: invoiceStatusSql }).from(orders).where(eq(orders.id, orderId))
    return row.status
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
    if (ownUserIds.length > 0) {
      await db.update(auditLogs).set({ userId: null }).where(inArray(auditLogs.userId, ownUserIds))
      await db.delete(users).where(inArray(users.id, ownUserIds))
    }
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("a line refunded one unit at a time after delivery", () => {
    // PKR 100.01 × 3 at 18%: the line's tax is split once at sale (45.77), each
    // one-unit credit note splits its own 100.01 (15.26 each, 45.78 in all).
    let orderId: number
    let itemIds: number[]

    beforeAll(async () => {
      ({ orderId, itemIds } = await seedApprovedOrder([{ name: "Kettle", priceCents: 10_001, quantity: 3 }]))
      await deliver(orderId)
      for (let unit = 0; unit < 3; unit += 1) {
        expect((await directRefund(orderId, [{ id: itemIds[0], quantity: 1 }])).status).toBeLessThan(300)
      }
    })

    it("issues three consecutive credit notes that credit the whole invoice, and the order reads refunded", async () => {
      const invoice = await invoiceOf(orderId)
      const notes = await notesOf(invoice.id)
      expect(notes).toHaveLength(3)
      const sequence = notes.map((note) => Number(note.number.slice(-6)))
      expect(sequence).toEqual([sequence[0], sequence[0] + 1, sequence[0] + 2])
      expect(invoice).toMatchObject({ status: "CREDITED", creditedTotalCents: invoice.totalCents })
      expect((await orderOf(orderId)).status).toBe("REFUNDED")
      expect(await derivedInvoiceStatus(orderId)).toBe("CREDITED")

      // Each refund records the tax its own credit note carries.
      const refundRows = await db.select({ id: refunds.id, taxRefundCents: refunds.taxRefundCents }).from(refunds)
        .where(inArray(refunds.id, notes.map((note) => note.refundId)))
      const taxByRefund = new Map(refundRows.map((row) => [row.id, row.taxRefundCents]))
      for (const note of notes) expect(taxByRefund.get(note.refundId)).toBe(note.taxCents)
    })

    // Each note used to split its own gross, leaving the fully credited
    // invoice with −0.01 tax and +0.01 net. Each now takes the line's tax from
    // what is left on the line.
    it("credits exactly the tax the invoice charged", async () => {
      const invoice = await invoiceOf(orderId)
      expect(invoice.creditedTaxCents).toBe(invoice.taxCents)
      expect(invoice.creditedNetCents).toBe(invoice.netCents)
      const notes = await notesOf(invoice.id)
      expect(notes.map((note) => note.taxCents)).toEqual([1_526, 1_525, 1_526])
    })
  })

  describe("a refund approved before delivery", () => {
    let orderId: number
    let itemIds: number[]

    beforeAll(async () => {
      ({ orderId, itemIds } = await seedApprovedOrder([
        { name: "Tea 600pcs", priceCents: 1_180, quantity: 2 },
        { name: "Sugar 1kg", priceCents: 590, quantity: 1 },
      ]))
      expect((await directRefund(orderId, [{ id: itemIds[0], quantity: 1 }])).status).toBeLessThan(300)
      await deliver(orderId)
    })

    it("records its tax on the refund, issues no credit note, and invoices only what is left", async () => {
      const [refund] = await db.select().from(refunds).where(eq(refunds.orderId, orderId))
      expect(refund.taxRefundCents).toBe(180)

      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ status: "ISSUED", totalCents: 1_770, taxCents: 270, creditedTotalCents: 0 })
      expect(await notesOf(invoice.id)).toHaveLength(0)

      // The invoice and the refund together account for the order exactly.
      const order = await orderOf(orderId)
      expect(invoice.totalCents + refund.amountCents).toBe(order.totalCents)
      expect(invoice.taxCents + Number(refund.taxRefundCents)).toBe(order.taxCents)
    })

    it("a later refund of the rest credits the invoice, not the order total", async () => {
      expect((await directRefund(orderId, [{ id: itemIds[0], quantity: 1 }, { id: itemIds[1], quantity: 1 }])).status).toBeLessThan(300)
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ status: "CREDITED", creditedTotalCents: 1_770 })
      const notes = await notesOf(invoice.id)
      expect(notes.map((note) => note.totalCents)).toEqual([1_770])
    })

    // The Orders list used to derive "supplied + refund > 0 → PARTIALLY_CREDITED"
    // from the order while the invoice page read the ledger row (ISSUED). Once
    // an invoice is issued, its row is the status for both.
    it("the Orders list and the invoice page agree on its status", async () => {
      const { orderId: freshOrderId, itemIds: freshItems } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }])
      expect((await directRefund(freshOrderId, [{ id: freshItems[0], quantity: 1 }])).status).toBeLessThan(300)
      await deliver(freshOrderId)

      signIn(headOffice())
      const response = await receiptRoute.GET(
        request("GET", `http://localhost/api/v1/receipts/${freshOrderId}`),
        { params: Promise.resolve({ orderId: String(freshOrderId) }) },
      )
      const page = await response.json()
      expect(page.invoiceStatus).toBe("ISSUED")
      expect(await derivedInvoiceStatus(freshOrderId)).toBe(page.invoiceStatus)
    })
  })

  describe("approving a requester's refund through the admin route", () => {
    it("issues the credit note on approval, never on the request", async () => {
      const { orderId, itemIds } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }])
      await deliver(orderId)

      // The request as the requester's route writes it: pending, itemised.
      const [pending] = await db.insert(refunds).values({
        organizationId: f.organizationId,
        orderId,
        amountCents: 1_180,
        reason: "Short delivered",
        status: "PENDING",
        requestedByUserId: f.requesterId,
      } as any).returning({ id: refunds.id })
      await db.insert(refundItems).values({ refundId: pending.id, orderItemId: itemIds[0], quantity: 1, amountCents: 1_180 })
      const invoice = await invoiceOf(orderId)
      expect(await notesOf(invoice.id)).toHaveLength(0)

      signIn(superAdmin())
      const response = await adminRefundsRoute.POST(request("POST", "http://localhost/api/v1/admin/refunds", {
        orderId,
        items: [{ itemId: itemIds[0], quantity: 1 }],
        refundRequestId: pending.id,
      }))
      expect(response.status).toBeLessThan(300)

      const notes = await notesOf(invoice.id)
      expect(notes).toHaveLength(1)
      expect(notes[0]).toMatchObject({ refundId: pending.id, totalCents: 1_180, taxCents: 180, reason: "Short delivered" })
      const [approved] = await db.select().from(refunds).where(eq(refunds.id, pending.id))
      expect(approved).toMatchObject({ status: "APPROVED", taxRefundCents: 180 })
      expect(await invoiceOf(orderId)).toMatchObject({ status: "PARTIALLY_CREDITED", creditedTotalCents: 1_180 })
    })

    it("only Super Admin may approve", async () => {
      signIn(headOffice())
      const response = await adminRefundsRoute.POST(request("POST", "http://localhost/api/v1/admin/refunds", {
        orderId: 1, items: [{ itemId: 1, quantity: 1 }],
      }))
      expect(response.status).toBe(403)
    })
  })

  describe("races", () => {
    it("parallel refunds of one invoice never over-credit it, and number their notes without gaps", async () => {
      const { orderId, itemIds } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 4 }])
      await deliver(orderId)

      const responses = await Promise.all(Array.from({ length: 5 }, () => directRefund(orderId, [{ id: itemIds[0], quantity: 1 }])))
      const accepted = responses.filter((response) => response.status < 300)
      // Four units can be refunded; the fifth must be refused, never credited.
      expect(accepted).toHaveLength(4)
      expect(responses.filter((response) => response.status >= 300).every((response) => [400, 409].includes(response.status))).toBe(true)

      const invoice = await invoiceOf(orderId)
      const notes = await notesOf(invoice.id)
      expect(notes).toHaveLength(4)
      expect(invoice).toMatchObject({ status: "CREDITED", creditedTotalCents: invoice.totalCents })
      const sequence = notes.map((note) => Number(note.number.slice(-6))).sort((a, b) => a - b)
      expect(sequence).toEqual([sequence[0], sequence[0] + 1, sequence[0] + 2, sequence[0] + 3])
      expect(notes.reduce((sum, note) => sum + note.totalCents, 0)).toBe(invoice.totalCents)
    })

    it("a refund racing the delivery is either taken off the invoice or credited against it — once", async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { orderId, itemIds } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }])
        expect((await progress(orderId, "IN_PROCESS")).kind).toBe("updated")
        expect((await progress(orderId, "OUT_FOR_DELIVERY")).kind).toBe("updated")

        const [delivered, refunded] = await Promise.all([
          progress(orderId, "DELIVERED"),
          directRefund(orderId, [{ id: itemIds[0], quantity: 1 }]),
        ])
        expect(delivered.kind).toBe("updated")
        expect(refunded.status).toBeLessThan(300)

        const order = await orderOf(orderId)
        const invoice = await invoiceOf(orderId)
        const notes = await notesOf(invoice.id)
        // What remains billable is the same whichever transaction won.
        expect(invoice.totalCents - invoice.creditedTotalCents).toBe(order.totalCents - Number(order.refundAmountCents))
        // And the refund appears exactly once: on the invoice's lines, or as a note.
        const takenOff = invoice.totalCents === order.totalCents - 1_180
        expect(takenOff ? notes.length : notes.length - 1).toBe(0)
      }
    })
  })

  describe("documents", () => {
    let orderId: number
    let noteId: number

    beforeAll(async () => {
      let itemIds: number[]
      ({ orderId, itemIds } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }]))
      await deliver(orderId)
      expect((await directRefund(orderId, [{ id: itemIds[0], quantity: 1 }])).status).toBeLessThan(300)
      noteId = (await notesOf((await invoiceOf(orderId)).id))[0].id
    })

    const download = (actor: Actor | null, forOrder: number, creditNoteId: number | string) => {
      signIn(actor)
      return creditNoteDownloadRoute.GET(
        request("GET", `http://localhost/api/v1/receipts/${forOrder}/credit-notes/${creditNoteId}/download`),
        { params: Promise.resolve({ orderId: String(forOrder), creditNoteId: String(creditNoteId) }) },
      )
    }

    it("refuses an anonymous caller", async () => {
      expect((await download(null, orderId, noteId)).status).toBe(401)
    })

    it("refuses a malformed id before reading anything", async () => {
      expect((await download(superAdmin(), orderId, "0")).status).toBe(400)
      expect((await download(superAdmin(), orderId, "1e3")).status).toBe(400)
      expect((await download(superAdmin(), orderId, "-1")).status).toBe(400)
    })

    it("lets the requester who raised the order download it, as an attachment that is never cached", async () => {
      const response = await download(requester(), orderId, noteId)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="credit-note-.+\.pdf"$/)
      expect(response.headers.get("cache-control")).toBe("no-store")
    })

    it("refuses a branch-scoped role outside its branches, and a requester an order it did not raise", async () => {
      const { orderId: betaOrderId, itemIds } = await seedApprovedOrder(
        [{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }],
        { branchId: f.betaBranchId, createdByUserId: f.headOfficeId },
      )
      await deliver(betaOrderId)
      expect((await directRefund(betaOrderId, [{ id: itemIds[0], quantity: 1 }])).status).toBeLessThan(300)
      const betaNote = (await notesOf((await invoiceOf(betaOrderId)).id))[0]

      expect((await download(headOffice(), betaOrderId, betaNote.id)).status).toBe(200)
      // GROUP_USER reads only its assigned branches (Alpha); Beta is outside them.
      expect((await download(groupUser(), betaOrderId, betaNote.id)).status).toBe(403)
      expect((await download(groupUser(), orderId, noteId)).status).toBe(200)
      // GROUP_ORDER_PORTAL reads only the orders it raised.
      expect((await download(requester(), betaOrderId, betaNote.id)).status).toBe(403)
      // Nor through an order it may read: a note is only reachable through the order it credits.
      expect((await download(requester(), orderId, betaNote.id)).status).toBe(404)
    })

    it("shows the credit note on the invoice page, and the invoice still prints what was issued", async () => {
      signIn(headOffice())
      const response = await receiptRoute.GET(
        request("GET", `http://localhost/api/v1/receipts/${orderId}`),
        { params: Promise.resolve({ orderId: String(orderId) }) },
      )
      const body = await response.json()
      const invoice = await invoiceOf(orderId)
      expect(body.receiptData).toMatchObject({
        frozen: true,
        invoiceNumber: invoice.number,
        totalAmount: 23.6,
        invoiceStatus: "PARTIALLY_CREDITED",
        creditNotes: [{ id: noteId, total: 11.8 }],
      })
    })
  })

  describe("orders the issuer cannot invoice", () => {
    // A delivered order whose lines were all zero-priced used to get no tax
    // invoice, while its status read "Issued" and its page printed an INVOICE
    // with no number. It is now invoiced at zero, and owes nothing.
    it("every delivered order carries a tax invoice, a free one at zero, which is not an unpaid invoice", async () => {
      const { orderId } = await seedApprovedOrder([{ name: "Free sample", priceCents: 0, quantity: 2 }])
      await deliver(orderId)
      expect(await derivedInvoiceStatus(orderId)).toBe("ISSUED")
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ totalCents: 0, taxCents: 0, status: "ISSUED" })
      expect(invoice.number).toMatch(/-APR-\d{6}$/)

      // The pending-invoice notice's own predicates, against this order alone.
      const pending = await db.select({ id: orders.id }).from(orders).where(and(
        eq(orders.id, orderId),
        eq(orders.paymentStatus, "UNPAID"),
        inArray(invoiceStatusSql, [...PENDING_INVOICE_STATUSES]),
        orderStillOwesSql,
      ))
      expect(pending).toHaveLength(0)
    })

    it("an organization without a code cannot record a delivery, and nothing is half-written", async () => {
      const { orderId } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 1 }])
      expect((await progress(orderId, "IN_PROCESS")).kind).toBe("updated")
      expect((await progress(orderId, "OUT_FOR_DELIVERY")).kind).toBe("updated")

      const [{ code }] = await db.select({ code: organizations.code }).from(organizations).where(eq(organizations.id, f.organizationId))
      const [sequenceBefore] = await db.select({ lastValue: invoiceSequences.lastValue }).from(invoiceSequences)
        .where(eq(invoiceSequences.organizationId, f.organizationId))
      await db.update(organizations).set({ code: null }).where(eq(organizations.id, f.organizationId))
      try {
        // Answered as an outcome the routes turn into a 409, not a 500.
        expect((await progress(orderId, "DELIVERED")).kind).toBe("invoice-code-missing")
        // And no new order is taken for it in the first place.
        await expect(db.transaction((tx) => assignInvoiceNumberAtCreation(tx, {}, {
          organizationId: f.organizationId,
          tid: "ILE-NOCODE",
          invoiceSequenceReady: true,
        }))).rejects.toBeInstanceOf(InvoiceCodeMissingError)
      } finally {
        await db.update(organizations).set({ code }).where(eq(organizations.id, f.organizationId))
      }

      const order = await orderOf(orderId)
      expect(order.fulfillmentStatus).toBe("OUT_FOR_DELIVERY")
      expect(order.deliveredAt).toBeNull()
      expect(await invoiceOf(orderId)).toBeUndefined()
      const [sequenceAfter] = await db.select({ lastValue: invoiceSequences.lastValue }).from(invoiceSequences)
        .where(eq(invoiceSequences.organizationId, f.organizationId))
      expect(sequenceAfter?.lastValue).toBe(sequenceBefore?.lastValue)
    })
  })

  describe("deleting an approved order that was never delivered", () => {
    it("burns no number, and the audit row says it held none", async () => {
      const { orderId } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 1 }])
      const [before] = await db.select({ lastValue: invoiceSequences.lastValue }).from(invoiceSequences)
        .where(eq(invoiceSequences.organizationId, f.organizationId))

      signIn(superAdmin())
      const response = await deleteOrderRoute.DELETE(request("DELETE", `http://localhost/api/v1/admin/delete-order?id=${orderId}`))
      expect(response.status).toBe(200)

      const [after] = await db.select({ lastValue: invoiceSequences.lastValue }).from(invoiceSequences)
        .where(eq(invoiceSequences.organizationId, f.organizationId))
      expect(after?.lastValue).toBe(before?.lastValue)
      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(eq(auditLogs.entityId, String(orderId)))
        .orderBy(auditLogs.id)
      expect(JSON.stringify(audit?.metadata ?? {})).toContain('"invoiceNumber":null')
    })

    it("refuses an order that is out for delivery once it is delivered, even by Super Admin", async () => {
      const { orderId } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 1 }])
      await deliver(orderId)
      signIn(superAdmin())
      const response = await deleteOrderRoute.DELETE(request("DELETE", `http://localhost/api/v1/admin/delete-order?id=${orderId}`))
      expect(response.status).toBe(409)
      expect(await invoiceOf(orderId)).toBeDefined()
    })
  })

  describe("the organization code locks once a number is drawn under it", () => {
    let organizationId: number
    let branchId: number

    beforeAll(async () => {
      const [organization] = await db.insert(organizations)
        .values({ name: `IT ILE No Code ${f.suffix}`, code: null }).returning({ id: organizations.id })
      organizationId = organization.id
      const [branch] = await db.insert(branches)
        .values({ organizationId, name: `IT ILE No Code Branch ${f.suffix}` }).returning({ id: branches.id })
      branchId = branch.id
    })

    afterAll(async () => {
      await purgeInvoiceLedger({ organizationIds: [organizationId] })
      const ids = (await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, organizationId))).map((row) => row.id)
      if (ids.length > 0) {
        await db.delete(orderItems).where(inArray(orderItems.orderId, ids))
        await db.delete(orders).where(inArray(orders.id, ids))
      }
      await db.delete(invoiceSequences).where(eq(invoiceSequences.organizationId, organizationId))
      // The delivery and the code change audited themselves against this
      // throwaway organization; those rows go with it.
      await db.delete(auditLogs).where(eq(auditLogs.organizationId, organizationId))
      await db.delete(branches).where(eq(branches.id, branchId))
      await db.delete(organizations).where(eq(organizations.id, organizationId))
    })

    const setCode = (code: string) => {
      signIn(superAdmin())
      return organizationRoute.PATCH(
        request("PATCH", `http://localhost/api/v1/organizations/${organizationId}`, { code }),
        { params: Promise.resolve({ id: String(organizationId) }) },
      )
    }

    async function seedOrderHere() {
      seq += 1
      const [order] = await db.insert(orders).values({
        tid: `${TID_PREFIX}N${f.suffix}${seq}`.slice(0, 26),
        organizationId,
        branchId,
        createdByUserId: f.headOfficeId,
        approvedByUserId: f.headOfficeId,
        status: "APPROVED",
        fulfillmentStatus: "NOT_STARTED",
        budgetTracked: false,
        subtotalCents: 1_000,
        taxCents: 180,
        totalCents: 1_180,
        approvedAt: new Date(),
        receiptData: { date: "10/01/2026", items: [] } as any,
      }).returning({ id: orders.id })
      await db.insert(orderItems).values({
        organizationId, orderId: order.id, globalProductId: f.productId, productName: "Tea", unit: "pcs",
        quantity: 1, priceCents: 1_180, taxRateBp: 1_800, taxCents: 180,
      })
      return order.id
    }

    const codeOf = async () => (await db.select({ code: organizations.code }).from(organizations).where(eq(organizations.id, organizationId)))[0].code

    it("lets Super Admin give a code to an organization that has orders but never had one", async () => {
      const orderId = await seedOrderHere()
      expect((await progress(orderId, "IN_PROCESS")).kind).toBe("updated")
      expect((await progress(orderId, "OUT_FOR_DELIVERY")).kind).toBe("updated")
      expect((await progress(orderId, "DELIVERED")).kind).toBe("invoice-code-missing")

      expect((await setCode(`ILEA${f.suffix}`.slice(0, 20))).status).toBe(200)
      expect((await progress(orderId, "DELIVERED")).kind).toBe("updated")
      expect((await invoiceOf(orderId)).number).toMatch(new RegExp(`^${String(await codeOf())}-APR-000001$`, "i"))
    })

    it("then refuses to change it, because a number was drawn under it", async () => {
      const response = await setCode(`ILEB${f.suffix}`.slice(0, 20))
      expect(response.status).toBe(409)
      expect(String(await codeOf())).toMatch(/^ILEA/i)
    })
  })

  describe("refunding a line in pieces", () => {
    // 101 paisa × 1.5 charged 152. Three refunds of 0.5 used to be priced at 51
    // each, so the third (51 > the 50 left) was refused and half a unit could
    // never be refunded. The refund that takes the last units now gives back
    // what is left.
    it("refunds every paisa the line charged, and credits the invoice in full", async () => {
      const { orderId, itemIds } = await seedApprovedOrder([{ name: "Rice (kg)", priceCents: 101, quantity: 1.5 }])
      await deliver(orderId)
      for (let piece = 0; piece < 3; piece += 1) {
        const response = await directRefund(orderId, [{ id: itemIds[0], quantity: 0.5 }])
        expect(response.status, await response.clone().text()).toBeLessThan(300)
      }

      const amounts = (await db.select({ amountCents: refunds.amountCents }).from(refunds)
        .where(eq(refunds.orderId, orderId)).orderBy(refunds.id)).map((row) => row.amountCents)
      expect(amounts).toEqual([51, 51, 50])
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ totalCents: 152, creditedTotalCents: 152, status: "CREDITED" })
      expect(invoice.creditedTaxCents).toBe(invoice.taxCents)
      expect((await orderOf(orderId)).status).toBe("REFUNDED")
    })

    it("prices the last pieces the same through the admin approval route", async () => {
      const { orderId, itemIds } = await seedApprovedOrder([{ name: "Rice (kg)", priceCents: 101, quantity: 1.5 }])
      await deliver(orderId)
      signIn(superAdmin())
      for (let piece = 0; piece < 3; piece += 1) {
        const response = await adminRefundsRoute.POST(request("POST", "http://localhost/api/v1/admin/refunds", {
          orderId, items: [{ itemId: itemIds[0], quantity: 0.5 }],
        }))
        expect(response.status, await response.clone().text()).toBeLessThan(300)
      }
      const invoice = await invoiceOf(orderId)
      expect(invoice).toMatchObject({ totalCents: 152, creditedTotalCents: 152, status: "CREDITED" })
    })
  })

  describe("deleting the person who issued an invoice", () => {
    // Delivery is not one of the order columns the user-delete route counted as
    // history, so a warehouse account (or a Super Admin who had only marked
    // deliveries) took the hard-delete path: it detached the person from every
    // audit row, outside any transaction, and only then hit the invoice's
    // foreign key. The delete was refused; the attribution was already gone.
    const warehouseRoleId = async () => {
      const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "WAREHOUSE")).limit(1)
      return role?.id ?? (await db.insert(roles).values({ name: "WAREHOUSE", description: "invoice edge cases" }).returning({ id: roles.id }))[0].id
    }

    async function warehouseUser(label: string): Promise<string> {
      const [person] = await db.insert(users).values({
        email: `it-ile-${label}-${f.suffix}@example.test`,
        username: `it-ile-${label}-${f.suffix}`,
        passwordHash: "$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE",
        roleId: await warehouseRoleId(),
        organizationId: null,
        branchId: null,
      } as any).returning({ id: users.id })
      ownUserIds.push(person.id)
      return person.id
    }

    const deleteUser = (id: string) => {
      signIn(superAdmin())
      return userRoute.DELETE(
        new NextRequest(`http://localhost/api/v1/users/${id}`, { method: "DELETE" }),
        { params: Promise.resolve({ id }) },
      )
    }

    const auditUserOf = async (action: string, entityId: string) => {
      const [audit] = await db.select({ userId: auditLogs.userId }).from(auditLogs)
        .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)))
      return audit?.userId
    }

    it("deactivates rather than deletes someone who issued an invoice, and the trail keeps naming them", async () => {
      const warehouseId = await warehouseUser("issuer")
      const { orderId } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 1 }])
      for (const nextStatus of ["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
        const outcome = await progressOrderFulfillment({
          orderId,
          nextStatus,
          deliveryChallanId: null,
          challanRequired: false,
          actor: { id: warehouseId, role: "WAREHOUSE" },
          authorize: async () => true,
        })
        expect(outcome.kind).toBe("updated")
      }
      const invoiceId = (await invoiceOf(orderId)).id

      const response = await deleteUser(warehouseId)
      expect(response.status).toBe(200)

      const [person] = await db.select({ isActive: users.isActive, deletedAt: users.deletedAt }).from(users).where(eq(users.id, warehouseId))
      expect(person).toMatchObject({ isActive: false })
      expect(person.deletedAt).not.toBeNull()
      const [invoice] = await db.select({ issuedByUserId: invoices.issuedByUserId }).from(invoices).where(eq(invoices.id, invoiceId))
      expect(invoice.issuedByUserId).toBe(warehouseId)
      expect(await auditUserOf("ISSUE_TAX_INVOICE", String(invoiceId))).toBe(warehouseId)
    })

    it("puts the audit trail back when the database refuses a hard delete", async () => {
      // A reference the route's history check does not count: the database
      // refuses the delete, and the cleanup before it must roll back with it.
      const personId = await warehouseUser("unlisted")
      await db.insert(auditLogs).values({ userId: personId, action: "IT_ILE_MARKER", entity: "Test", entityId: personId })
      await db.insert(scheduledReports).values({ userId: personId, reportName: "IT ILE", frequency: "daily", format: "pdf" })
      try {
        const response = await deleteUser(personId)
        expect(response.status).toBe(400)
        const [person] = await db.select({ id: users.id }).from(users).where(eq(users.id, personId))
        expect(person).toBeDefined()
        expect(await auditUserOf("IT_ILE_MARKER", personId)).toBe(personId)
      } finally {
        await db.delete(scheduledReports).where(eq(scheduledReports.userId, personId))
        await db.delete(auditLogs).where(eq(auditLogs.action, "IT_ILE_MARKER"))
      }
    })
  })

  describe("what the database refuses on an issued invoice", () => {
    let invoiceId: number
    let original: { status: string; creditedNetCents: number; creditedTaxCents: number; creditedTotalCents: number }

    beforeAll(async () => {
      const { orderId } = await seedApprovedOrder([{ name: "Tea 600pcs", priceCents: 1_180, quantity: 2 }])
      await deliver(orderId)
      const invoice = await invoiceOf(orderId)
      invoiceId = invoice.id
      original = {
        status: invoice.status,
        creditedNetCents: invoice.creditedNetCents,
        creditedTaxCents: invoice.creditedTaxCents,
        creditedTotalCents: invoice.creditedTotalCents,
      }
    })

    const restore = () => db.update(invoices).set(original).where(eq(invoices.id, invoiceId))

    it("refuses crediting more than the invoice's total", async () => {
      await expect(db.update(invoices).set({ creditedTotalCents: 2_361 }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
    })

    it("refuses moving it to another order, branch or organization", async () => {
      await expect(db.update(invoices).set({ orderId: f.alphaNorthOrderId }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoices).set({ branchId: f.alphaSouthId }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      await expect(db.update(invoices).set({ issueDate: "2020-01-01" }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
    })

    it("refuses a status that contradicts the credited totals", async () => {
      try {
        await expect(db.update(invoices).set({ status: "CREDITED" }).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      } finally {
        await restore()
      }
    })

    it("refuses crediting more tax than the invoice charged", async () => {
      try {
        // Consistent in every other respect: a partial credit whose net and tax add up.
        await expect(db.update(invoices).set({ status: "PARTIALLY_CREDITED", creditedTaxCents: 361, creditedNetCents: 0, creditedTotalCents: 361 })
          .where(eq(invoices.id, invoiceId))).rejects.toThrow()
      } finally {
        await restore()
      }
    })

    it("refuses credited figures that do not add up", async () => {
      await expect(db.update(invoices).set({ status: "PARTIALLY_CREDITED", creditedTaxCents: 100, creditedNetCents: 100, creditedTotalCents: 100 })
        .where(eq(invoices.id, invoiceId))).rejects.toThrow()
    })

    // Credits only accumulate: credit notes are immutable.
    it("refuses lowering what has been credited", async () => {
      await db.update(invoices).set({ creditedNetCents: 1_000, creditedTaxCents: 180, creditedTotalCents: 1_180, status: "PARTIALLY_CREDITED" })
        .where(eq(invoices.id, invoiceId))
      try {
        await expect(db.update(invoices).set(original).where(eq(invoices.id, invoiceId))).rejects.toThrow()
      } finally {
        await restore().catch(() => undefined)
      }
    })
  })
})
