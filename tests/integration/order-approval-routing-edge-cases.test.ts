import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, notInArray } from "drizzle-orm"

import * as coverageRoute from "@/app/api/v1/approval-levels/coverage/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as approveRoute from "@/app/api/v1/orders/[id]/approve/route"
import * as rejectRoute from "@/app/api/v1/orders/[id]/reject/route"
import * as resubmitRoute from "@/app/api/v1/orders/[id]/resubmit/route"
import * as returnRoute from "@/app/api/v1/orders/[id]/return-for-correction/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import {
  branchInventory,
  emailOutbox,
  globalProducts,
  groupAuditLogs,
  groupOrders,
  invoiceSequences,
  notifications,
  orderCorrectionRequests,
  orderItems,
  orders,
  organizationApprovalLevels,
  organizationInventory,
  organizations,
  roles,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * Routing orders by approval level, at its edges
 * (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md). The main suite,
 * `order-approval-routing.test.ts`, carries the matrix; this carries what sits
 * on a boundary: the exact band edge, holders who no longer count, the person
 * who raised the order holding its level, Head Office as the configured
 * approver role, approval switched off, a double-submitted decision, a
 * resubmission, a group submission one of whose branches has no holder, and
 * the tenant fence.
 *
 * Levels: Level 1 = PKR 50.00 and above, Level 2 = under PKR 50.00, and the
 * fixture product is PKR 10.00 — so 5 units sit exactly on Level 1's edge.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return { ...actual, withRateLimit: vi.fn(async () => null) }
})
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

type Actor = { id: string; role: string; organizationId: number | null; branchId?: number }

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({
    user: { ...actor, email: `${actor.id}@example.test`, mustChangePassword: false },
  } as any)
}

const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
})
const idParams = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

let counter = 0
const idempotencyKey = () => `oar-edge-${Date.now().toString(36)}-${(counter += 1)}`

describe.skipIf(!hasTestDatabase)("routing orders by approval level, at its edges", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  let levelTwoId: string
  let branchAdminId: string

  const headOffice = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const levelOne = (): Actor => ({ id: f.approverId, role: "GROUP_USER", organizationId: f.organizationId })
  const levelTwo = (): Actor => ({ id: levelTwoId, role: "GROUP_USER", organizationId: f.organizationId })
  const branchAdmin = (): Actor => ({ id: branchAdminId, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.alphaNorthId })
  const requester = (): Actor => ({ id: f.requesterId, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  const superAdmin = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null })
  const foreignHeadOffice = (): Actor => ({ id: f.foreignHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })

  async function setOrganization(values: Partial<typeof organizations.$inferInsert>) {
    await db.update(organizations).set(values).where(eq(organizations.id, f.organizationId))
  }

  async function setUser(userId: string, values: Partial<typeof users.$inferInsert>) {
    await db.update(users).set(values).where(eq(users.id, userId))
  }

  async function placeOrder(quantity: number, actor: Actor = headOffice()) {
    signIn(actor)
    const response = await ordersRoute.POST(json(
      "http://localhost/api/v1/orders",
      "POST",
      { branchId: f.alphaNorthId, items: [{ organizationInventoryId: inventoryId, quantity }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    return { status: response.status, body: await response.json() }
  }

  async function placeGroupOrder(quantity: number, branchIds: number[]) {
    signIn(requester())
    const response = await groupOrdersRoute.POST(json(
      "http://localhost/api/v1/group-portal/orders",
      "POST",
      { groupId: f.alphaGroupId, entries: [{ branchIds, items: [{ organizationInventoryId: inventoryId, quantity }] }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    return { status: response.status, body: await response.json() }
  }

  async function stored(orderId: number) {
    const [row] = await db
      .select({ level: orders.approvalLevel, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
    return row
  }

  async function approve(orderId: number, actor: Actor) {
    signIn(actor)
    return (await approveRoute.POST(json(`http://localhost/api/v1/orders/${orderId}/approve`, "POST", {}), idParams(orderId))).status
  }

  async function holdersAsked(orderId: number, type: string) {
    const rows = await db.select({ userId: notifications.userId }).from(notifications)
      .where(and(eq(notifications.orderId, orderId), eq(notifications.type, type)))
    return rows.map((row) => row.userId).sort()
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    await db.insert(organizationApprovalLevels).values([
      { organizationId: f.organizationId, level: 1, maxAmountCents: 5_000 },
      { organizationId: f.organizationId, level: 2, maxAmountCents: 2_000 },
    ])

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

    const roleId = async (name: string) => (await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)))[0].id
    const [second] = await db.insert(users).values({
      email: `oar-edge-two-${f.suffix}@example.test`,
      username: `oar-edge-two-${f.suffix}`,
      passwordHash: "x",
      roleId: await roleId("GROUP_USER"),
      organizationId: f.organizationId,
    }).returning({ id: users.id })
    levelTwoId = second.id
    // Level 2's holder reaches Alpha North only; Alpha South has no Level 2.
    await db.insert(userBranchAssignments).values({ userId: levelTwoId, branchId: f.alphaNorthId, organizationId: f.organizationId })

    const [admin] = await db.insert(users).values({
      email: `oar-edge-admin-${f.suffix}@example.test`,
      username: `oar-edge-admin-${f.suffix}`,
      passwordHash: "x",
      roleId: await roleId("BRANCH_ADMIN"),
      organizationId: f.organizationId,
      branchId: f.alphaNorthId,
    }).returning({ id: users.id })
    branchAdminId = admin.id
  })

  afterAll(async () => {
    if (!f) return
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    const fixtureOrderIds = [f.alphaNorthOrderId, f.alphaSouthOrderId, f.betaOrderId, f.foreignOrderId, f.ordinaryOrderId]
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderCorrectionRequests).where(inArray(orderCorrectionRequests.organizationId, organizationIds))
    const mine = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.organizationId, organizationIds)))
      .map((row) => row.id)
      .filter((id) => !fixtureOrderIds.includes(id))
    if (mine.length > 0) {
      await db.delete(orderItems).where(inArray(orderItems.orderId, mine))
      await db.delete(orders).where(inArray(orders.id, mine))
    }
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(groupOrders).where(and(
      inArray(groupOrders.organizationId, organizationIds),
      notInArray(groupOrders.id, [f.alphaEnvelopeId, f.betaEnvelopeId, f.foreignEnvelopeId]),
    ))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(branchInventory).where(eq(branchInventory.organizationInventoryId, inventoryId))
    await db.delete(organizationInventory).where(eq(organizationInventory.id, inventoryId))
    await destroyGroupRoleFixtures(f, [levelTwoId, branchAdminId])
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await setOrganization({
      budgetsEnabled: false,
      orderApprovalRequired: true,
      orderApproverRole: "BRANCH_ADMIN",
      orderApprovalLevelsEnabled: true,
    })
    await setUser(f.approverId, { orderApprovalLevel: 1, isActive: true, deletedAt: null })
    await setUser(levelTwoId, { orderApprovalLevel: 2, isActive: true })
    await setUser(branchAdminId, { orderApprovalLevel: null })
    await setUser(f.headOfficeId, { orderApprovalLevel: null })
  })

  describe("the band edge", () => {
    it("puts an order of exactly Level 1's amount at Level 1, and one unit less at Level 2", async () => {
      const onEdge = await placeOrder(5)
      const below = await placeOrder(4)
      expect(onEdge.status, JSON.stringify(onEdge.body)).toBe(200)
      expect((await stored(onEdge.body.order.id)).level).toBe(1)
      expect((await stored(below.body.order.id)).level).toBe(2)
    })
  })

  describe("holders who no longer count", () => {
    it.each([
      ["deactivated", { isActive: false }],
      ["deleted", { deletedAt: new Date() }],
    ])("refuses an order whose only holder was %s", async (_case, values) => {
      await setUser(f.approverId, values)
      const refused = await placeOrder(10)
      expect(refused.status).toBe(409)
      expect(refused.body).toMatchObject({ code: "APPROVAL_LEVEL_UNAVAILABLE", approvalLevel: 1 })
    })

    it("does not count a Branch Admin holding a level once Head Office is the approver role", async () => {
      await setUser(f.approverId, { orderApprovalLevel: null })
      await setUser(branchAdminId, { orderApprovalLevel: 1 })
      expect((await placeOrder(10)).status).toBe(200)

      await setOrganization({ orderApproverRole: "HEAD_OFFICE" })
      expect((await placeOrder(10)).status).toBe(409)
    })

    it("does not count a holder who does not reach the branch", async () => {
      // Level 2's only holder reaches Alpha North; a Level 2 order at Alpha South has nobody.
      await setUser(f.approverId, { orderApprovalLevel: null })
      signIn(headOffice())
      const response = await ordersRoute.POST(json(
        "http://localhost/api/v1/orders",
        "POST",
        { branchId: f.alphaSouthId, items: [{ organizationInventoryId: inventoryId, quantity: 1 }] },
        { "Idempotency-Key": idempotencyKey() },
      ))
      expect(response.status).toBe(409)
      expect((await response.json()).approvalLevel).toBe(2)
    })
  })

  describe("the person who raised the order", () => {
    it("never decides it, even holding its level, and does not count as its holder", async () => {
      await setUser(branchAdminId, { orderApprovalLevel: 1 })
      const placed = await placeOrder(10, branchAdmin())
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      const orderId = placed.body.order.id
      expect(await approve(orderId, branchAdmin())).toBe(403)
      expect(await approve(orderId, levelOne())).toBe(200)

      // With the creator as the level's only holder, nobody could decide it.
      await setUser(f.approverId, { orderApprovalLevel: null })
      const refused = await placeOrder(10, branchAdmin())
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("APPROVAL_LEVEL_UNAVAILABLE")
    })
  })

  describe("Head Office as the approver role", () => {
    it("lets a Head Office holder decide at any branch, and only at its own level", async () => {
      await setOrganization({ orderApproverRole: "HEAD_OFFICE" })
      await setUser(f.approverId, { orderApprovalLevel: null })
      await setUser(f.headOfficeId, { orderApprovalLevel: 1 })

      const large = await placeOrder(10, branchAdmin())
      expect(large.status, JSON.stringify(large.body)).toBe(200)
      expect((await stored(large.body.order.id)).level).toBe(1)
      expect(await approve(large.body.order.id, headOffice())).toBe(200)

      const small = await placeOrder(1, branchAdmin())
      expect((await stored(small.body.order.id)).level).toBe(2)
      expect(await approve(small.body.order.id, headOffice())).toBe(403)
      expect(await approve(small.body.order.id, levelTwo())).toBe(200)
    })

    it("asks the Head Office holder to approve a requester's order", async () => {
      await setOrganization({ orderApproverRole: "HEAD_OFFICE" })
      await setUser(f.approverId, { orderApprovalLevel: null })
      await setUser(f.headOfficeId, { orderApprovalLevel: 1 })
      const placed = await placeGroupOrder(10, [f.alphaNorthId])
      const orderId = placed.body?.item?.results?.[0]?.orderId as number
      expect(orderId, JSON.stringify(placed.body)).toBeDefined()
      expect(await holdersAsked(orderId, "ORDER_CREATED")).toEqual([f.headOfficeId])
    })

    it("refuses Head Office without a level, even as the approver role", async () => {
      await setOrganization({ orderApproverRole: "HEAD_OFFICE" })
      const placed = await placeOrder(10, branchAdmin())
      expect(await approve(placed.body.order.id, headOffice())).toBe(403)
    })
  })

  describe("approval not required", () => {
    it("approves at creation with no level, even when nobody holds one", async () => {
      await setOrganization({ orderApprovalRequired: false })
      await setUser(f.approverId, { orderApprovalLevel: null })
      await setUser(levelTwoId, { orderApprovalLevel: null })
      const placed = await placeOrder(10)
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      expect(await stored(placed.body.order.id)).toMatchObject({ level: null, status: "APPROVED" })
    })
  })

  describe("a decision sent twice", () => {
    it("approves once and answers the second with 409", async () => {
      const placed = await placeOrder(10)
      signIn(levelOne())
      const statuses = await Promise.all([1, 2].map(() => approveRoute.POST(
        json(`http://localhost/api/v1/orders/${placed.body.order.id}/approve`, "POST", {}),
        idParams(placed.body.order.id),
      )))
      expect(statuses.map((response) => response.status).sort()).toEqual([200, 409])
      expect((await stored(placed.body.order.id)).status).toBe("APPROVED")
    })

    it("lets an approval and a rejection by the holder race with one winner", async () => {
      const placed = await placeOrder(1)
      signIn(levelTwo())
      const [approved, rejected] = await Promise.all([
        approveRoute.POST(json(`http://localhost/api/v1/orders/${placed.body.order.id}/approve`, "POST", {}), idParams(placed.body.order.id)),
        rejectRoute.POST(json(`http://localhost/api/v1/orders/${placed.body.order.id}/reject`, "POST", { reason: "Race" }), idParams(placed.body.order.id)),
      ])
      expect([approved.status, rejected.status].sort()).toEqual([200, 409])
      expect(["APPROVED", "REJECTED"]).toContain((await stored(placed.body.order.id)).status)
    })
  })

  describe("asking for approval", () => {
    // "Awaiting approval" is raised for a requester's order only (Order Portal,
    // Group Order Portal), with or without levels; these orders come from one.
    it("asks every holder of the order's level who reaches the branch, and no one at the other level", async () => {
      await setUser(branchAdminId, { orderApprovalLevel: 2 })
      const small = await placeGroupOrder(1, [f.alphaNorthId])
      const smallId = small.body.item.results[0].orderId as number
      expect(await holdersAsked(smallId, "ORDER_CREATED")).toEqual([levelTwoId, branchAdminId].sort())
      const large = await placeGroupOrder(10, [f.alphaNorthId])
      expect(await holdersAsked(large.body.item.results[0].orderId as number, "ORDER_CREATED")).toEqual([f.approverId])
    })

    it("asks the level's holders again when a returned order is resubmitted, at the same level", async () => {
      const placed = await placeGroupOrder(1, [f.alphaNorthId])
      const orderId = placed.body.item.results[0].orderId as number
      expect((await stored(orderId)).level).toBe(2)

      signIn(levelTwo())
      const returned = await returnRoute.POST(
        json(`http://localhost/api/v1/orders/${orderId}/return-for-correction`, "POST", { comment: "Fix the quantity" }),
        idParams(orderId),
      )
      expect(returned.status).toBe(200)

      signIn(requester())
      const resubmitted = await resubmitRoute.POST(
        json(`http://localhost/api/v1/orders/${orderId}/resubmit`, "POST", { note: "Fixed" }),
        idParams(orderId),
      )
      expect(resubmitted.status, JSON.stringify(await resubmitted.clone().json())).toBe(200)
      expect(await stored(orderId)).toMatchObject({ level: 2, status: "PENDING" })

      const told = await db.select({ userId: notifications.userId, message: notifications.message }).from(notifications)
        .where(eq(notifications.orderId, orderId))
      const resubmissionNotices = told.filter((row) => row.message.includes("resubmitted"))
      expect(resubmissionNotices.map((row) => row.userId)).toEqual([levelTwoId])
      expect(resubmissionNotices[0].message).toContain("Level 2")
      expect(await approve(orderId, levelOne())).toBe(403)
      expect(await approve(orderId, levelTwo())).toBe(200)
    })
  })

  describe("a group submission", () => {
    it("bands each branch on its own total, and fails only the branch nobody could decide", async () => {
      // Alpha North has a Level 2 holder; Alpha South does not.
      const placed = await placeGroupOrder(1, [f.alphaNorthId, f.alphaSouthId])
      const results = placed.body?.item?.results ?? []
      const north = results.find((result: any) => result.branchId === f.alphaNorthId)
      const south = results.find((result: any) => result.branchId === f.alphaSouthId)
      expect(north?.orderId, JSON.stringify(placed.body)).toBeDefined()
      expect((await stored(north.orderId)).level).toBe(2)
      expect(south?.orderId).toBeUndefined()
      expect(JSON.stringify(south)).toMatch(/Level 2/)
    })

    it("places both branches at Level 1 when its holder reaches both", async () => {
      const placed = await placeGroupOrder(10, [f.alphaNorthId, f.alphaSouthId])
      const ids = (placed.body?.item?.results ?? []).map((result: any) => result.orderId)
      expect(ids.filter(Boolean), JSON.stringify(placed.body)).toHaveLength(2)
      for (const id of ids) expect((await stored(id)).level).toBe(1)
    })
  })

  describe("the tenant fence", () => {
    it("refuses another organization's Head Office, whatever level it holds", async () => {
      await setUser(f.foreignHeadOfficeId, { orderApprovalLevel: 1 })
      try {
        const placed = await placeOrder(10)
        // The shared decision policy answers out-of-scope with 403 (it predates
        // levels); the level a foreign account holds must not widen that.
        expect([403, 404]).toContain(await approve(placed.body.order.id, foreignHeadOffice()))
        expect((await stored(placed.body.order.id)).status).toBe("PENDING")
      } finally {
        await setUser(f.foreignHeadOfficeId, { orderApprovalLevel: null })
      }
    })
  })

  describe("coverage", () => {
    async function coverage(actor: Actor, query = "") {
      signIn(actor)
      const response = await coverageRoute.GET(json(`http://localhost/api/v1/approval-levels/coverage${query}`, "GET"))
      return { status: response.status, body: response.status === 200 ? await response.json() : null }
    }

    it("lets Super Admin read an organization it names, and requires one", async () => {
      expect((await coverage(superAdmin())).status).toBe(400)
      expect((await coverage(superAdmin(), "?organizationId=abc")).status).toBe(400)
      const named = await coverage(superAdmin(), `?organizationId=${f.organizationId}`)
      expect(named.status).toBe(200)
      expect(named.body.active).toBe(true)
      expect((await coverage(superAdmin(), "?organizationId=999999999")).status).toBe(404)
    })

    it("answers inactive while levels are off, and leaves out holders who no longer count", async () => {
      await setOrganization({ orderApprovalLevelsEnabled: false })
      expect((await coverage(headOffice())).body.active).toBe(false)

      await setOrganization({ orderApprovalLevelsEnabled: true })
      await setUser(f.approverId, { isActive: false })
      const north = (await coverage(headOffice())).body.branches.find((branch: any) => branch.id === f.alphaNorthId)
      expect(north.missingLevels).toEqual([1])
    })

    it.each(["BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])("refuses %s", async (role) => {
      expect((await coverage({ id: branchAdminId, role, organizationId: f.organizationId })).status).toBe(403)
    })
  })
})
