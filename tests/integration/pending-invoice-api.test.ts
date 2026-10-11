import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import * as mockedNextAuth from "next-auth"
import { inArray } from "drizzle-orm"

import * as pendingInvoiceRoute from "@/app/api/v1/orders/pending-invoice/route"
import { orders } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The unit test mocks the database, so the one thing it cannot prove is the
 * query itself: that the status, payment and owner predicates together select
 * exactly the invoices `lib/pending-invoice.ts` calls pending, against Postgres.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))

const { getServerSession } = mockedNextAuth
const { GET } = pendingInvoiceRoute

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId?: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

async function readStatus() {
  const response = await GET()
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("GET /api/v1/orders/pending-invoice", () => {
  let f: GroupRoleFixtures
  const seededOrderIds: number[] = []
  let seedCounter = 0

  const requester = (): Actor => ({
    id: f.requesterId,
    email: `rq-${f.suffix}@example.test`,
    role: "GROUP_ORDER_PORTAL",
    organizationId: f.organizationId,
  })

  /** An order carrying an invoice snapshot, as order creation writes one. */
  async function seedInvoice(input: {
    createdByUserId: string
    status: string
    paymentStatus?: "PAID" | "UNPAID"
    fulfillmentStatus?: string
    invoiceNumber?: string | null
    createdAt?: Date
    organizationId?: number
    branchId?: number
  }): Promise<{ id: number; tid: string }> {
    seedCounter += 1
    const tid = `ITPI-${seedCounter}-${f.suffix}`.slice(0, 26)
    const [row] = await db
      .insert(orders)
      .values({
        tid,
        organizationId: input.organizationId ?? f.organizationId,
        branchId: input.branchId ?? f.alphaNorthId,
        createdByUserId: input.createdByUserId,
        status: input.status,
        fulfillmentStatus: input.fulfillmentStatus ?? "DELIVERED",
        paymentStatus: input.paymentStatus ?? "UNPAID",
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
        // Only the field the endpoint reads; `null` stands for a snapshot
        // written before invoice numbering existed.
        receiptData: (input.invoiceNumber === null
          ? { items: [] }
          : { invoiceNumber: input.invoiceNumber ?? `INV-${seedCounter}` }) as any,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning({ id: orders.id, tid: orders.tid })
    seededOrderIds.push(row.id)
    return row
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  afterEach(async () => {
    if (seededOrderIds.length > 0) {
      await db.delete(orders).where(inArray(orders.id, seededOrderIds.splice(0)))
    }
  })

  afterAll(async () => {
    if (f) await destroyGroupRoleFixtures(f)
    await closePool()
  })

  it("refuses an unauthenticated caller", async () => {
    signIn(null)
    expect((await readStatus()).status).toBe(401)
  })

  it("reports nothing when the caller's orders carry no unpaid invoice", async () => {
    signIn(requester())
    expect(await readStatus()).toEqual({
      status: 200,
      body: { hasPendingInvoice: false, pendingInvoice: null },
    })
  })

  // A tax invoice exists once the goods are delivered (plans/OF-INVOICE-invoice-ledger.md);
  // an approved order still on its way has only a proforma.
  it.each(["APPROVED", "FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED", " fulfilled "])(
    "reports an unpaid invoice on a delivered %s order",
    async (status) => {
      signIn(requester())
      const order = await seedInvoice({ createdByUserId: f.requesterId, status, invoiceNumber: "INV-000042" })
      expect((await readStatus()).body).toEqual({
        hasPendingInvoice: true,
        pendingInvoice: { orderId: order.id, invoiceNumber: "INV-000042", orderReference: order.tid },
      })
    },
  )

  it.each(["PENDING", "REJECTED", "CANCELLED", "REFUNDED"])(
    "does not treat a %s order as a pending invoice",
    async (status) => {
      signIn(requester())
      await seedInvoice({ createdByUserId: f.requesterId, status })
      expect((await readStatus()).body.hasPendingInvoice).toBe(false)
    },
  )

  it("does not treat a proforma (approved, not yet delivered) as a pending invoice", async () => {
    signIn(requester())
    await seedInvoice({ createdByUserId: f.requesterId, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
    expect((await readStatus()).body.hasPendingInvoice).toBe(false)
  })

  it("does not treat a paid invoice as pending", async () => {
    signIn(requester())
    await seedInvoice({ createdByUserId: f.requesterId, status: "FULFILLED", paymentStatus: "PAID" })
    expect((await readStatus()).body.hasPendingInvoice).toBe(false)
  })

  it("never reports another user's invoice, in the same tenant or another", async () => {
    signIn(requester())
    await seedInvoice({ createdByUserId: f.headOfficeId, status: "APPROVED" })
    await seedInvoice({
      createdByUserId: f.foreignHeadOfficeId,
      status: "APPROVED",
      organizationId: f.foreignOrganizationId,
      branchId: f.foreignBranchId,
    })
    expect((await readStatus()).body.hasPendingInvoice).toBe(false)
  })

  it("names the newest pending invoice when there are several", async () => {
    signIn(requester())
    await seedInvoice({
      createdByUserId: f.requesterId,
      status: "FULFILLED",
      invoiceNumber: "INV-OLD",
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    })
    await seedInvoice({
      createdByUserId: f.requesterId,
      status: "APPROVED",
      invoiceNumber: "INV-NEW",
      createdAt: new Date(Date.UTC(2026, 1, 1)),
    })
    expect((await readStatus()).body.pendingInvoice.invoiceNumber).toBe("INV-NEW")
  })

  it("falls back to the order reference when the snapshot has no invoice number", async () => {
    signIn(requester())
    const order = await seedInvoice({ createdByUserId: f.requesterId, status: "APPROVED", invoiceNumber: null })
    expect((await readStatus()).body.pendingInvoice.invoiceNumber).toBe(order.tid)
  })
})
