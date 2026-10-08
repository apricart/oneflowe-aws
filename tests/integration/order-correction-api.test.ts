import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as ordersRoute from "@/app/api/v1/orders/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as approveRoute from "@/app/api/v1/orders/[id]/approve/route"
import * as rejectRoute from "@/app/api/v1/orders/[id]/reject/route"
import * as returnRoute from "@/app/api/v1/orders/[id]/return-for-correction/route"
import * as resubmitRoute from "@/app/api/v1/orders/[id]/resubmit/route"
import * as notificationsRoute from "@/app/api/v1/notifications/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import {
  auditLogs,
  branchInventory,
  branches,
  budgets,
  emailOutbox,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  groups,
  invoiceSequences,
  notifications,
  orderCorrectionRequests,
  orderItems,
  orders,
  organizationInventory,
  organizationSettings,
  organizations,
  roles,
  systemLogs,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { closePool, db } from "@/lib/db"
import { approveOrder } from "@/lib/server/order-decision-service"
import { returnOrderForCorrection } from "@/lib/server/order-correction"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Returning an order for correction and resubmitting it, end to end, against
 * Postgres. See plans/OF-ORDER-RETURN-for-correction.md.
 *
 * Only identity, request headers, the rate limiter, the cache and outbound
 * email are faked. Every route is the real handler; every assertion about
 * money reads the `budgets` table and every assertion about stock reads
 * `global_products`.
 *
 * ```text
 * Tenant T (approver role BRANCH_ADMIN)        Tenant F (foreign)
 *   group G ── branch A                          branch F
 *   group H ── branch B
 *   unit price 500, stock 1,000, budget 100,000 per branch this month
 * ```
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

const UNIT_PRICE = 500
const STOCK = 1_000
const ALLOCATED = 100_000
const PERIOD = budgetPeriodOf(new Date())

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
  branchId: number | null
}

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
}

const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
})

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

let idempotencyCounter = 0
const idempotencyKey = () => `oc-it-${Date.now().toString(36)}-${(idempotencyCounter += 1)}`

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by order correction integration tests" })
    .returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("returning an order for correction through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}

  let orgId: number
  let foreignOrgId: number
  let branchA: number
  let branchB: number
  let branchF: number
  let groupG: number
  let groupH: number
  let productId: number
  let inventoryT: number
  let inventoryF: number

  // ── helpers ──────────────────────────────────────────────────────────────

  const placeOrder = async (actor: Actor, quantity: number) => {
    signIn(actor)
    const inventoryId = actor.organizationId === foreignOrgId ? inventoryF : inventoryT
    const { status, body } = await read(await ordersRoute.POST(json(
      "http://localhost/api/v1/orders",
      "POST",
      { items: [{ organizationInventoryId: inventoryId, quantity }] },
      { "Idempotency-Key": idempotencyKey() },
    )))
    expect(status).toBe(200)
    return body.order.id as number
  }

  const returnOrder = async (actor: Actor | null, orderId: number | string, body: unknown = { comment: "Please reduce the quantity" }) => {
    signIn(actor)
    return read(await returnRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/return-for-correction`, "POST", body),
      params(orderId),
    ))
  }

  const resubmit = async (actor: Actor | null, orderId: number | string, body?: unknown) => {
    signIn(actor)
    return read(await resubmitRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/resubmit`, "POST", body),
      params(orderId),
    ))
  }

  const approve = async (actor: Actor, orderId: number) => {
    signIn(actor)
    return read(await approveRoute.POST(json(`http://localhost/api/v1/orders/${orderId}/approve`, "POST"), params(orderId)))
  }

  const reject = async (actor: Actor, orderId: number) => {
    signIn(actor)
    return read(await rejectRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/reject`, "POST", { reason: "Not needed" }),
      params(orderId),
    ))
  }

  const edit = async (actor: Actor, orderId: number, quantity: number) => {
    signIn(actor)
    return read(await orderRoute.PUT(
      json(`http://localhost/api/v1/orders/${orderId}`, "PUT", { items: [{ organizationInventoryId: inventoryT, quantity }] }),
      params(orderId),
    ))
  }

  const detail = async (actor: Actor, orderId: number) => {
    signIn(actor)
    return read(await orderRoute.GET(json(`http://localhost/api/v1/orders/${orderId}`, "GET"), params(orderId)))
  }

  const storedOrder = async (orderId: number) => {
    const [row] = await db.select({
      status: orders.status,
      totalCents: orders.totalCents,
      returnedForCorrectionAt: orders.returnedForCorrectionAt,
      returnedForCorrectionByUserId: orders.returnedForCorrectionByUserId,
      correctionRequestNote: orders.correctionRequestNote,
    }).from(orders).where(eq(orders.id, orderId))
    return row
  }

  const rounds = (orderId: number) => db.select().from(orderCorrectionRequests)
    .where(eq(orderCorrectionRequests.orderId, orderId))
    .orderBy(orderCorrectionRequests.id)

  const ledger = async (branchId: number) => {
    const [row] = await db.select({ held: budgets.amountHeldCents, spent: budgets.amountSpentCents })
      .from(budgets).where(and(eq(budgets.branchId, branchId), eq(budgets.period, PERIOD)))
    return row
  }

  const stock = async () => {
    const [row] = await db.select({ stock: globalProducts.stockQuantity }).from(globalProducts)
      .where(eq(globalProducts.id, productId))
    return Number(row.stock)
  }

  const noticesFor = (userId: string, orderId: number, type: string) => db
    .select({ eventKey: notifications.eventKey, targetRole: notifications.targetRole, message: notifications.message })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.orderId, orderId), eq(notifications.type, type)))
    .orderBy(notifications.id)

  const auditFor = (orderId: number, action: string) => db
    .select({ userId: auditLogs.userId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.entity, "order"), eq(auditLogs.entityId, String(orderId)), eq(auditLogs.action, action)))
    .orderBy(auditLogs.id)

  // ── fixtures ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const roleIds = {
      superAdmin: await resolveRoleId("SUPER_ADMIN"),
      headOffice: await resolveRoleId("HEAD_OFFICE"),
      branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
      groupUser: await resolveRoleId("GROUP_USER"),
      orderPortal: await resolveRoleId("ORDER_PORTAL"),
      groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
    }

    const [org] = await db.insert(organizations)
      .values({ name: `IT OC ${suffix}`, code: `ITOC_${suffix}` })
      .returning({ id: organizations.id })
    const [foreign] = await db.insert(organizations)
      .values({ name: `IT OC Foreign ${suffix}`, code: `ITOCF_${suffix}` })
      .returning({ id: organizations.id })
    orgId = org.id
    foreignOrgId = foreign.id

    const person = async (label: string, roleId: number, organizationId: number | null, branchId: number | null) => {
      const [row] = await db.insert(users).values({
        email: `it-oc-${label}-${suffix}@example.test`, username: `it-oc-${label}-${suffix}`, passwordHash: "x",
        roleId, organizationId, branchId, fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      return row.id
    }
    const actor = (id: string, label: string, role: string, organizationId: number | null, branchId: number | null): Actor =>
      ({ id, email: `it-oc-${label}-${suffix}@example.test`, role, organizationId, branchId })

    actors.headOffice = actor(await person("ho", roleIds.headOffice, orgId, null), "ho", "HEAD_OFFICE", orgId, null)

    const [g, h] = await db.insert(groups).values([
      { organizationId: orgId, name: `IT OC G ${suffix}`, createdByUserId: actors.headOffice.id },
      { organizationId: orgId, name: `IT OC H ${suffix}`, createdByUserId: actors.headOffice.id },
    ]).returning({ id: groups.id })
    groupG = g.id
    groupH = h.id

    const [a, b, f] = await db.insert(branches).values([
      { organizationId: orgId, name: `IT OC A ${suffix}`, groupId: groupG },
      { organizationId: orgId, name: `IT OC B ${suffix}`, groupId: groupH },
      { organizationId: foreignOrgId, name: `IT OC F ${suffix}` },
    ]).returning({ id: branches.id })
    branchA = a.id
    branchB = b.id
    branchF = f.id

    actors.superAdmin = actor(await person("sa", roleIds.superAdmin, null, null), "sa", "SUPER_ADMIN", null, null)
    actors.branchAdminA = actor(await person("ba-a", roleIds.branchAdmin, orgId, branchA), "ba-a", "BRANCH_ADMIN", orgId, branchA)
    actors.branchAdminB = actor(await person("ba-b", roleIds.branchAdmin, orgId, branchB), "ba-b", "BRANCH_ADMIN", orgId, branchB)
    actors.branchAdminF = actor(await person("ba-f", roleIds.branchAdmin, foreignOrgId, branchF), "ba-f", "BRANCH_ADMIN", foreignOrgId, branchF)
    actors.groupUserG = actor(await person("gu-g", roleIds.groupUser, orgId, null), "gu-g", "GROUP_USER", orgId, null)
    actors.groupUserH = actor(await person("gu-h", roleIds.groupUser, orgId, null), "gu-h", "GROUP_USER", orgId, null)
    actors.orderPortalA = actor(await person("op-a", roleIds.orderPortal, orgId, branchA), "op-a", "ORDER_PORTAL", orgId, branchA)
    actors.colleagueA = actor(await person("op-a2", roleIds.orderPortal, orgId, branchA), "op-a2", "ORDER_PORTAL", orgId, branchA)
    actors.orderPortalB = actor(await person("op-b", roleIds.orderPortal, orgId, branchB), "op-b", "ORDER_PORTAL", orgId, branchB)
    actors.orderPortalF = actor(await person("op-f", roleIds.orderPortal, foreignOrgId, branchF), "op-f", "ORDER_PORTAL", foreignOrgId, branchF)
    actors.groupPortalG = actor(await person("gop-g", roleIds.groupOrderPortal, orgId, null), "gop-g", "GROUP_ORDER_PORTAL", orgId, null)
    actors.groupPortalH = actor(await person("gop-h", roleIds.groupOrderPortal, orgId, null), "gop-h", "GROUP_ORDER_PORTAL", orgId, null)

    await db.insert(userGroupAssignments).values([
      { userId: actors.groupUserG.id, groupId: groupG, organizationId: orgId, createdByUserId: actors.headOffice.id },
      { userId: actors.groupUserH.id, groupId: groupH, organizationId: orgId, createdByUserId: actors.headOffice.id },
      { userId: actors.groupPortalG.id, groupId: groupG, organizationId: orgId, createdByUserId: actors.headOffice.id },
      { userId: actors.groupPortalH.id, groupId: groupH, organizationId: orgId, createdByUserId: actors.headOffice.id },
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: `ITOC-${suffix}`, name: `IT Order Correction Product ${suffix}`, basePrice: UNIT_PRICE,
      status: "active", unit: "pc", stockQuantity: STOCK,
    }).returning({ id: globalProducts.id })
    productId = product.id

    const [inT] = await db.insert(organizationInventory)
      .values({ organizationId: orgId, globalProductId: productId, assignedByUserId: actors.headOffice.id, isActive: true })
      .returning({ id: organizationInventory.id })
    const [inF] = await db.insert(organizationInventory)
      .values({ organizationId: foreignOrgId, globalProductId: productId, assignedByUserId: actors.superAdmin.id, isActive: true })
      .returning({ id: organizationInventory.id })
    inventoryT = inT.id
    inventoryF = inF.id
    await db.insert(branchInventory).values([
      { branchId: branchA, organizationId: orgId, organizationInventoryId: inventoryT, assignedByUserId: actors.headOffice.id },
      { branchId: branchB, organizationId: orgId, organizationInventoryId: inventoryT, assignedByUserId: actors.headOffice.id },
      { branchId: branchF, organizationId: foreignOrgId, organizationInventoryId: inventoryF, assignedByUserId: actors.superAdmin.id },
    ])

    await db.insert(budgets).values([branchA, branchB].map((branchId) => ({
      organizationId: orgId, branchId, period: PERIOD,
      amountAllocatedCents: ALLOCATED, amountSpentCents: 0, amountHeldCents: 0, amountCreditedCents: 0,
    })).concat([{
      organizationId: foreignOrgId, branchId: branchF, period: PERIOD,
      amountAllocatedCents: ALLOCATED, amountSpentCents: 0, amountHeldCents: 0, amountCreditedCents: 0,
    }]))
  })

  afterAll(async () => {
    if (!orgId) return
    const organizationIds = [orgId, foreignOrgId]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderCorrectionRequests).where(inArray(orderCorrectionRequests.organizationId, organizationIds))
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(inArray(groupOrders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
    await db.delete(branchInventory).where(inArray(branchInventory.organizationId, organizationIds))
    await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, organizationIds))
    await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.organizationId, organizationIds))
    await db.update(branches).set({ groupId: null }).where(inArray(branches.organizationId, organizationIds))
    await db.delete(groups).where(inArray(groups.id, [groupG, groupH]))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(globalProducts).where(eq(globalProducts.id, productId))
    await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  // ── the full cycle ────────────────────────────────────────────────────────

  describe("a full correction cycle", () => {
    let orderId: number
    let heldBefore: number
    let stockBefore: number

    it("returns a pending order without moving money or stock", async () => {
      orderId = await placeOrder(actors.orderPortalA, 4)
      heldBefore = (await ledger(branchA)).held
      stockBefore = await stock()

      const { status, body } = await returnOrder(actors.branchAdminA, orderId, { comment: "  Only 2 units, please  " })

      expect(status).toBe(200)
      expect(body.order.status).toBe("PENDING")
      const stored = await storedOrder(orderId)
      expect(stored.status).toBe("PENDING")
      expect(stored.returnedForCorrectionAt).toBeInstanceOf(Date)
      expect(stored.returnedForCorrectionByUserId).toBe(actors.branchAdminA.id)
      expect(stored.correctionRequestNote).toBe("Only 2 units, please")
      expect((await ledger(branchA)).held).toBe(heldBefore)
      expect(await stock()).toBe(stockBefore)

      const [round] = await rounds(orderId)
      expect(round).toMatchObject({
        requestedByUserId: actors.branchAdminA.id,
        requestedByRole: "BRANCH_ADMIN",
        comment: "Only 2 units, please",
        resolution: null,
      })
    })

    it("tells the raiser, by notification and email, and audits the return", async () => {
      const [round] = await rounds(orderId)
      const notices = await noticesFor(actors.orderPortalA.id, orderId, "ORDER_RETURNED")
      expect(notices).toEqual([expect.objectContaining({
        eventKey: `ORDER_RETURNED:${orderId}:r${round.id}:${actors.orderPortalA.id}`,
        targetRole: "ORDER_PORTAL",
      })])
      expect(notices[0].message).toContain("Only 2 units, please")

      const [mail] = await db.select({ template: emailOutbox.template, payload: emailOutbox.payload })
        .from(emailOutbox).where(eq(emailOutbox.eventKey, notices[0].eventKey!))
      expect(mail.template).toBe("ORDER_RETURNED")
      expect(mail.payload).toMatchObject({ correctionComment: "Only 2 units, please" })

      const [audit] = await auditFor(orderId, "ORDER_RETURNED_FOR_CORRECTION")
      expect(audit.userId).toBe(actors.branchAdminA.id)
      expect(audit.metadata).toMatchObject({ correctionRequestId: round.id, comment: "Only 2 units, please" })
    })

    it("refuses to approve or to return it again while it is with the requester", async () => {
      const approval = await approve(actors.branchAdminA, orderId)
      expect(approval.status).toBe(409)
      expect(approval.body.error).toMatch(/returned for correction/)
      expect((await storedOrder(orderId)).status).toBe("PENDING")

      const again = await returnOrder(actors.branchAdminA, orderId)
      expect(again.status).toBe(409)
      expect(await rounds(orderId)).toHaveLength(1)
    })

    it("lets the raiser correct it with the ordinary edit, moving the hold by the difference", async () => {
      const edited = await edit(actors.orderPortalA, orderId, 2)
      expect(edited.status).toBe(200)

      expect((await ledger(branchA)).held).toBe(heldBefore - 2 * UNIT_PRICE)
      expect(await stock()).toBe(stockBefore + 2)
      // Still with the requester until they say otherwise.
      expect((await storedOrder(orderId)).returnedForCorrectionAt).not.toBeNull()
    })

    it("shows the request to the raiser and to the approver", async () => {
      for (const viewer of [actors.orderPortalA, actors.branchAdminA]) {
        const { status, body } = await detail(viewer, orderId)
        expect(status).toBe(200)
        expect(body.item.correctionRequestNote).toBe("Only 2 units, please")
        expect(body.item.correctionHistory).toEqual([expect.objectContaining({
          comment: "Only 2 units, please",
          requestedByRole: "BRANCH_ADMIN",
          resolution: null,
        })])
      }
      const { body } = await detail(actors.branchAdminA, orderId)
      expect(body.capabilities.canReturnOrders).toBe(true)
    })

    it("resubmits the same order, closing the round and telling the approver", async () => {
      const { status } = await resubmit(actors.orderPortalA, orderId, { note: "Reduced to 2" })
      expect(status).toBe(200)

      const stored = await storedOrder(orderId)
      expect(stored).toMatchObject({
        status: "PENDING",
        returnedForCorrectionAt: null,
        returnedForCorrectionByUserId: null,
        correctionRequestNote: null,
      })
      const [round] = await rounds(orderId)
      expect(round).toMatchObject({
        resolution: "RESUBMITTED",
        resolvedByUserId: actors.orderPortalA.id,
        resolvedByRole: "ORDER_PORTAL",
        responseNote: "Reduced to 2",
      })
      expect(await noticesFor(actors.branchAdminA.id, orderId, "ORDER_RESUBMITTED")).toEqual([
        expect.objectContaining({ eventKey: `ORDER_RESUBMITTED:${orderId}:r${round.id}:${actors.branchAdminA.id}` }),
      ])
      const [audit] = await auditFor(orderId, "ORDER_RESUBMITTED")
      expect(audit.metadata).toMatchObject({ note: "Reduced to 2", crossRequesterWrite: false, onBehalfOfUserId: null })
    })

    it("refuses a second resubmission of an order that is no longer returned", async () => {
      const { status } = await resubmit(actors.orderPortalA, orderId)
      expect(status).toBe(409)
    })

    it("goes round again with its own notices, then approves", async () => {
      expect((await returnOrder(actors.branchAdminA, orderId, { comment: "Add a PO number" })).status).toBe(200)
      // An empty body is a resubmission with no note.
      signIn(actors.orderPortalA)
      const bare = await resubmitRoute.POST(
        new NextRequest(`http://localhost/api/v1/orders/${orderId}/resubmit`, { method: "POST" }),
        params(orderId),
      )
      expect(bare.status).toBe(200)

      const all = await rounds(orderId)
      expect(all.map((round) => [round.comment, round.resolution, round.responseNote])).toEqual([
        ["Only 2 units, please", "RESUBMITTED", "Reduced to 2"],
        ["Add a PO number", "RESUBMITTED", null],
      ])
      // One notice per round, never collapsed into the first.
      expect(await noticesFor(actors.orderPortalA.id, orderId, "ORDER_RETURNED")).toHaveLength(2)
      expect(await noticesFor(actors.branchAdminA.id, orderId, "ORDER_RESUBMITTED")).toHaveLength(2)

      const approval = await approve(actors.branchAdminA, orderId)
      expect(approval.status).toBe(200)
      expect((await storedOrder(orderId)).status).toBe("APPROVED")

      const { body } = await detail(actors.branchAdminA, orderId)
      expect(body.item.correctionHistory).toHaveLength(2)
      expect((await returnOrder(actors.branchAdminA, orderId)).status).toBe(409)
    })
  })

  describe("rejecting a returned order", () => {
    it("closes the open round and releases the hold exactly once", async () => {
      const heldBefore = (await ledger(branchA)).held
      const stockBefore = await stock()
      const orderId = await placeOrder(actors.orderPortalA, 3)
      expect((await returnOrder(actors.branchAdminA, orderId)).status).toBe(200)

      const { status } = await reject(actors.branchAdminA, orderId)

      expect(status).toBe(200)
      expect(await storedOrder(orderId)).toMatchObject({
        status: "REJECTED",
        returnedForCorrectionAt: null,
        correctionRequestNote: null,
      })
      const [round] = await rounds(orderId)
      expect(round).toMatchObject({ resolution: "REJECTED", resolvedByUserId: actors.branchAdminA.id, responseNote: null })
      expect((await ledger(branchA)).held).toBe(heldBefore)
      expect(await stock()).toBe(stockBefore)
      expect((await resubmit(actors.orderPortalA, orderId)).status).toBe(409)
    })
  })

  // ── who may ───────────────────────────────────────────────────────────────

  describe("authorization and tenant isolation", () => {
    let orderId: number

    beforeAll(async () => {
      orderId = await placeOrder(actors.orderPortalA, 1)
    })

    it("refuses an unauthenticated caller on both routes", async () => {
      expect((await returnOrder(null, orderId)).status).toBe(401)
      expect((await resubmit(null, orderId)).status).toBe(401)
    })

    it("refuses the wrong role on each route", async () => {
      expect((await returnOrder(actors.orderPortalA, orderId)).status).toBe(403)
      expect((await returnOrder(actors.groupPortalG, orderId)).status).toBe(403)
      expect((await returnOrder(actors.superAdmin, orderId)).status).toBe(403)
      expect((await resubmit(actors.branchAdminA, orderId)).status).toBe(403)
      expect((await resubmit(actors.groupUserG, orderId)).status).toBe(403)
    })

    it("refuses an approver who may not decide this order", async () => {
      // Head Office is not this tenant's configured approver.
      expect((await returnOrder(actors.headOffice, orderId)).status).toBe(403)
      // Another branch's admin, and another tenant's.
      expect((await returnOrder(actors.branchAdminB, orderId)).status).toBe(403)
      expect((await returnOrder(actors.branchAdminF, orderId)).status).toBe(403)
      // A Group User whose assignments do not cover branch A.
      expect((await returnOrder(actors.groupUserH, orderId)).status).toBe(403)
      expect(await rounds(orderId)).toHaveLength(0)
    })

    it("lets a Group User return an order at a branch it covers", async () => {
      const { status } = await returnOrder(actors.groupUserG, orderId, { comment: "Wrong product" })
      expect(status).toBe(200)
      const [round] = await rounds(orderId)
      expect(round.requestedByRole).toBe("GROUP_USER")
    })

    it("hides the order from a requester outside its branch, as the edit does", async () => {
      expect((await resubmit(actors.orderPortalB, orderId)).status).toBe(404)
      expect((await resubmit(actors.orderPortalF, orderId)).status).toBe(404)
      expect((await resubmit(actors.groupPortalH, orderId)).status).toBe(404)
      expect((await storedOrder(orderId)).returnedForCorrectionAt).not.toBeNull()
    })

    it("lets anyone at the branch resubmit, naming the raiser and telling them", async () => {
      const { status } = await resubmit(actors.groupPortalG, orderId, { note: "Fixed on their behalf" })
      expect(status).toBe(200)

      const [audit] = await auditFor(orderId, "ORDER_RESUBMITTED")
      expect(audit.userId).toBe(actors.groupPortalG.id)
      expect(audit.metadata).toMatchObject({ crossRequesterWrite: true, onBehalfOfUserId: actors.orderPortalA.id })
      expect(await noticesFor(actors.orderPortalA.id, orderId, "ORDER_RESUBMITTED_BY_COLLEAGUE")).toHaveLength(1)
      // The Group User that sent it back is told it is back, besides the branch's approver.
      const groupUserNotices = await noticesFor(actors.groupUserG.id, orderId, "ORDER_RESUBMITTED")
      expect(groupUserNotices).toEqual([expect.objectContaining({ targetRole: "GROUP_USER" })])
      expect(await noticesFor(actors.branchAdminA.id, orderId, "ORDER_RESUBMITTED")).toHaveLength(1)
    })

    it("shows the Group User its notice, and hides the approval prompt from a requester", async () => {
      signIn(actors.groupUserG)
      const groupUserFeed = await read(await notificationsRoute.GET())
      expect(groupUserFeed.status).toBe(200)
      expect(groupUserFeed.body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "ORDER_RESUBMITTED", orderId, cta: { label: "Review order", href: `/orders/${orderId}` } }),
      ]))

      signIn(actors.orderPortalA)
      const requesterFeed = await read(await notificationsRoute.GET())
      expect(requesterFeed.body.items.some((item: { type: string }) => item.type === "ORDER_RESUBMITTED")).toBe(false)
    })
  })

  describe("input validation", () => {
    let orderId: number

    beforeAll(async () => {
      orderId = await placeOrder(actors.orderPortalA, 1)
    })

    it("refuses a bad id, a missing or blank comment, an unknown field and an over-long comment", async () => {
      expect((await returnOrder(actors.branchAdminA, "abc")).status).toBe(400)
      expect((await returnOrder(actors.branchAdminA, 0)).status).toBe(400)
      expect((await returnOrder(actors.branchAdminA, orderId, {})).status).toBe(400)
      expect((await returnOrder(actors.branchAdminA, orderId, { comment: "   " })).status).toBe(400)
      expect((await returnOrder(actors.branchAdminA, orderId, { comment: "x", organizationId: foreignOrgId })).status).toBe(400)
      expect((await returnOrder(actors.branchAdminA, orderId, { comment: "x".repeat(1001) })).status).toBe(400)
      expect(await rounds(orderId)).toHaveLength(0)
    })

    it("refuses malformed resubmission bodies without changing the order", async () => {
      expect((await returnOrder(actors.branchAdminA, orderId)).status).toBe(200)
      expect((await resubmit(actors.orderPortalA, orderId, "{not json")).status).toBe(400)
      expect((await resubmit(actors.orderPortalA, orderId, { note: "x".repeat(1001) })).status).toBe(400)
      expect((await resubmit(actors.orderPortalA, orderId, { note: "x", branchId: branchB })).status).toBe(400)
      expect((await storedOrder(orderId)).returnedForCorrectionAt).not.toBeNull()
      // A blank note is no note.
      expect((await resubmit(actors.orderPortalA, orderId, { note: "   " })).status).toBe(200)
      const [round] = await rounds(orderId)
      expect(round.responseNote).toBeNull()
    })

    it("refuses to return an order that is not pending", async () => {
      const foreignOrder = await placeOrder(actors.orderPortalF, 1)
      expect((await approve(actors.branchAdminF, foreignOrder)).status).toBe(200)
      const { status, body } = await returnOrder(actors.branchAdminF, foreignOrder)
      expect(status).toBe(409)
      expect(body.error).toMatch(/APPROVED/)
    })
  })

  // ── group orders ──────────────────────────────────────────────────────────

  describe("a group order raised through the Group Order Portal", () => {
    it("tells the group requester it came back, and lets a branch colleague resubmit it", async () => {
      signIn(actors.groupPortalG)
      const created = await read(await groupOrdersRoute.POST(json(
        "http://localhost/api/v1/group-portal/orders",
        "POST",
        { groupId: groupG, entries: [{ branchIds: [branchA], items: [{ organizationInventoryId: inventoryT, quantity: 2 }] }] },
        { "Idempotency-Key": idempotencyKey() },
      )))
      expect(created.status).toBe(201)
      const [child] = await db.select({ id: orders.id }).from(orders).where(eq(orders.groupOrderId, created.body.item.id))

      expect((await returnOrder(actors.branchAdminA, child.id, { comment: "Split into two deliveries" })).status).toBe(200)
      expect(await noticesFor(actors.groupPortalG.id, child.id, "ORDER_RETURNED")).toEqual([
        expect.objectContaining({ targetRole: "GROUP_ORDER_PORTAL" }),
      ])
      const [mail] = await db.select({ recipientRole: emailOutbox.recipientRole }).from(emailOutbox)
        .where(and(eq(emailOutbox.orderId, child.id), eq(emailOutbox.template, "ORDER_RETURNED")))
      expect(mail.recipientRole).toBe("GROUP_ORDER_PORTAL")

      // The branch owns the order: its own Order Portal user may resubmit it.
      expect((await resubmit(actors.orderPortalA, child.id)).status).toBe(200)
      expect(await noticesFor(actors.groupPortalG.id, child.id, "ORDER_RESUBMITTED_BY_COLLEAGUE")).toHaveLength(1)
    })
  })

  // ── concurrency and the database's own guard ─────────────────────────────

  describe("races and invariants", () => {
    const scopeOf = (actor: Actor) => ({
      scope: {
        role: actor.role as any,
        userId: actor.id,
        organizationId: actor.organizationId,
        branchId: actor.branchId,
      },
      user: { id: actor.id, email: actor.email, role: actor.role },
    })

    it("lets exactly one of a simultaneous approval and return win", async () => {
      const orderId = await placeOrder(actors.orderPortalA, 1)
      const [approved, returned] = await Promise.all([
        approveOrder({ orderId, ...scopeOf(actors.branchAdminA) }),
        returnOrderForCorrection({ orderId, ...scopeOf(actors.groupUserG), comment: "Race" }),
      ])
      const winners = [approved.kind === "approved", returned.kind === "returned"].filter(Boolean)
      expect(winners).toHaveLength(1)
      const stored = await storedOrder(orderId)
      if (approved.kind === "approved") {
        expect(stored).toMatchObject({ status: "APPROVED", returnedForCorrectionAt: null })
        expect(await rounds(orderId)).toHaveLength(0)
      } else {
        expect(stored.status).toBe("PENDING")
        expect(stored.returnedForCorrectionAt).not.toBeNull()
      }
    })

    it("lets exactly one of two simultaneous returns win", async () => {
      const orderId = await placeOrder(actors.orderPortalA, 1)
      const outcomes = await Promise.all([
        returnOrderForCorrection({ orderId, ...scopeOf(actors.branchAdminA), comment: "First" }),
        returnOrderForCorrection({ orderId, ...scopeOf(actors.groupUserG), comment: "Second" }),
      ])
      expect(outcomes.filter((outcome) => outcome.kind === "returned")).toHaveLength(1)
      expect(await rounds(orderId)).toHaveLength(1)
    })

    it("refuses, at the database, a returned flag on an order that is not pending", async () => {
      const orderId = await placeOrder(actors.orderPortalA, 1)
      expect((await returnOrder(actors.branchAdminA, orderId)).status).toBe(200)
      await expect(db.update(orders).set({ status: "APPROVED" }).where(eq(orders.id, orderId)))
        .rejects.toThrow()
      await expect(db.update(orders).set({ correctionRequestNote: null }).where(eq(orders.id, orderId)))
        .rejects.toThrow()
      await expect(db.insert(orderCorrectionRequests).values({
        orderId, organizationId: orgId, branchId: branchA, requestedByUserId: actors.branchAdminA.id,
        requestedByRole: "BRANCH_ADMIN", comment: "A second open round",
      })).rejects.toThrow()
    })
  })

  describe("a colleague editing the same order twice", () => {
    it("succeeds both times rather than failing on the raiser's notice", async () => {
      const orderId = await placeOrder(actors.orderPortalA, 2)
      expect((await edit(actors.colleagueA, orderId, 3)).status).toBe(200)
      expect((await edit(actors.colleagueA, orderId, 4)).status).toBe(200)
      expect(await noticesFor(actors.orderPortalA.id, orderId, "ORDER_EDITED_BY_COLLEAGUE")).toHaveLength(1)
    })
  })
})
