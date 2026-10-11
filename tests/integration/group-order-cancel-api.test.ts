import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as cancelOrderRoute from "@/app/api/v1/group-portal/branch-orders/[orderId]/cancel/route"
import * as cancelSubmissionRoute from "@/app/api/v1/group-portal/orders/[groupOrderId]/cancel/route"
import * as decideRoute from "@/app/api/v1/group-portal/approvals/decide/route"
import {
  auditLogs,
  budgets,
  globalProducts,
  groupAuditLogs,
  notifications,
  orders,
  roles,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { cancelGroupBranchOrder } from "@/lib/server/group-order-cancel"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * A group requester cancelling group orders that are still waiting for
 * approval (`plans/OF-GROUP-cancel-pending-group-orders.md`), against Postgres.
 *
 * Fixture (`helpers/group-role-fixtures.ts`), fresh for every case:
 *   Alpha North  PENDING  group order, 100.00, 2.5 units — the cancellable one
 *                budget row: allocated 1,000.00, spent 200.00, held 300.00
 *   Alpha South  APPROVED group order — same submission, never cancellable
 *   Beta         REJECTED group order — another submission
 *   Alpha North  PENDING  ordinary order raised by Head Office — not a group order
 *   foreign      PENDING  group order in another tenant
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => {}),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

const cancelOrder = async (orderId: number | string, body: unknown = { reason: "Ordered by mistake" }) =>
  read(await cancelOrderRoute.POST(
    post(`/api/v1/group-portal/branch-orders/${orderId}/cancel`, body),
    { params: Promise.resolve({ orderId: String(orderId) }) },
  ))

const cancelSubmission = async (groupOrderId: number, body: unknown = { reason: "Site closed" }) =>
  read(await cancelSubmissionRoute.POST(
    post(`/api/v1/group-portal/orders/${groupOrderId}/cancel`, body),
    { params: Promise.resolve({ groupOrderId: String(groupOrderId) }) },
  ))

async function orderRow(id: number) {
  const [row] = await db
    .select({
      status: orders.status,
      cancelledAt: orders.cancelledAt,
      cancelledByUserId: orders.cancelledByUserId,
      cancellationReason: orders.cancellationReason,
    })
    .from(orders)
    .where(eq(orders.id, id))
  return row
}

async function alphaNorthBudget(f: GroupRoleFixtures) {
  const [row] = await db
    .select({ held: budgets.amountHeldCents, spent: budgets.amountSpentCents })
    .from(budgets)
    .where(and(eq(budgets.branchId, f.alphaNorthId), eq(budgets.period, currentBudgetPeriod())))
  return row
}

async function stockOf(productId: number) {
  const [row] = await db.select({ stock: globalProducts.stockQuantity }).from(globalProducts).where(eq(globalProducts.id, productId))
  return Number(row.stock)
}

describe.skipIf(!hasTestDatabase)("cancelling pending group orders", () => {
  let f: GroupRoleFixtures
  const extraUserIds: string[] = []

  const requester = (): Actor => ({
    id: f.requesterId,
    email: `requester-${f.suffix}@example.test`,
    role: "GROUP_ORDER_PORTAL",
    organizationId: f.organizationId,
  })
  const asRole = (id: string, role: string, organizationId: number | null): Actor => ({
    id, email: `${role.toLowerCase()}-${f.suffix}@example.test`, role, organizationId,
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.spyOn(console, "error").mockImplementation(() => {})
    f = await createGroupRoleFixtures()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    // This feature writes rows the shared teardown does not know about; they
    // reference the fixture's users and organizations, so they go first.
    const organizationIds = [f.organizationId, f.foreignOrganizationId]
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await destroyGroupRoleFixtures(f, extraUserIds.splice(0))
  })

  afterAll(async () => {
    await closePool()
  })

  describe("who may cancel", () => {
    it("is 401 without a session", async () => {
      signIn(null)
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(401)
      expect((await cancelSubmission(f.alphaEnvelopeId)).status).toBe(401)
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("PENDING")
    })

    it("is refused to every role but the Group Order Portal — approvers included", async () => {
      for (const actor of [
        asRole(f.approverId, "GROUP_USER", f.organizationId),
        asRole(f.headOfficeId, "HEAD_OFFICE", f.organizationId),
        asRole(f.superAdminId, "SUPER_ADMIN", null),
      ]) {
        signIn(actor)
        expect((await cancelOrder(f.alphaNorthOrderId)).status, actor.role).toBe(403)
        expect((await cancelSubmission(f.alphaEnvelopeId)).status, actor.role).toBe(403)
      }
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("PENDING")
    })

    it("answers another tenant's order as missing, and changes nothing", async () => {
      signIn(requester())
      expect((await cancelOrder(f.foreignOrderId)).status).toBe(404)
      expect((await cancelSubmission(f.foreignEnvelopeId)).status).toBe(404)
      expect((await orderRow(f.foreignOrderId)).status).toBe("PENDING")
    })

    it("answers a pending order that is not a group order as missing", async () => {
      signIn(requester())
      expect((await cancelOrder(f.ordinaryOrderId)).status).toBe(404)
      expect((await orderRow(f.ordinaryOrderId)).status).toBe("PENDING")
    })

    it("refuses a malformed id or a missing reason before touching anything", async () => {
      signIn(requester())
      expect((await cancelOrder("abc")).status).toBe(400)
      expect((await cancelOrder(f.alphaNorthOrderId, {})).status).toBe(400)
      expect((await cancelOrder(f.alphaNorthOrderId, { reason: "   " })).status).toBe(400)
      expect((await cancelOrder(f.alphaNorthOrderId, { reason: "x", status: "CANCELLED" })).status).toBe(400)
      expect((await cancelSubmission(f.alphaEnvelopeId, {})).status).toBe(400)
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("PENDING")
    })
  })

  describe("one branch order", () => {
    it("cancels a pending group order and releases its hold and its stock", async () => {
      const budgetBefore = await alphaNorthBudget(f)
      const stockBefore = await stockOf(f.productId)

      signIn(requester())
      const response = await cancelOrder(f.alphaNorthOrderId, { reason: "  Ordered by mistake  " })
      expect(response.status).toBe(200)

      expect(await orderRow(f.alphaNorthOrderId)).toMatchObject({
        status: "CANCELLED",
        cancelledByUserId: f.requesterId,
        cancellationReason: "Ordered by mistake",
      })
      expect((await orderRow(f.alphaNorthOrderId)).cancelledAt).toBeInstanceOf(Date)
      // The order's 100.00 hold is released; nothing spent moves.
      expect(await alphaNorthBudget(f)).toEqual({ held: budgetBefore.held - 10_000, spent: budgetBefore.spent })
      expect(await stockOf(f.productId)).toBeCloseTo(stockBefore + 2.5, 3)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_CANCELLED"), eq(auditLogs.entityId, String(f.alphaNorthOrderId))))
      expect(audit).toMatchObject({ userId: f.requesterId, organizationId: f.organizationId, branchId: f.alphaNorthId })
    })

    it("refuses an approved group order — once approved it stays", async () => {
      const budgetBefore = await alphaNorthBudget(f)
      signIn(requester())
      const response = await cancelOrder(f.alphaSouthOrderId)
      expect(response.status).toBe(409)
      expect(response.body.status).toBe("APPROVED")
      expect((await orderRow(f.alphaSouthOrderId)).status).toBe("APPROVED")
      expect(await alphaNorthBudget(f)).toEqual(budgetBefore)
    })

    it("refuses a rejected group order", async () => {
      signIn(requester())
      expect((await cancelOrder(f.betaOrderId)).status).toBe(409)
      expect((await orderRow(f.betaOrderId)).status).toBe("REJECTED")
    })

    it("cannot cancel twice, and releases the hold only once", async () => {
      signIn(requester())
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(200)
      const afterFirst = await alphaNorthBudget(f)
      const stockAfterFirst = await stockOf(f.productId)

      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(409)
      expect(await alphaNorthBudget(f)).toEqual(afterFirst)
      expect(await stockOf(f.productId)).toBeCloseTo(stockAfterFirst, 3)
    })

    it("leaves a cancelled order beyond the approver's reach", async () => {
      signIn(requester())
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(200)

      signIn(asRole(f.approverId, "GROUP_USER", f.organizationId))
      const decided = await read(await decideRoute.POST(post("/api/v1/group-portal/approvals/decide", {
        decision: "approve",
        orderIds: [f.alphaNorthOrderId],
      })))
      expect(decided.body.failed).toBe(1)
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("CANCELLED")
    })

    it("has exactly one winner when the cancel and an approval land together", async () => {
      const budgetBefore = await alphaNorthBudget(f)
      const stockBefore = await stockOf(f.productId)

      // The approver goes through the real route (the session mock is global,
      // so it is the approver's); the requester through the service the cancel
      // route calls, with its actor resolved as the route would.
      signIn(asRole(f.approverId, "GROUP_USER", f.organizationId))
      const [decided, cancelled] = await Promise.all([
        decideRoute.POST(post("/api/v1/group-portal/approvals/decide", {
          decision: "approve",
          orderIds: [f.alphaNorthOrderId],
        })).then(read),
        cancelGroupBranchOrder({
          orderId: f.alphaNorthOrderId,
          reason: "Raced an approval",
          actor: { userId: f.requesterId, organizationId: f.organizationId, role: "GROUP_ORDER_PORTAL" },
        }),
      ])

      const finalStatus = (await orderRow(f.alphaNorthOrderId)).status
      if (finalStatus === "CANCELLED") {
        expect(cancelled.kind).toBe("cancelled")
        expect(decided.body.failed).toBe(1)
        expect(await alphaNorthBudget(f)).toEqual({ held: budgetBefore.held - 10_000, spent: budgetBefore.spent })
        expect(await stockOf(f.productId)).toBeCloseTo(stockBefore + 2.5, 3)
      } else {
        expect(finalStatus).toBe("APPROVED")
        expect(cancelled.kind).not.toBe("cancelled")
        expect(decided.body.failed).toBe(0)
        // Approval keeps the hold; nothing was released.
        expect(await alphaNorthBudget(f)).toEqual(budgetBefore)
        expect(await stockOf(f.productId)).toBeCloseTo(stockBefore, 3)
      }
    })

    it("moves no budget for an order placed while budgets were off", async () => {
      await db.update(orders).set({ budgetTracked: false }).where(eq(orders.id, f.alphaNorthOrderId))
      const budgetBefore = await alphaNorthBudget(f)

      signIn(requester())
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(200)
      expect(await alphaNorthBudget(f)).toEqual(budgetBefore)
    })

    it("tells the raiser when another group requester on the same branches cancels it", async () => {
      const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "GROUP_ORDER_PORTAL")).limit(1)
      const [colleague] = await db.insert(users).values({
        email: `it-cancel-colleague-${f.suffix}@example.test`,
        username: `it-cancel-colleague-${f.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: roleRow.id,
        organizationId: f.organizationId,
        fullName: `Colleague ${f.suffix}`,
      }).returning({ id: users.id })
      extraUserIds.push(colleague.id)
      await db.insert(userGroupAssignments).values({
        userId: colleague.id,
        groupId: f.alphaGroupId,
        organizationId: f.organizationId,
        createdByUserId: f.headOfficeId,
      })

      signIn(asRole(colleague.id, "GROUP_ORDER_PORTAL", f.organizationId))
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(200)

      const notices = await db.select().from(notifications)
        .where(and(eq(notifications.userId, f.requesterId), eq(notifications.type, "ORDER_CANCELLED_BY_COLLEAGUE")))
      expect(notices).toHaveLength(1)
      expect(notices[0].orderId).toBe(f.alphaNorthOrderId)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_CANCELLED"), eq(auditLogs.entityId, String(f.alphaNorthOrderId))))
      expect(JSON.stringify(audit.metadata)).toContain(f.requesterId)
    })

    it("refuses a group requester with no assignments: an empty scope reaches nothing", async () => {
      const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "GROUP_ORDER_PORTAL")).limit(1)
      const [unassigned] = await db.insert(users).values({
        email: `it-cancel-unassigned-${f.suffix}@example.test`,
        username: `it-cancel-unassigned-${f.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: roleRow.id,
        organizationId: f.organizationId,
        fullName: `Unassigned ${f.suffix}`,
      }).returning({ id: users.id })
      extraUserIds.push(unassigned.id)

      signIn(asRole(unassigned.id, "GROUP_ORDER_PORTAL", f.organizationId))
      expect((await cancelOrder(f.alphaNorthOrderId)).status).toBe(404)
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("PENDING")
    })
  })

  describe("a whole submission", () => {
    it("cancels only the pending branch orders and keeps the approved one", async () => {
      const budgetBefore = await alphaNorthBudget(f)
      signIn(requester())
      const response = await cancelSubmission(f.alphaEnvelopeId)

      expect(response.status).toBe(200)
      expect(response.body.cancelled.map((order: { orderId: number }) => order.orderId)).toEqual([f.alphaNorthOrderId])
      expect(response.body.kept).toEqual([
        expect.objectContaining({ orderId: f.alphaSouthOrderId, status: "APPROVED" }),
      ])
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("CANCELLED")
      expect((await orderRow(f.alphaSouthOrderId)).status).toBe("APPROVED")
      expect(await alphaNorthBudget(f)).toEqual({ held: budgetBefore.held - 10_000, spent: budgetBefore.spent })

      const [groupAudit] = await db.select().from(groupAuditLogs)
        .where(and(eq(groupAuditLogs.organizationId, f.organizationId), eq(groupAuditLogs.action, "CANCEL_GROUP_ORDER")))
      expect(groupAudit.performedByUserId).toBe(f.requesterId)
    })

    it("is 409 when nothing in the submission is still pending", async () => {
      signIn(requester())
      expect((await cancelSubmission(f.alphaEnvelopeId)).status).toBe(200)
      const again = await cancelSubmission(f.alphaEnvelopeId)
      expect(again.status).toBe(409)

      // The Beta submission's only order was rejected.
      expect((await cancelSubmission(f.betaEnvelopeId)).status).toBe(409)
    })

    it("is not available to anyone but the requester who submitted it", async () => {
      const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "GROUP_ORDER_PORTAL")).limit(1)
      const [colleague] = await db.insert(users).values({
        email: `it-cancel-other-${f.suffix}@example.test`,
        username: `it-cancel-other-${f.suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: roleRow.id,
        organizationId: f.organizationId,
        fullName: `Other ${f.suffix}`,
      }).returning({ id: users.id })
      extraUserIds.push(colleague.id)

      signIn(asRole(colleague.id, "GROUP_ORDER_PORTAL", f.organizationId))
      expect((await cancelSubmission(f.alphaEnvelopeId)).status).toBe(404)
      expect((await orderRow(f.alphaNorthOrderId)).status).toBe("PENDING")
    })
  })
})
