import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like } from "drizzle-orm"

import * as sendTokenRoute from "@/app/api/v1/orders/[id]/send-token-email/route"
import * as groupTokensRoute from "@/app/api/v1/group-portal/orders/[groupOrderId]/tokens/route"
import { auditLogs, groupOrders, orders } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import * as mockedEmail from "@/lib/email"
import {
  TOKEN_ALREADY_SENT_CODE,
  TOKEN_ORDER_NOT_APPROVED_CODE,
  TOKEN_SETTLEMENT_FAILED_CODE,
} from "@/lib/order-token-handoff"
import { sendTokenEmailOncePerOrder } from "@/lib/server/order-token-handoff-store"

import {
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

/**
 * A fulfilment token is emailed once per order.
 *
 * The real route, the real advisory lock and the real `token_handoff_at`
 * column decide every outcome here; only the session, rate limiting and the
 * outbound mail are stubbed — the mail so the test can count the sends and
 * make one fail or stall.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return {
    ...actual,
    sendOrderTokenEmail: vi.fn(async () => undefined),
    sendGroupOrderTokensEmail: vi.fn(async () => undefined),
  }
})

/**
 * A settlement that fails after the token has gone, as one did in production
 * on 2026-10-26: the next N fulfilments throw inside their own transaction, so
 * the order, the ledger and the audit row all roll back exactly as they would.
 */
const settlementFault = vi.hoisted(() => ({ remaining: 0 }))
vi.mock("@/lib/server/warehouse-order-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/warehouse-order-notifications")>()
  return {
    ...actual,
    queueWarehouseOrderNotifications: vi.fn(async (...args: Parameters<typeof actual.queueWarehouseOrderNotifications>) => {
      if (settlementFault.remaining > 0) {
        settlementFault.remaining -= 1
        throw new Error("simulated settlement fault")
      }
      return actual.queueWarehouseOrderNotifications(...args)
    }),
  }
})

const { getServerSession } = mockedNextAuth
const sendOrderTokenEmail = vi.mocked(mockedEmail.sendOrderTokenEmail)
const sendGroupOrderTokensEmail = vi.mocked(mockedEmail.sendGroupOrderTokensEmail)

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { ...actor, mustChangePassword: false } } as any)
}

const SEEDED_TID_PREFIX = "TEO-"
// Dated in a month with no budget row, so settling an order through the
// hand-off moves no ledger.
const SEEDED_CREATED_AT = new Date("2025-01-15T10:00:00.000Z")

describe.skipIf(!hasTestDatabase)("a fulfilment token is emailed once per order", () => {
  let f: GroupRoleFixtures
  let seeded = 0
  const envelopeIds: number[] = []

  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const unassignedApprover = (): Actor => ({ id: f.emptyApproverId, email: `eap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })

  /** An approved order raised by the requester at Alpha North, carrying a token. */
  async function approvedOrder(input: { fulfillmentStatus?: string; organizationId?: number; branchId?: number; status?: string; groupOrderId?: number } = {}): Promise<number> {
    seeded += 1
    const [row] = await db
      .insert(orders)
      .values({
        tid: `${SEEDED_TID_PREFIX}${f.suffix}-${seeded}`.slice(0, 26),
        organizationId: input.organizationId ?? f.organizationId,
        branchId: input.branchId ?? f.alphaNorthId,
        createdByUserId: f.requesterId,
        status: input.status ?? "APPROVED",
        fulfillmentStatus: input.fulfillmentStatus ?? "NOT_STARTED",
        approvalToken: `TEOTOKEN${seeded}`,
        groupOrderId: input.groupOrderId ?? null,
        createdAt: SEEDED_CREATED_AT,
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      })
      .returning({ id: orders.id })
    return row.id
  }

  const send = async (orderId: number, actor: Actor = requester()) => {
    signIn(actor)
    const response = await sendTokenRoute.POST(
      new NextRequest(`http://localhost/api/v1/orders/${orderId}/send-token-email`, { method: "POST" }),
      { params: Promise.resolve({ id: String(orderId) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  const sendGroup = async (groupOrderId: number) => {
    signIn(requester())
    const response = await groupTokensRoute.POST(
      new NextRequest(`http://localhost/api/v1/group-portal/orders/${groupOrderId}/tokens`, { method: "POST" }),
      { params: Promise.resolve({ groupOrderId: String(groupOrderId) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  const handoffOf = async (orderId: number) => {
    const [row] = await db
      .select({
        at: orders.tokenHandoffAt,
        by: orders.tokenHandoffByUserId,
        status: orders.status,
        fulfilledBy: orders.fulfilledByUserId,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
    return row
  }

  beforeAll(async () => {
    f = await createGroupRoleFixtures()
  })

  afterAll(async () => {
    if (!f) return
    await db.delete(orders).where(like(orders.tid, `${SEEDED_TID_PREFIX}${f.suffix}%`))
    if (envelopeIds.length > 0) await db.delete(groupOrders).where(inArray(groupOrders.id, envelopeIds))
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    sendOrderTokenEmail.mockReset()
    sendOrderTokenEmail.mockResolvedValue(undefined)
    sendGroupOrderTokensEmail.mockReset()
    sendGroupOrderTokensEmail.mockResolvedValue(undefined)
    settlementFault.remaining = 0
    await db.delete(orders).where(and(
      inArray(orders.organizationId, [f.organizationId, f.foreignOrganizationId]),
      like(orders.tid, `${SEEDED_TID_PREFIX}%`),
    ))
  })

  it("sends the first time and refuses the second, without emailing again", async () => {
    const orderId = await approvedOrder()

    const first = await send(orderId)
    expect(first.status).toBe(200)
    expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
    expect(await handoffOf(orderId)).toMatchObject({ by: f.requesterId })
    expect((await handoffOf(orderId)).at).not.toBeNull()

    const second = await send(orderId)
    expect(second.status).toBe(409)
    expect(second.body.code).toBe(TOKEN_ALREADY_SENT_CODE)
    expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
  })

  it("holds across actors: the approver cannot re-send a token the raiser already sent", async () => {
    const orderId = await approvedOrder()
    expect((await send(orderId, requester())).status).toBe(200)

    const byApprover = await send(orderId, approver())
    expect(byApprover.status).toBe(409)
    expect(byApprover.body.code).toBe(TOKEN_ALREADY_SENT_CODE)
    expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
    // The record still names the first sender.
    expect(await handoffOf(orderId)).toMatchObject({ by: f.requesterId })
  })

  it("still settles a delivered order on its one send", async () => {
    const orderId = await approvedOrder({ fulfillmentStatus: "DELIVERED" })

    const first = await send(orderId)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ fulfilled: true, status: "FULFILLED" })
    expect((await handoffOf(orderId)).status).toBe("FULFILLED")
  })

  it("records nothing when the email fails, so the send can be retried", async () => {
    const orderId = await approvedOrder()
    sendOrderTokenEmail.mockRejectedValueOnce(new Error("SES throttled"))

    const failed = await send(orderId)
    expect(failed.status).toBe(400)
    expect((await handoffOf(orderId)).at).toBeNull()

    const retried = await send(orderId)
    expect(retried.status).toBe(200)
    expect(sendOrderTokenEmail).toHaveBeenCalledTimes(2)
    expect((await handoffOf(orderId)).at).not.toBeNull()
  })

  it("emails once when two sends race for the same order", async () => {
    const orderId = await approvedOrder()
    let release: () => void = () => undefined
    const stalled = new Promise<void>((resolve) => { release = resolve })
    let entered: () => void = () => undefined
    const firstEntered = new Promise<void>((resolve) => { entered = resolve })
    sendOrderTokenEmail.mockImplementationOnce(async () => {
      entered()
      await stalled
    })

    const first = send(orderId, requester())
    await firstEntered
    // The first send is mid-email, holding the order's lock.
    const second = await send(orderId, approver())
    release()

    expect(second.status).toBe(409)
    expect((await first).status).toBe(200)
    expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
  })

  it("tells the raiser an order fulfilled elsewhere has moved on, rather than refusing access", async () => {
    const orderId = await approvedOrder({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })

    // The requester holds a token only while the order is approved; a stale
    // screen still offering the send is told where the order went.
    for (const actor of [requester(), approver()]) {
      const refused = await send(orderId, actor)
      expect(refused.status).toBe(409)
      expect(refused.body).toMatchObject({ code: TOKEN_ORDER_NOT_APPROVED_CODE, status: "FULFILLED" })
      expect(refused.body.error).toContain("already been fulfilled")
    }
    expect(sendOrderTokenEmail).not.toHaveBeenCalled()
  })

  it("discloses nothing about a moved-on order to someone outside it", async () => {
    const orderId = await approvedOrder({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })

    const refused = await send(orderId, unassignedApprover())
    expect(refused.status).toBe(403)
    expect(refused.body.status).toBeUndefined()
    expect(refused.body.code).toBeUndefined()
  })

  describe("a settlement that fails after the token has gone", () => {
    const retryAudits = async (orderId: number) => db
      .select({ action: auditLogs.action, userId: auditLogs.userId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, String(orderId)), eq(auditLogs.action, "RETRY_ORDER_TOKEN_FULFILMENT")))

    it("tells the sender, and a retry settles the order without emailing the token again", async () => {
      const orderId = await approvedOrder({ fulfillmentStatus: "DELIVERED" })
      settlementFault.remaining = 1

      const first = await send(orderId)
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({
        fulfilled: false,
        awaitingDelivery: false,
        settlementFailed: true,
        code: TOKEN_SETTLEMENT_FAILED_CODE,
        status: "APPROVED",
      })
      expect(first.body.message).toContain("could not be marked fulfilled")
      expect(await handoffOf(orderId)).toMatchObject({ status: "APPROVED", by: f.requesterId })

      // Retried by the approver: still credited to the person who handed it over.
      const retried = await send(orderId, approver())
      expect(retried.status).toBe(200)
      expect(retried.body).toMatchObject({ fulfilled: true, retried: true, status: "FULFILLED", settlementFailed: false })
      expect(await handoffOf(orderId)).toMatchObject({ status: "FULFILLED", fulfilledBy: f.requesterId })
      expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
      expect(await retryAudits(orderId)).toEqual([
        expect.objectContaining({ userId: f.approverId, metadata: expect.objectContaining({ fulfilled: true }) }),
      ])

      // Once settled, a further press is the ordinary refusal.
      const after = await send(orderId)
      expect(after.status).toBe(409)
      expect(after.body.code).toBe(TOKEN_ORDER_NOT_APPROVED_CODE)
    })

    it("answers a retry that fails again with 503, and keeps the retry on offer", async () => {
      const orderId = await approvedOrder({ fulfillmentStatus: "DELIVERED" })
      settlementFault.remaining = 2

      expect((await send(orderId)).body.settlementFailed).toBe(true)

      const failedAgain = await send(orderId)
      expect(failedAgain.status).toBe(503)
      expect(failedAgain.body).toMatchObject({ code: TOKEN_SETTLEMENT_FAILED_CODE, retried: true })
      expect((await handoffOf(orderId)).status).toBe("APPROVED")

      const settled = await send(orderId)
      expect(settled.status).toBe(200)
      expect(settled.body.fulfilled).toBe(true)
      expect(sendOrderTokenEmail).toHaveBeenCalledTimes(1)
      expect((await retryAudits(orderId)).map((row) => (row.metadata as { fulfilled: boolean }).fulfilled).sort())
        .toEqual([false, true])
    })

    it("never offers a retry for an order that is only waiting on its delivery", async () => {
      const orderId = await approvedOrder({ fulfillmentStatus: "OUT_FOR_DELIVERY" })
      expect((await send(orderId)).body.awaitingDelivery).toBe(true)

      const again = await send(orderId)
      expect(again.status).toBe(409)
      expect(again.body.code).toBe(TOKEN_ALREADY_SENT_CODE)
      expect((await handoffOf(orderId)).status).toBe("APPROVED")
      expect(await retryAudits(orderId)).toEqual([])
    })

    it("lets nobody outside the order retry it", async () => {
      const orderId = await approvedOrder({ fulfillmentStatus: "DELIVERED" })
      settlementFault.remaining = 1
      expect((await send(orderId)).body.settlementFailed).toBe(true)

      const outsider = await send(orderId, unassignedApprover())
      expect(outsider.status).toBe(403)
      expect((await handoffOf(orderId)).status).toBe("APPROVED")
      expect(await retryAudits(orderId)).toEqual([])
    })

    it("reports a group hand-off's failed orders, and the next press retries only those", async () => {
      // An envelope of its own, so the shared fixture's branch orders are neither sent nor counted.
      const [envelope] = await db
        .insert(groupOrders)
        .values({
          reference: `GRP-TEO-${f.suffix}`,
          organizationId: f.organizationId,
          groupId: f.alphaGroupId,
          createdByUserId: f.requesterId,
          idempotencyKey: `it-teo-${f.suffix}`,
          requestFingerprint: "teo".repeat(22).slice(0, 64),
          requestedBranchCount: 2,
          createdOrderCount: 2,
        })
        .returning({ id: groupOrders.id })
      envelopeIds.push(envelope.id)
      const firstId = await approvedOrder({ fulfillmentStatus: "DELIVERED", groupOrderId: envelope.id })
      const secondId = await approvedOrder({ fulfillmentStatus: "DELIVERED", groupOrderId: envelope.id })
      settlementFault.remaining = 1

      const first = await sendGroup(envelope.id)
      expect(first.status).toBe(200)
      expect(first.body).toMatchObject({
        sentCount: 2,
        fulfilledCount: 1,
        failedCount: 1,
        settlementFailed: true,
        code: TOKEN_SETTLEMENT_FAILED_CODE,
      })
      const statuses = [(await handoffOf(firstId)).status, (await handoffOf(secondId)).status].sort()
      expect(statuses).toEqual(["APPROVED", "FULFILLED"])

      const retried = await sendGroup(envelope.id)
      expect(retried.status).toBe(200)
      expect(retried.body).toMatchObject({ sentCount: 0, fulfilledCount: 1, failedCount: 0, retried: true })
      expect((await handoffOf(firstId)).status).toBe("FULFILLED")
      expect((await handoffOf(secondId)).status).toBe("FULFILLED")
      expect(sendGroupOrderTokensEmail).toHaveBeenCalledTimes(1)
    })
  })

  describe("the store guard, for a set of orders", () => {
    const targetOf = (orderId: number, organizationId = f.organizationId, branchId = f.alphaNorthId) =>
      ({ orderId, organizationId, branchId })

    it("hands the send step only the orders whose token has not gone", async () => {
      const sentId = await approvedOrder()
      const unsentId = await approvedOrder()
      expect((await send(sentId)).status).toBe(200)

      const seen: number[][] = []
      const outcome = await sendTokenEmailOncePerOrder(
        [targetOf(sentId), targetOf(unsentId)],
        f.requesterId,
        async (unsent) => {
          seen.push([...unsent])
          return { delivered: true }
        },
      )

      expect(seen).toEqual([[unsentId]])
      expect(outcome).toEqual({ outcome: "sent", orderIds: new Set([unsentId]) })
      expect((await handoffOf(unsentId)).at).not.toBeNull()
    })

    it("sends nothing when every token has already gone", async () => {
      const orderId = await approvedOrder()
      expect((await send(orderId)).status).toBe(200)

      const sendStep = vi.fn(async () => ({ delivered: true as const }))
      const outcome = await sendTokenEmailOncePerOrder([targetOf(orderId)], f.requesterId, sendStep)

      expect(outcome).toEqual({ outcome: "already-sent" })
      expect(sendStep).not.toHaveBeenCalled()
    })

    it("never reaches an order outside the tenant and branch it was given", async () => {
      const orderId = await approvedOrder()

      const sendStep = vi.fn(async () => ({ delivered: true as const }))
      const outcome = await sendTokenEmailOncePerOrder(
        [targetOf(orderId, f.foreignOrganizationId, f.foreignBranchId)],
        f.requesterId,
        sendStep,
      )

      expect(outcome).toEqual({ outcome: "already-sent" })
      expect(sendStep).not.toHaveBeenCalled()
      expect((await handoffOf(orderId)).at).toBeNull()
    })
  })
})
