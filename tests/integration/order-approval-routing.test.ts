import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, notInArray } from "drizzle-orm"

import * as coverageRoute from "@/app/api/v1/approval-levels/coverage/route"
import * as groupOrdersRoute from "@/app/api/v1/group-portal/orders/route"
import * as approveRoute from "@/app/api/v1/orders/[id]/approve/route"
import * as rejectRoute from "@/app/api/v1/orders/[id]/reject/route"
import * as returnRoute from "@/app/api/v1/orders/[id]/return-for-correction/route"
import * as orderRoute from "@/app/api/v1/orders/[id]/route"
import * as ordersRoute from "@/app/api/v1/orders/route"
import * as levelsRoute from "@/app/api/v1/organizations/[id]/approval-levels/route"
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
 * Routing orders by approval level, end to end
 * (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md): the real order,
 * decision, edit, group-portal, levels and coverage routes against Postgres.
 * Only the session, headers, rate limiter, cache and outbound email are faked.
 *
 * Levels: Level 1 = PKR 50.00 and above, Level 2 = under PKR 50.00. The
 * fixture product is PKR 10.00, so 10 units is Level 1 and 1 unit is Level 2.
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

type Actor = { id: string; role: string; organizationId: number | null }

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
const idempotencyKey = () => `oar-it-${Date.now().toString(36)}-${(counter += 1)}`

describe.skipIf(!hasTestDatabase)("routing orders by approval level", () => {
  let f: GroupRoleFixtures
  let inventoryId: number
  let levelTwoId: string

  const headOffice = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId })
  const levelOne = (): Actor => ({ id: f.approverId, role: "GROUP_USER", organizationId: f.organizationId })
  const levelTwo = (): Actor => ({ id: levelTwoId, role: "GROUP_USER", organizationId: f.organizationId })
  const requester = (): Actor => ({ id: f.requesterId, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  const superAdmin = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null })

  async function setLevels(enabled: boolean) {
    await db.update(organizations).set({ orderApprovalLevelsEnabled: enabled }).where(eq(organizations.id, f.organizationId))
  }

  async function setUserLevel(userId: string, level: number | null) {
    await db.update(users).set({ orderApprovalLevel: level }).where(eq(users.id, userId))
  }

  /** Head Office places a single-branch order of `quantity` units at Alpha North. */
  async function placeOrder(quantity: number) {
    signIn(headOffice())
    const response = await ordersRoute.POST(json(
      "http://localhost/api/v1/orders",
      "POST",
      { branchId: f.alphaNorthId, items: [{ organizationInventoryId: inventoryId, quantity }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    return { status: response.status, body: await response.json() }
  }

  async function placeGroupOrder(quantity: number) {
    signIn(requester())
    const response = await groupOrdersRoute.POST(json(
      "http://localhost/api/v1/group-portal/orders",
      "POST",
      { groupId: f.alphaGroupId, entries: [{ branchIds: [f.alphaNorthId], items: [{ organizationInventoryId: inventoryId, quantity }] }] },
      { "Idempotency-Key": idempotencyKey() },
    ))
    const body = await response.json()
    return { status: response.status, orderId: body?.item?.results?.[0]?.orderId as number | undefined, body }
  }

  async function storedLevel(orderId: number) {
    const [row] = await db.select({ level: orders.approvalLevel, status: orders.status }).from(orders).where(eq(orders.id, orderId))
    return row
  }

  async function approve(orderId: number, actor: Actor) {
    signIn(actor)
    return (await approveRoute.POST(json(`http://localhost/api/v1/orders/${orderId}/approve`, "POST", {}), idParams(orderId))).status
  }

  async function reject(orderId: number, actor: Actor) {
    signIn(actor)
    return (await rejectRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/reject`, "POST", { reason: "Not this month" }),
      idParams(orderId),
    )).status
  }

  async function returnForCorrection(orderId: number, actor: Actor) {
    signIn(actor)
    return (await returnRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/return-for-correction`, "POST", { comment: "Please fix the quantity" }),
      idParams(orderId),
    )).status
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
    await db.update(organizations).set({
      budgetsEnabled: false,
      orderApprovalRequired: true,
      orderApproverRole: "BRANCH_ADMIN",
      orderApprovalLevelsEnabled: false,
    }).where(eq(organizations.id, f.organizationId))
    await db.insert(organizationApprovalLevels).values([
      { organizationId: f.organizationId, level: 1, maxAmountCents: 5_000 },
      { organizationId: f.organizationId, level: 2, maxAmountCents: 2_000 },
    ])

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
    await db.update(globalProducts).set({ stockQuantity: 10_000 }).where(eq(globalProducts.id, f.productId))

    // The fixture's Group User covers the Alpha group; it holds Level 1. A
    // second Group User at Alpha North holds Level 2.
    await setUserLevel(f.approverId, 1)
    const [groupUserRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "GROUP_USER"))
    const [second] = await db.insert(users).values({
      email: `oar-level-two-${f.suffix}@example.test`,
      username: `oar-level-two-${f.suffix}`,
      passwordHash: "x",
      roleId: groupUserRole.id,
      organizationId: f.organizationId,
      orderApprovalLevel: 2,
    }).returning({ id: users.id })
    levelTwoId = second.id
    await db.insert(userBranchAssignments).values({
      userId: levelTwoId,
      branchId: f.alphaNorthId,
      organizationId: f.organizationId,
    })
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
    await destroyGroupRoleFixtures(f, [levelTwoId])
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    await setLevels(true)
    await setUserLevel(f.approverId, 1)
    await setUserLevel(levelTwoId, 2)
  })

  describe("an organization not using levels is unchanged", () => {
    it("gives the order no level, and any Group User at the branch decides it as before", async () => {
      await setLevels(false)
      const placed = await placeOrder(10)
      expect(placed.status).toBe(200)
      expect((await storedLevel(placed.body.order.id)).level).toBeNull()
      // The Level 2 holder may approve a 10-unit order: levels play no part.
      expect(await approve(placed.body.order.id, levelTwo())).toBe(200)
    })

    it("decides a pending order created before levels were on as before, even once they are", async () => {
      await setLevels(false)
      const placed = await placeOrder(10)
      await setLevels(true)
      expect((await storedLevel(placed.body.order.id)).level).toBeNull()
      expect(await approve(placed.body.order.id, levelTwo())).toBe(200)
    })
  })

  describe("creation", () => {
    it("bands each order on its own total", async () => {
      const large = await placeOrder(10)
      const small = await placeOrder(1)
      expect(large.status).toBe(200)
      expect(small.status).toBe(200)
      expect((await storedLevel(large.body.order.id)).level).toBe(1)
      expect((await storedLevel(small.body.order.id)).level).toBe(2)
    })

    it("refuses an order nobody at the branch could decide, and holds nothing", async () => {
      await setUserLevel(f.approverId, null)
      const before = await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, f.organizationId))
      const refused = await placeOrder(10)
      expect(refused.status).toBe(409)
      expect(refused.body.code).toBe("APPROVAL_LEVEL_UNAVAILABLE")
      expect(refused.body.approvalLevel).toBe(1)
      const after = await db.select({ id: orders.id }).from(orders).where(eq(orders.organizationId, f.organizationId))
      expect(after).toHaveLength(before.length)
    })

    it("asks only the level's holders to approve a group order", async () => {
      const placed = await placeGroupOrder(10)
      expect(placed.orderId, JSON.stringify(placed.body)).toBeDefined()
      const orderId = placed.orderId!
      expect((await storedLevel(orderId)).level).toBe(1)
      const asked = await db.select({ userId: notifications.userId }).from(notifications)
        .where(and(eq(notifications.orderId, orderId), eq(notifications.type, "ORDER_CREATED")))
      expect(asked.map((row) => row.userId)).toEqual([f.approverId])
    })
  })

  describe("deciding", () => {
    it("lets only the holder of the order's level approve it", async () => {
      const { body } = await placeOrder(10)
      expect(await approve(body.order.id, levelTwo())).toBe(403)
      expect(await approve(body.order.id, levelOne())).toBe(200)
    })

    it("lets only the holder of the order's level reject or return it", async () => {
      const small = await placeOrder(1)
      expect(await reject(small.body.order.id, levelOne())).toBe(403)
      expect(await returnForCorrection(small.body.order.id, levelOne())).toBe(403)
      expect(await returnForCorrection(small.body.order.id, levelTwo())).toBe(200)
      expect(await reject(small.body.order.id, levelTwo())).toBe(200)
    })

    it("refuses a holder whose level was taken away after the order was placed", async () => {
      const { body } = await placeOrder(10)
      await setUserLevel(f.approverId, null)
      expect(await approve(body.order.id, levelOne())).toBe(403)
    })

    it("hands a pending levelled order to the normal approvers when levels are switched off, and back when on", async () => {
      const { body } = await placeOrder(10)
      await setLevels(false)
      // Levels off: any Group User at the branch decides, as before.
      signIn(levelTwo())
      const detail = await (await orderRoute.GET(json(`http://localhost/api/v1/orders/${body.order.id}`, "GET"), idParams(body.order.id))).json()
      expect(detail.item.levelDecisionLocked).toBe(false)
      await setLevels(true)
      expect(await approve(body.order.id, levelTwo())).toBe(403)
      await setLevels(false)
      expect(await approve(body.order.id, levelTwo())).toBe(200)
    })

    it("tells a reader which level an order waits at, and whether it is theirs to decide", async () => {
      const { body } = await placeOrder(10)
      signIn(levelTwo())
      const asLevelTwo = await (await orderRoute.GET(json(`http://localhost/api/v1/orders/${body.order.id}`, "GET"), idParams(body.order.id))).json()
      expect(asLevelTwo.item.approvalLevel).toBe(1)
      expect(asLevelTwo.item.levelDecisionLocked).toBe(true)
      signIn(levelOne())
      const asLevelOne = await (await orderRoute.GET(json(`http://localhost/api/v1/orders/${body.order.id}`, "GET"), idParams(body.order.id))).json()
      expect(asLevelOne.item.levelDecisionLocked).toBe(false)
    })
  })

  describe("editing", () => {
    it("moves an order to its new level, and the old level can no longer decide it", async () => {
      const placed = await placeGroupOrder(1)
      const orderId = placed.orderId!
      expect((await storedLevel(orderId)).level).toBe(2)

      signIn(requester())
      const edited = await orderRoute.PUT(
        json(`http://localhost/api/v1/orders/${orderId}`, "PUT", { items: [{ organizationInventoryId: inventoryId, quantity: 10 }] }),
        idParams(orderId),
      )
      expect(edited.status, JSON.stringify(await edited.clone().json())).toBe(200)
      expect((await storedLevel(orderId)).level).toBe(1)

      expect(await approve(orderId, levelTwo())).toBe(403)
      const told = await db.select({ userId: notifications.userId, message: notifications.message }).from(notifications)
        .where(and(eq(notifications.orderId, orderId), eq(notifications.userId, f.approverId)))
      expect(told.some((row) => row.message.includes("Level 1"))).toBe(true)
      expect(await approve(orderId, levelOne())).toBe(200)
    })

    it("refuses an edit into a level nobody at the branch holds", async () => {
      const placed = await placeGroupOrder(1)
      await setUserLevel(f.approverId, null)
      signIn(requester())
      const edited = await orderRoute.PUT(
        json(`http://localhost/api/v1/orders/${placed.orderId}`, "PUT", { items: [{ organizationInventoryId: inventoryId, quantity: 10 }] }),
        idParams(placed.orderId!),
      )
      expect(edited.status).toBe(409)
      expect((await storedLevel(placed.orderId!)).level).toBe(2)
    })
  })

  describe("removing a level", () => {
    it("is refused while a pending order waits at it", async () => {
      const small = await placeOrder(1)
      expect((await storedLevel(small.body.order.id)).level).toBe(2)
      // Nobody holds Level 2 any more, so only the pending order stands in the way.
      await setUserLevel(levelTwoId, null)
      signIn(superAdmin())
      const response = await levelsRoute.PUT(
        json(`http://localhost/api/v1/organizations/${f.organizationId}/approval-levels`, "PUT", {
          enabled: true,
          levels: [{ maxAmountCents: 5_000 }],
        }),
        idParams(f.organizationId),
      )
      expect(response.status).toBe(409)
      expect((await response.json()).error).toMatch(/Pending orders are waiting at: Level 2/)
      const kept = await db.select({ level: organizationApprovalLevels.level }).from(organizationApprovalLevels)
        .where(eq(organizationApprovalLevels.organizationId, f.organizationId))
      expect(kept).toHaveLength(2)
    })
  })

  describe("coverage", () => {
    it("counts the holders of each level per branch for Head Office's own organization", async () => {
      signIn(headOffice())
      const response = await coverageRoute.GET(json("http://localhost/api/v1/approval-levels/coverage", "GET"))
      expect(response.status).toBe(200)
      const coverage = await response.json()
      expect(coverage.active).toBe(true)
      const north = coverage.branches.find((branch: any) => branch.id === f.alphaNorthId)
      expect(north.holders).toEqual({ 1: 1, 2: 1 })
      expect(north.missingLevels).toEqual([])
      // Beta is outside both holders' reach.
      const beta = coverage.branches.find((branch: any) => branch.id === f.betaBranchId)
      expect(beta.missingLevels).toEqual([1, 2])
    })

    it("answers another organization's Head Office about its own organization only", async () => {
      signIn({ id: f.foreignHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.foreignOrganizationId })
      const response = await coverageRoute.GET(json(`http://localhost/api/v1/approval-levels/coverage?organizationId=${f.organizationId}`, "GET"))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ active: false, levels: [], branches: [] })
    })

    it("refuses roles that do not manage users", async () => {
      signIn(levelOne())
      expect((await coverageRoute.GET(json("http://localhost/api/v1/approval-levels/coverage", "GET"))).status).toBe(403)
    })
  })
})
