import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, desc, eq, inArray, like } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as preCheckRoute from "@/app/api/v1/orders/delivery-acknowledgement/route"
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
import {
  UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION,
  UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION,
} from "@/lib/ordering-block-threshold"
import { resolveBranchPaymentControl } from "@/lib/server/payment-control"
import { resolveBranchDeliveryAcknowledgement } from "@/lib/server/unacknowledged-delivery-block"
import { UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION } from "@/lib/unacknowledged-delivery-block"
import { UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION } from "@/lib/unpaid-invoice-block"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Configurable ordering-block thresholds against Postgres
 * (plans/OF-ORDERING-BLOCK-configurable-thresholds.md).
 *
 * Nothing about the limits or the counts is faked: the real organization
 * routes write the real columns, and the real gates read them back inside the
 * real order, group-order, status and pre-check routes. Only the session,
 * rate limiting, cache and mail are stubbed.
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
  queueOrderDeliveredNotifications: vi.fn(async () => ({ eventKeys: [], recipientCount: 0 })),
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

const SEEDED_TID_PREFIX = "OBT-"

let idempotencyCounter = 0
const idempotencyKey = () => `obt-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`
let seededCounter = 0

type Limits = { unpaidInvoiceBlockThreshold?: number; unacknowledgedDeliveryBlockThreshold?: number }
type Toggles = { blockOrderingOnUnpaidInvoices?: boolean; blockOrderingOnUnacknowledgedDeliveries?: boolean }

describe.skipIf(!hasTestDatabase)("configurable ordering-block thresholds", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  const createdOrganizationIds: number[] = []

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, email: `fho-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  // Role checks run on the session alone, so these borrow a real user id.
  const branchAdmin = (): Actor => ({ id: f.approverId, email: `ba-${f.suffix}@example.test`, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const orderPortal = (): Actor => ({ id: f.requesterId, email: `op-${f.suffix}@example.test`, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.alphaNorthId })

  const configure = (organizationId: number, values: Limits & Toggles) =>
    db.update(organizations).set(values).where(eq(organizations.id, organizationId))

  const limitsOf = async (organizationId: number) => {
    const [row] = await db
      .select({
        unpaidInvoiceBlockThreshold: organizations.unpaidInvoiceBlockThreshold,
        unacknowledgedDeliveryBlockThreshold: organizations.unacknowledgedDeliveryBlockThreshold,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
    return row
  }

  /** A fulfilled, delivered, invoiced, unpaid order — what the unpaid-invoice gate counts. */
  async function invoice(branchId: number, organizationId = f.organizationId, deliveredAt?: Date): Promise<number> {
    seededCounter += 1
    const [row] = await db
      .insert(orders)
      .values({
        tid: `${SEEDED_TID_PREFIX}${f.suffix}-i${seededCounter}`,
        organizationId,
        branchId,
        createdByUserId: f.headOfficeId,
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        paymentStatus: "UNPAID",
        receiptData: { invoiceNumber: `INV-OBT-${seededCounter}` } as any,
        deliveredAt: deliveredAt ?? new Date(Date.UTC(2026, 7, 1, 0, 0, seededCounter)),
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      })
      .returning({ id: orders.id })
    return row.id
  }

  const invoices = async (count: number, branchId: number, organizationId = f.organizationId) => {
    for (let index = 0; index < count; index += 1) await invoice(branchId, organizationId)
  }

  /** An approved, delivered, unacknowledged order — what the delivery gate counts. */
  async function delivery(branchId: number, organizationId = f.organizationId): Promise<void> {
    seededCounter += 1
    await db.insert(orders).values({
      tid: `${SEEDED_TID_PREFIX}${f.suffix}-d${seededCounter}`,
      organizationId,
      branchId,
      createdByUserId: f.headOfficeId,
      status: "APPROVED",
      fulfillmentStatus: "DELIVERED",
      deliveredAt: new Date("2025-01-16T10:00:00.000Z"),
      createdAt: new Date("2025-01-15T10:00:00.000Z"),
      subtotalCents: 10_000,
      taxCents: 0,
      totalCents: 10_000,
    })
  }

  const deliveries = async (count: number, branchId: number, organizationId = f.organizationId) => {
    for (let index = 0; index < count; index += 1) await delivery(branchId, organizationId)
  }

  const orderFor = (branchId: number, actor: Actor = headOffice()) => {
    signIn(actor)
    return ordersRoute.POST(request(
      "POST",
      "http://localhost/api/v1/orders",
      { branchId, organizationId: f.organizationId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
      { "Idempotency-Key": idempotencyKey() },
    )).then(read)
  }

  const groupOrder = async (branchIds: number[]) => {
    signIn(requester())
    const { status, body } = await groupOrdersRoute.POST(request(
      "POST",
      "http://localhost/api/v1/group-portal/orders",
      { groupId: f.alphaGroupId, entries: [{ branchIds, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
      { "Idempotency-Key": idempotencyKey() },
    )).then(read)
    expect(status).toBe(201)
    return new Map<number, Record<string, unknown>>(
      body.item.results.map((result: Record<string, unknown>) => [result.branchId as number, result]),
    )
  }

  const patchOrganization = (organizationId: number, body: unknown) =>
    organizationRoute.PATCH(
      request("PATCH", `http://localhost/api/v1/organizations/${organizationId}`, body),
      { params: Promise.resolve({ id: String(organizationId) }) },
    ).then(read)

  const createOrganization = async (body: Record<string, unknown>) => {
    const result = await read(await organizationsRoute.POST(request("POST", "http://localhost/api/v1/organizations", body)))
    if (result.status === 201) createdOrganizationIds.push(result.body.item.id)
    return result
  }

  const auditsOf = (organizationId: number, action: string) => db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.organizationId, organizationId), eq(auditLogs.action, action)))
    .orderBy(desc(auditLogs.id))

  const paymentStatus = (branchId: number, organizationId = f.organizationId) =>
    resolveBranchPaymentControl(db, { organizationId, branchId })
  const deliveryStatus = (branchId: number, organizationId = f.organizationId) =>
    resolveBranchDeliveryAcknowledgement(db, { organizationId, branchId })

  /** The SQLSTATE of a rejected statement, whether drizzle wraps it or not. */
  const sqlStateOf = async (promise: Promise<unknown>) => {
    try {
      await promise
      return null
    } catch (caught) {
      const failure = caught as { code?: string; cause?: { code?: string } }
      return failure.cause?.code ?? failure.code ?? "unknown"
    }
  }

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
    await db.update(globalProducts).set({ stockQuantity: 10_000 }).where(eq(globalProducts.id, f.productId))
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

  // Each case states its own rows, toggles and limits; nothing carries over.
  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(orders).where(and(inArray(orders.organizationId, organizationIds), like(orders.tid, `${SEEDED_TID_PREFIX}%`)))
    await db.delete(paymentControlExceptions).where(inArray(paymentControlExceptions.organizationId, organizationIds))
    for (const organizationId of organizationIds) {
      await configure(organizationId, {
        blockOrderingOnUnpaidInvoices: false,
        blockOrderingOnUnacknowledgedDeliveries: false,
        unpaidInvoiceBlockThreshold: 2,
        unacknowledgedDeliveryBlockThreshold: 2,
      })
    }
  })

  describe("the columns", () => {
    it("a row inserted without them takes 2 for both — every existing tenant behaves as before", async () => {
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const [row] = await db
        .insert(organizations)
        .values({ name: `OBT Raw ${suffix}`, code: `OBTR${suffix}` })
        .returning({
          id: organizations.id,
          unpaidInvoiceBlockThreshold: organizations.unpaidInvoiceBlockThreshold,
          unacknowledgedDeliveryBlockThreshold: organizations.unacknowledgedDeliveryBlockThreshold,
        })
      createdOrganizationIds.push(row.id)
      expect(row).toMatchObject({ unpaidInvoiceBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 2 })
    })

    it.each([1, 100])("the database accepts %i", async (value) => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: value, unacknowledgedDeliveryBlockThreshold: value })
      expect(await limitsOf(f.organizationId)).toEqual({ unpaidInvoiceBlockThreshold: value, unacknowledgedDeliveryBlockThreshold: value })
    })

    it.each([
      ["unpaidInvoiceBlockThreshold", 0],
      ["unpaidInvoiceBlockThreshold", 101],
      ["unpaidInvoiceBlockThreshold", -1],
      ["unacknowledgedDeliveryBlockThreshold", 0],
      ["unacknowledgedDeliveryBlockThreshold", 101],
    ] as const)("the CHECK refuses %s = %i from any writer, not only the API", async (field, value) => {
      expect(await sqlStateOf(configure(f.organizationId, { [field]: value }))).toBe("23514")
      expect((await limitsOf(f.organizationId))[field]).toBe(2)
    })

    it("NULL is refused", async () => {
      expect(await sqlStateOf(configure(f.organizationId, { unpaidInvoiceBlockThreshold: null as unknown as number }))).toBe("23502")
    })
  })

  describe("Super Admin sets the limits", () => {
    it("in Edit Company, each change audited with what it replaced, in its own action", async () => {
      signIn(superAdmin())
      const { status, body } = await patchOrganization(f.organizationId, {
        unpaidInvoiceBlockThreshold: 5,
        unacknowledgedDeliveryBlockThreshold: 7,
      })

      expect(status).toBe(200)
      expect(body.item).toMatchObject({ unpaidInvoiceBlockThreshold: 5, unacknowledgedDeliveryBlockThreshold: 7 })
      expect(await limitsOf(f.organizationId)).toEqual({ unpaidInvoiceBlockThreshold: 5, unacknowledgedDeliveryBlockThreshold: 7 })

      const [unpaid] = await auditsOf(f.organizationId, UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION)
      expect(unpaid).toMatchObject({ userId: f.superAdminId, entity: "organization", entityId: String(f.organizationId) })
      expect(unpaid.metadata).toEqual({ previousUnpaidInvoiceBlockThreshold: 2, unpaidInvoiceBlockThreshold: 5 })
      const [unacknowledged] = await auditsOf(f.organizationId, UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION)
      expect(unacknowledged.metadata).toEqual({ previousUnacknowledgedDeliveryBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 7 })
    })

    it("changing only one limit audits only that one, and leaves the other untouched", async () => {
      signIn(superAdmin())
      const unacknowledgedBefore = (await auditsOf(f.organizationId, UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION)).length
      expect((await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 9 })).status).toBe(200)

      expect(await limitsOf(f.organizationId)).toEqual({ unpaidInvoiceBlockThreshold: 9, unacknowledgedDeliveryBlockThreshold: 2 })
      expect(await auditsOf(f.organizationId, UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD_AUDIT_ACTION)).toHaveLength(unacknowledgedBefore)
    })

    it("saving the same limit again writes no second audit row", async () => {
      signIn(superAdmin())
      await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 4 })
      const before = (await auditsOf(f.organizationId, UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION)).length
      await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 4 })
      expect(await auditsOf(f.organizationId, UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION)).toHaveLength(before)
    })

    it("a limit change is not recorded as a toggle change", async () => {
      signIn(superAdmin())
      const toggleAuditsBefore = (await auditsOf(f.organizationId, UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION)).length
        + (await auditsOf(f.organizationId, UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION)).length
      await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 6, unacknowledgedDeliveryBlockThreshold: 6 })
      const toggleAuditsAfter = (await auditsOf(f.organizationId, UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION)).length
        + (await auditsOf(f.organizationId, UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION)).length
      expect(toggleAuditsAfter).toBe(toggleAuditsBefore)
    })

    it("a limit set while its block is off blocks nothing until the block is switched on", async () => {
      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 1 })).status).toBe(200)
      await invoice(f.alphaNorthId)
      expect((await paymentStatus(f.alphaNorthId)).state).toBe("NOT_CONFIGURED")
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it.each([0, -1, 101, 1.5, "3", null, true, {}])("%j is refused with 400 and nothing is written", async (value) => {
      signIn(superAdmin())
      for (const field of ["unpaidInvoiceBlockThreshold", "unacknowledgedDeliveryBlockThreshold"]) {
        const { status } = await patchOrganization(f.organizationId, { [field]: value })
        expect(status, field).toBe(400)
      }
      expect(await limitsOf(f.organizationId)).toEqual({ unpaidInvoiceBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 2 })
    })

    it("an invalid limit refuses the whole request — the valid fields sent with it are not applied either", async () => {
      signIn(superAdmin())
      const { status } = await patchOrganization(f.organizationId, { blockOrderingOnUnpaidInvoices: true, unpaidInvoiceBlockThreshold: 0 })
      expect(status).toBe(400)
      const [row] = await db.select({ enabled: organizations.blockOrderingOnUnpaidInvoices }).from(organizations).where(eq(organizations.id, f.organizationId))
      expect(row.enabled).toBe(false)
    })

    it("a PATCH refused inside its transaction changes no limit and audits nothing", async () => {
      // An issued invoice locks the organization code; the refusal comes after
      // the row lock and before the update, so the limit sent with it must not
      // land and must not be audited.
      await invoice(f.alphaNorthId)
      signIn(superAdmin())
      const before = (await auditsOf(f.organizationId, UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION)).length
      const { status } = await patchOrganization(f.organizationId, { code: `X${f.suffix.slice(0, 6).toUpperCase()}`, unpaidInvoiceBlockThreshold: 9 })

      expect(status).toBe(409)
      expect((await limitsOf(f.organizationId)).unpaidInvoiceBlockThreshold).toBe(2)
      expect(await auditsOf(f.organizationId, UNPAID_INVOICE_BLOCK_THRESHOLD_AUDIT_ACTION)).toHaveLength(before)
    })

    it.each([
      ["Head Office", () => headOffice()],
      ["a foreign Head Office", () => foreignHeadOffice()],
      ["Branch Admin", () => branchAdmin()],
      ["a group approver", () => approver()],
      ["a group requester", () => requester()],
      ["an Order Portal user", () => orderPortal()],
    ])("%s cannot change either limit — 403 and the columns are untouched", async (_label, actor) => {
      signIn(actor())
      const { status } = await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 50, unacknowledgedDeliveryBlockThreshold: 50 })
      expect(status).toBe(403)
      expect(await limitsOf(f.organizationId)).toEqual({ unpaidInvoiceBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 2 })
    })

    it("an unauthenticated caller gets 401", async () => {
      signIn(null)
      expect((await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 50 })).status).toBe(401)
      expect((await limitsOf(f.organizationId)).unpaidInvoiceBlockThreshold).toBe(2)
    })

    it("Create Company stores the chosen limits and records them in the creation audit", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status, body } = await createOrganization({
        name: `OBT Company ${suffix}`,
        code: `OBT${suffix}`,
        blockOrderingOnUnpaidInvoices: true,
        unpaidInvoiceBlockThreshold: 1,
        unacknowledgedDeliveryBlockThreshold: 100,
      })

      expect(status).toBe(201)
      expect(body.item).toMatchObject({ unpaidInvoiceBlockThreshold: 1, unacknowledgedDeliveryBlockThreshold: 100 })
      const [audit] = await auditsOf(body.item.id, "CREATE_ORGANIZATION")
      expect(audit.metadata).toMatchObject({ unpaidInvoiceBlockThreshold: 1, unacknowledgedDeliveryBlockThreshold: 100 })
    })

    it("Create Company without limits stores 2 for both", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const { status, body } = await createOrganization({ name: `OBT Default ${suffix}`, code: `OBTD${suffix}` })
      expect(status).toBe(201)
      expect(body.item).toMatchObject({ unpaidInvoiceBlockThreshold: 2, unacknowledgedDeliveryBlockThreshold: 2 })
    })

    it("Create Company with an invalid limit is refused and creates nothing", async () => {
      signIn(superAdmin())
      const suffix = f.suffix.slice(0, 8).toUpperCase()
      const code = `OBTX${suffix}`
      const { status } = await createOrganization({ name: `OBT Invalid ${suffix}`, code, unacknowledgedDeliveryBlockThreshold: 0 })
      expect(status).toBe(400)
      expect(await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.code, code))).toHaveLength(0)
    })

    it("Head Office cannot create an organization with limits", async () => {
      signIn(headOffice())
      const response = await organizationsRoute.POST(request("POST", "http://localhost/api/v1/organizations", {
        name: "Sneaky Limits", code: "SNEAKYLIM", unpaidInvoiceBlockThreshold: 100,
      }))
      expect(response.status).toBe(403)
    })
  })

  describe("the unpaid-invoice gate applies the organization's limit", () => {
    beforeEach(async () => {
      await configure(f.organizationId, { blockOrderingOnUnpaidInvoices: true })
    })

    it("at a limit of 3: two unpaid invoices only warn, the third refuses with the limit in the body", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 3 })
      await invoices(2, f.alphaNorthId)
      expect(await paymentStatus(f.alphaNorthId)).toMatchObject({ state: "WARNING", overdueCount: 2, threshold: 3, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      await invoice(f.alphaNorthId)
      const { status, body } = await orderFor(f.alphaNorthId)
      expect(status).toBe(409)
      expect(body).toMatchObject({
        code: "PAYMENT_CONTROL_BLOCKED",
        error: "You have 3 unpaid invoices. Please pay your dues before placing a new order.",
        paymentControl: { state: "BLOCKED", reason: "THRESHOLD_REACHED", overdueCount: 3, threshold: 3 },
      })
    })

    it("at a limit of 1: none orders, one refuses", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 1 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
      await invoice(f.alphaNorthId)
      const { status, body } = await orderFor(f.alphaNorthId)
      expect(status).toBe(409)
      expect(body.error).toBe("You have 1 unpaid invoice. Please pay your dues before placing a new order.")
    })

    it("refused orders write no row", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 1 })
      await invoice(f.alphaNorthId)
      const count = async () => (await db.select({ id: orders.id }).from(orders).where(eq(orders.branchId, f.alphaNorthId))).length
      const before = await count()
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
      expect(await count()).toBe(before)
    })

    it("raising the limit through Edit Company lifts a block at once; lowering it imposes one", async () => {
      await invoices(2, f.alphaNorthId)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 3 })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { unpaidInvoiceBlockThreshold: 2 })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it("above 20, the invoice list grows to the limit so the date it was reached is exact", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 25 })
      await invoices(24, f.alphaNorthId)
      expect(await paymentStatus(f.alphaNorthId)).toMatchObject({ state: "WARNING", overdueCount: 24, threshold: 25, blockedSince: null })

      await invoices(3, f.alphaNorthId)
      const result = await paymentStatus(f.alphaNorthId)
      expect(result).toMatchObject({ state: "BLOCKED", overdueCount: 27, threshold: 25, orderingAllowed: false })
      expect(result.overdueItems).toHaveLength(25)
      expect(result.blockedSince).toEqual(result.overdueItems[24].overdueSince)
      expect(result.blockedSince).not.toBeNull()
    })

    it("at or below 20, the list stays at 20 even when more are unpaid", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 3 })
      await invoices(22, f.alphaNorthId)
      const result = await paymentStatus(f.alphaNorthId)
      expect(result.overdueCount).toBe(22)
      expect(result.overdueItems).toHaveLength(20)
      expect(result.blockedSince).toEqual(result.overdueItems[2].overdueSince)
    })

    it("the status read reports the organization's limit", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 4 })
      await invoices(3, f.alphaNorthId)
      signIn(requester())
      const { status, body } = await read(await statusRoute.GET(request("GET", `http://localhost/api/v1/payment-control?branchId=${f.alphaNorthId}`)))
      expect(status).toBe(200)
      expect(body).toMatchObject({ state: "WARNING", overdueCount: 3, threshold: 4, orderingAllowed: true })
    })

    it("a group order is refused only at the branch over the limit", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 3 })
      await invoices(3, f.alphaNorthId)
      await invoices(2, f.alphaSouthId)

      const byBranch = await groupOrder([f.alphaNorthId, f.alphaSouthId])
      expect(byBranch.get(f.alphaNorthId)).toMatchObject({ status: "failed", code: "PAYMENT_CONTROL_BLOCKED", unpaidInvoiceCount: 3 })
      expect(byBranch.get(f.alphaSouthId)).toMatchObject({ status: "created" })
    })

    it("a Head Office exception still lets a branch past a custom limit", async () => {
      await configure(f.organizationId, { unpaidInvoiceBlockThreshold: 1 })
      await invoice(f.alphaNorthId)
      signIn(headOffice())
      const granted = await read(await grantRoute.POST(request(
        "POST",
        "http://localhost/api/v1/payment-control/exceptions",
        { branchId: f.alphaNorthId, reason: "Cheque in transit" },
      )))
      expect(granted.status).toBe(201)
      expect(granted.body).toMatchObject({ state: "BLOCKED", threshold: 1, exceptionActive: true, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })
  })

  describe("the unacknowledged-delivery gate applies the organization's limit", () => {
    beforeEach(async () => {
      await configure(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: true })
    })

    it("at a limit of 4: three deliveries order, the fourth refuses with the limit in the body", async () => {
      await configure(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 4 })
      await deliveries(3, f.alphaNorthId)
      expect(await deliveryStatus(f.alphaNorthId)).toEqual({ enabled: true, orderingAllowed: true, unacknowledgedCount: 3, threshold: 4 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      await delivery(f.alphaNorthId)
      const { status, body } = await orderFor(f.alphaNorthId)
      expect(status).toBe(409)
      expect(body).toMatchObject({
        code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED",
        deliveryAcknowledgement: { code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedCount: 4, threshold: 4 },
      })
    })

    it("at a limit of 1: a single delivery refuses", async () => {
      await configure(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 1 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
      await delivery(f.alphaNorthId)
      const { status, body } = await orderFor(f.alphaNorthId)
      expect(status).toBe(409)
      expect(body.error).toBe(
        "Your branch has 1 delivered order awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order.",
      )
    })

    it("at a limit of 100: ninety-nine do not block", async () => {
      await configure(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 100 })
      await deliveries(99, f.alphaNorthId)
      expect(await deliveryStatus(f.alphaNorthId)).toMatchObject({ orderingAllowed: true, unacknowledgedCount: 99, threshold: 100 })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
      await delivery(f.alphaNorthId)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it("raising the limit through Edit Company lifts a block at once; lowering it imposes one", async () => {
      await deliveries(2, f.alphaNorthId)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 5 })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      signIn(superAdmin())
      expect((await patchOrganization(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 1 })).status).toBe(200)
      expect((await orderFor(f.alphaNorthId)).status).toBe(409)
    })

    it("the pre-check reports the organization's limit", async () => {
      await configure(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 3 })
      await deliveries(3, f.alphaNorthId)
      signIn(headOffice())
      const { status, body } = await read(await preCheckRoute.GET(request(
        "GET",
        `http://localhost/api/v1/orders/delivery-acknowledgement?branchId=${f.alphaNorthId}`,
      )))
      expect(status).toBe(200)
      expect(body).toEqual({ branchId: f.alphaNorthId, enabled: true, orderingAllowed: false, unacknowledgedCount: 3, threshold: 3 })
    })

    it("a group order is refused only at the branch over the limit", async () => {
      await configure(f.organizationId, { unacknowledgedDeliveryBlockThreshold: 3 })
      await deliveries(3, f.alphaNorthId)
      await deliveries(2, f.alphaSouthId)

      const byBranch = await groupOrder([f.alphaNorthId, f.alphaSouthId])
      expect(byBranch.get(f.alphaNorthId)).toMatchObject({ status: "failed", code: "UNACKNOWLEDGED_DELIVERIES_BLOCKED", unacknowledgedDeliveryCount: 3 })
      expect(byBranch.get(f.alphaSouthId)).toMatchObject({ status: "created" })
    })

    it("with the block off, a limit of 1 blocks nothing", async () => {
      await configure(f.organizationId, { blockOrderingOnUnacknowledgedDeliveries: false, unacknowledgedDeliveryBlockThreshold: 1 })
      await deliveries(5, f.alphaNorthId)
      expect(await deliveryStatus(f.alphaNorthId)).toMatchObject({ enabled: false, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)
    })
  })

  describe("the two limits are independent", () => {
    it("each gate reads only its own limit", async () => {
      await configure(f.organizationId, {
        blockOrderingOnUnpaidInvoices: true,
        blockOrderingOnUnacknowledgedDeliveries: true,
        unpaidInvoiceBlockThreshold: 5,
        unacknowledgedDeliveryBlockThreshold: 1,
      })
      await invoices(4, f.alphaNorthId)
      expect((await paymentStatus(f.alphaNorthId)).orderingAllowed).toBe(true)
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      await delivery(f.alphaNorthId)
      const { status, body } = await orderFor(f.alphaNorthId)
      expect(status).toBe(409)
      expect(body.code).toBe("UNACKNOWLEDGED_DELIVERIES_BLOCKED")
    })

    it("with both over their limits, the unpaid-invoice refusal still wins", async () => {
      await configure(f.organizationId, {
        blockOrderingOnUnpaidInvoices: true,
        blockOrderingOnUnacknowledgedDeliveries: true,
        unpaidInvoiceBlockThreshold: 1,
        unacknowledgedDeliveryBlockThreshold: 1,
      })
      await invoice(f.alphaNorthId)
      await delivery(f.alphaNorthId)
      expect((await orderFor(f.alphaNorthId)).body.code).toBe("PAYMENT_CONTROL_BLOCKED")
    })
  })

  describe("tenant isolation", () => {
    it("one organization's limit never applies to another's branches", async () => {
      for (const organizationId of [f.organizationId, f.foreignOrganizationId]) {
        await configure(organizationId, { blockOrderingOnUnpaidInvoices: true, blockOrderingOnUnacknowledgedDeliveries: true })
      }
      await configure(f.foreignOrganizationId, { unpaidInvoiceBlockThreshold: 1, unacknowledgedDeliveryBlockThreshold: 1 })

      await invoice(f.alphaNorthId)
      await delivery(f.alphaNorthId)
      await invoice(f.foreignBranchId, f.foreignOrganizationId)
      await delivery(f.foreignBranchId, f.foreignOrganizationId)

      expect(await paymentStatus(f.alphaNorthId)).toMatchObject({ threshold: 2, orderingAllowed: true })
      expect(await deliveryStatus(f.alphaNorthId)).toMatchObject({ threshold: 2, orderingAllowed: true })
      expect((await orderFor(f.alphaNorthId)).status).toBe(200)

      expect(await paymentStatus(f.foreignBranchId, f.foreignOrganizationId)).toMatchObject({ threshold: 1, orderingAllowed: false })
      expect(await deliveryStatus(f.foreignBranchId, f.foreignOrganizationId)).toMatchObject({ threshold: 1, orderingAllowed: false })
    })

    it("Super Admin changing one organization's limit leaves the other's alone", async () => {
      signIn(superAdmin())
      expect((await patchOrganization(f.foreignOrganizationId, { unpaidInvoiceBlockThreshold: 8 })).status).toBe(200)
      expect((await limitsOf(f.organizationId)).unpaidInvoiceBlockThreshold).toBe(2)
      expect((await limitsOf(f.foreignOrganizationId)).unpaidInvoiceBlockThreshold).toBe(8)
    })
  })
})
