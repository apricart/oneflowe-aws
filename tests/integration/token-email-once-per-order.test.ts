import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, like } from "drizzle-orm"

import * as sendTokenRoute from "@/app/api/v1/orders/[id]/send-token-email/route"
import { orders } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import * as mockedEmail from "@/lib/email"
import { TOKEN_ALREADY_SENT_CODE, TOKEN_ORDER_NOT_APPROVED_CODE } from "@/lib/order-token-handoff"
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
  return { ...actual, sendOrderTokenEmail: vi.fn(async () => undefined) }
})

const { getServerSession } = mockedNextAuth
const sendOrderTokenEmail = vi.mocked(mockedEmail.sendOrderTokenEmail)

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

  const requester = (): Actor => ({ id: f.requesterId, email: `rq-${f.suffix}@example.test`, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId })
  const approver = (): Actor => ({ id: f.approverId, email: `ap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })
  const unassignedApprover = (): Actor => ({ id: f.emptyApproverId, email: `eap-${f.suffix}@example.test`, role: "GROUP_USER", organizationId: f.organizationId })

  /** An approved order raised by the requester at Alpha North, carrying a token. */
  async function approvedOrder(input: { fulfillmentStatus?: string; organizationId?: number; branchId?: number; status?: string } = {}): Promise<number> {
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

  const handoffOf = async (orderId: number) => {
    const [row] = await db
      .select({ at: orders.tokenHandoffAt, by: orders.tokenHandoffByUserId, status: orders.status })
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
    await destroyGroupRoleFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    sendOrderTokenEmail.mockReset()
    sendOrderTokenEmail.mockResolvedValue(undefined)
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
