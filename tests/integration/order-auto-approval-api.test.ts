import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray } from "drizzle-orm"

import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import {
  auditLogs,
  branchInventory,
  emailOutbox,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  invoiceSequences,
  notifications,
  orderItems,
  orders,
  organizationInventory,
  organizations,
} from "@/db/schema"
import { verifyApprovalToken } from "@/lib/approval-token"
import { closePool, db } from "@/lib/db"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * The organization's "Require order approval" switch, end to end: the real
 * organization PATCH route flips it, and the real single-branch and group
 * order routes create orders under it against Postgres. Only the session,
 * request headers, rate limiter, cache and outbound email are faked; the
 * notification rows are the real ones the routes write.
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
vi.mock("@/lib/server/order-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/order-notifications")>()
  return { ...actual, attemptImmediateOrderEmailDelivery: vi.fn(async () => undefined) }
})

const { getServerSession } = mockedNextAuth
const { PATCH: patchOrganization } = organizationRoute
const { POST: createOrder } = ordersRoute
const { POST: createGroupOrder } = groupOrdersRoute

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { ...actor, mustChangePassword: false } } as any)
}

const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
})

let idempotencyCounter = 0
const idempotencyKey = () => `aa-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`

describe.skipIf(!hasTestDatabase)("organization order approval policy through the API", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  let orderBeforeOptOut: number

  const superAdmin = (): Actor => ({ id: f.superAdminId, email: `sa-${f.suffix}@example.test`, role: "SUPER_ADMIN", organizationId: null })
  const headOffice = (): Actor => ({ id: f.headOfficeId, email: `head-${f.suffix}@example.test`, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })

  const setPolicy = (organizationId: number, body: unknown) => patchOrganization(
    json(`http://localhost/api/v1/organizations/${organizationId}`, "PATCH", body),
    { params: Promise.resolve({ id: String(organizationId) }) },
  )

  const storedPolicy = async (organizationId: number) => {
    const [row] = await db
      .select({ orderApprovalRequired: organizations.orderApprovalRequired })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
    return row.orderApprovalRequired
  }

  const placeOrder = async () => {
    const response = await createOrder(json(
      "http://localhost/api/v1/orders",
      "POST",
      { branchId: f.alphaNorthId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    return { status: response.status, body: await response.json() }
  }

  const placeGroupOrder = async () => {
    const response = await createGroupOrder(json(
      "http://localhost/api/v1/group-portal/orders",
      "POST",
      { groupId: f.alphaGroupId, entries: [{ branchIds: [f.alphaNorthId], items: [{ organizationInventoryId: inventoryId, quantity: 1 }] }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    return { status: response.status, body: await response.json() }
  }

  const storedOrder = async (orderId: number) => {
    const [row] = await db
      .select({
        status: orders.status,
        approvedAt: orders.approvedAt,
        approvedByUserId: orders.approvedByUserId,
        approvalToken: orders.approvalToken,
        approvalTokenHash: orders.approvalTokenHash,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
    return row
  }

  const notificationTypesFor = async (orderId: number) => {
    const rows = await db
      .select({ type: notifications.type, userId: notifications.userId, message: notifications.message })
      .from(notifications)
      .where(eq(notifications.orderId, orderId))
    return rows
  }

  const expectFulfillmentReady = async (orderId: number) => {
    const row = await storedOrder(orderId)
    expect(row.status).toBe("APPROVED")
    expect(row.approvedAt).toBeInstanceOf(Date)
    // Nobody approved it; the policy did.
    expect(row.approvedByUserId).toBeNull()
    expect(row.approvalToken).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
    expect(await verifyApprovalToken(row.approvalToken!, row.approvalTokenHash!)).toBe(true)

    const events = await notificationTypesFor(orderId)
    expect(events.some((event) => event.type === "ORDER_CREATED")).toBe(false)
    const superAdminEvent = events.find((event) =>
      event.type === "ORDER_APPROVED_ADMIN" && event.userId === f.superAdminId)
    expect(superAdminEvent?.message).toContain("approved automatically")
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    const [item] = await db
      .insert(organizationInventory)
      .values({ organizationId: f.organizationId, globalProductId: f.productId, assignedByUserId: f.headOfficeId, isActive: true })
      .returning({ id: organizationInventory.id })
    inventoryId = item.id
    await db.insert(branchInventory).values({
      branchId: f.alphaNorthId,
      organizationId: f.organizationId,
      organizationInventoryId: inventoryId,
      assignedByUserId: f.headOfficeId,
    })
    await db.update(globalProducts).set({ stockQuantity: 1_000 }).where(eq(globalProducts.id, f.productId))
  })

  afterAll(async () => {
    if (!f) return
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(inArray(groupOrders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(branchInventory).where(eq(branchInventory.organizationInventoryId, inventoryId))
    await db.delete(organizationInventory).where(eq(organizationInventory.id, inventoryId))
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  it("a new tenant requires approval, so an order starts PENDING and asks its approver", async () => {
    expect(await storedPolicy(f.organizationId)).toBe(true)

    signIn(headOffice())
    const { status, body } = await placeOrder()

    expect(status).toBe(200)
    expect(body.order.status).toBe("PENDING")
    orderBeforeOptOut = body.order.id
    const row = await storedOrder(orderBeforeOptOut)
    expect(row.approvalTokenHash).toBeNull()
    expect((await notificationTypesFor(orderBeforeOptOut)).some((event) => event.type === "ORDER_APPROVED_ADMIN")).toBe(false)
  })

  it("Head Office cannot change the policy", async () => {
    signIn(headOffice())
    const response = await setPolicy(f.organizationId, { orderApprovalRequired: false })

    expect(response.status).toBe(403)
    expect(await storedPolicy(f.organizationId)).toBe(true)
  })

  it("rejects a non-boolean policy value", async () => {
    signIn(superAdmin())
    const response = await setPolicy(f.organizationId, { orderApprovalRequired: "false" })

    expect(response.status).toBe(400)
    expect(await storedPolicy(f.organizationId)).toBe(true)
  })

  it("Super Admin turns approval off for one tenant only, and the change is audited", async () => {
    signIn(superAdmin())
    const response = await setPolicy(f.organizationId, { orderApprovalRequired: false })

    expect(response.status).toBe(200)
    expect(await storedPolicy(f.organizationId)).toBe(false)
    expect(await storedPolicy(f.foreignOrganizationId)).toBe(true)

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(
        eq(auditLogs.organizationId, f.organizationId),
        eq(auditLogs.action, "UPDATE_ORDER_APPROVAL_POLICY"),
      ))
    expect(audit.userId).toBe(f.superAdminId)
    expect(audit.metadata).toEqual({ previousOrderApprovalRequired: true, orderApprovalRequired: false })
  })

  it("leaves an order that was already pending exactly as it was", async () => {
    expect((await storedOrder(orderBeforeOptOut)).status).toBe("PENDING")
  })

  it("approves a single-branch order at creation and hands the raiser no token hash", async () => {
    signIn(headOffice())
    const { status, body } = await placeOrder()

    expect(status).toBe(200)
    expect(body.order.status).toBe("APPROVED")
    expect(body.order).not.toHaveProperty("approvalTokenHash")
    await expectFulfillmentReady(body.order.id)
  })

  it("approves every branch order of a group submission at creation", async () => {
    signIn(requester())
    const { status, body } = await placeGroupOrder()

    expect(status).toBe(201)
    const [result] = body.item.results
    expect(result).toMatchObject({ branchId: f.alphaNorthId, status: "created" })
    await expectFulfillmentReady(result.orderId)
  })

  it("turning approval back on restores the pending workflow for new orders", async () => {
    signIn(superAdmin())
    expect((await setPolicy(f.organizationId, { orderApprovalRequired: true })).status).toBe(200)

    signIn(headOffice())
    const { body } = await placeOrder()

    expect(body.order.status).toBe("PENDING")
    expect((await storedOrder(body.order.id)).approvalTokenHash).toBeNull()
  })
})
