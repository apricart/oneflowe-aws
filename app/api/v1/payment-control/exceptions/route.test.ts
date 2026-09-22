import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The grant handler: a branch id and an optional reason in, the branch's
 * new state out. The actor, the tenant and the window are never the body's.
 * The grant itself runs against Postgres in
 * `tests/integration/payment-control-api.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  currentRole: null as string | null,
  getRequestScope: vi.fn(),
  withRateLimit: vi.fn(),
  grantPaymentControlException: vi.fn(),
  resolveBranchPaymentControl: vi.fn(),
  logError: vi.fn(),
  branchRows: [] as unknown[],
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    requireApiRole: vi.fn(async (allowed: string[]) => {
      if (!mocks.currentRole) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      if (!allowed.includes(mocks.currentRole)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      return null
    }),
  }
})
vi.mock("@/lib/auth", () => ({ getRequestScope: mocks.getRequestScope }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))
vi.mock("@/lib/db", () => ({
  db: {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ tag: "tx" }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.branchRows }) }) }),
  },
}))
vi.mock("@/lib/server/payment-control", () => ({
  grantPaymentControlException: mocks.grantPaymentControlException,
  resolveBranchPaymentControl: mocks.resolveBranchPaymentControl,
}))

import { POST } from "./route"

const HO_USER = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const NOW = new Date("2026-09-21T09:00:00.000Z")

const exceptionRecord = () => ({
  id: 41,
  organizationId: 10,
  branchId: 5,
  startAt: NOW,
  expiresAt: new Date("2026-10-21T09:00:00.000Z"),
  revokedAt: null,
  grantedByUserId: HO_USER,
  grantedByName: "Head Office",
  reason: "Cheque in transit",
  revokedByUserId: null,
  revokeReason: null,
})

const blockedStatus = (exception: ReturnType<typeof exceptionRecord> | null) => ({
  state: "BLOCKED",
  orderingAllowed: exception !== null,
  reason: exception ? "EXCEPTION_ACTIVE" : "THRESHOLD_REACHED",
  configured: true,
  overdueCount: 2,
  threshold: 2,
  limitReached: true,
  overdueItems: [],
  blockedSince: null,
  exception,
  exceptionActive: exception !== null,
  timeline: [],
  evaluatedAt: NOW,
})

function signIn(role: string | null, scope: Partial<{ organizationId: number | null; branchId: number | null }> = {}) {
  mocks.currentRole = role
  mocks.getRequestScope.mockResolvedValue(role ? { role, userId: HO_USER, organizationId: 10, branchId: null, ...scope } : null)
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/payment-control/exceptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.getRequestScope.mockReset()
  mocks.withRateLimit.mockReset().mockResolvedValue(null)
  mocks.grantPaymentControlException.mockReset().mockResolvedValue({
    kind: "granted",
    exception: exceptionRecord(),
    stateBefore: blockedStatus(null),
  })
  mocks.resolveBranchPaymentControl.mockReset().mockResolvedValue(blockedStatus(exceptionRecord()))
  mocks.logError.mockReset()
  mocks.branchRows = [{ id: 5, organizationId: 10, name: "North" }]
  signIn("HEAD_OFFICE")
})

describe("POST /api/v1/payment-control/exceptions — guards", () => {
  it("refuses without a session", async () => {
    signIn(null)
    expect((await POST(post({ branchId: 5 }))).status).toBe(401)
    expect(mocks.grantPaymentControlException).not.toHaveBeenCalled()
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"])(
    "%s may not grant — a branch never lifts its own block",
    async (role) => {
      signIn(role, { branchId: 5 })
      expect((await POST(post({ branchId: 5 }))).status).toBe(403)
      expect(mocks.grantPaymentControlException).not.toHaveBeenCalled()
    },
  )

  it("rate limits on the sensitive bucket per user before reading the body", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ error: "Too many requests" }, { status: 429 }))
    expect((await POST(post({ branchId: 5 }))).status).toBe(429)
    expect(mocks.withRateLimit).toHaveBeenCalledWith("sensitive", HO_USER)
    expect(mocks.grantPaymentControlException).not.toHaveBeenCalled()
  })

  it("Head Office with no organization on the session cannot act", async () => {
    signIn("HEAD_OFFICE", { organizationId: null })
    expect((await POST(post({ branchId: 5 }))).status).toBe(400)
    expect(mocks.grantPaymentControlException).not.toHaveBeenCalled()
  })
})

describe("POST /api/v1/payment-control/exceptions — body", () => {
  it.each([
    ["no branch", {}],
    ["a non-numeric branch", { branchId: "north" }],
    ["a zero branch", { branchId: 0 }],
    ["an expiry the server never asked for", { branchId: 5, expiresAt: "2099-01-01T00:00:00Z" }],
    ["a start", { branchId: 5, startAt: "2026-01-01T00:00:00Z" }],
    ["an organization", { branchId: 5, organizationId: 2 }],
    ["an actor", { branchId: 5, grantedByUserId: "someone-else" }],
    ["a reason over 1000 characters", { branchId: 5, reason: "x".repeat(1_001) }],
  ])("rejects a body with %s, granting nothing", async (_label, body) => {
    expect((await POST(post(body))).status).toBe(400)
    expect(mocks.grantPaymentControlException).not.toHaveBeenCalled()
  })

  it("names the unexpected field so a mass-assignment attempt is legible", async () => {
    await expect((await POST(post({ branchId: 5, expiresAt: "2099-01-01" }))).json()).resolves.toEqual({ error: "Unknown field: expiresAt" })
  })
})

describe("POST /api/v1/payment-control/exceptions — grant", () => {
  it("Head Office grants inside its own tenant, pinned from the session, with the actor from the session", async () => {
    const response = await POST(post({ branchId: 5, reason: "Cheque in transit" }))

    expect(response.status).toBe(201)
    expect(mocks.grantPaymentControlException).toHaveBeenCalledTimes(1)
    expect(mocks.grantPaymentControlException).toHaveBeenCalledWith({ tag: "tx" }, expect.objectContaining({
      branchId: 5,
      organizationId: 10,
      actor: { userId: HO_USER, role: "HEAD_OFFICE" },
      reason: "Cheque in transit",
    }))
    const payload = await response.json()
    expect(payload.branch).toEqual({ id: 5, name: "North" })
    expect(payload.exception).toMatchObject({ id: 41, active: true, reason: "Cheque in transit", grantedBy: { userId: HO_USER, name: "Head Office" } })
    expect(payload.orderingAllowed).toBe(true)
    expect(payload.canManageExceptions).toBe(true)
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0")
  })

  it("Super Admin is not fenced to a tenant", async () => {
    signIn("SUPER_ADMIN", { organizationId: null })
    await POST(post({ branchId: 5 }))
    expect(mocks.grantPaymentControlException).toHaveBeenCalledWith({ tag: "tx" }, expect.objectContaining({ organizationId: null, reason: null }))
  })

  it("an empty reason is stored as none", async () => {
    await POST(post({ branchId: 5, reason: "   " }))
    expect(mocks.grantPaymentControlException).toHaveBeenCalledWith({ tag: "tx" }, expect.objectContaining({ reason: null }))
  })

  it("a branch outside the tenant is a 404, not a 403 — its existence is not confirmed", async () => {
    mocks.grantPaymentControlException.mockResolvedValue({ kind: "branch_not_found" })
    expect((await POST(post({ branchId: 99 }))).status).toBe(404)
  })

  it("a second live exception is a 409 that shows the one in force", async () => {
    mocks.grantPaymentControlException.mockResolvedValue({ kind: "conflict", exception: exceptionRecord() })
    const response = await POST(post({ branchId: 5 }))
    expect(response.status).toBe(409)
    const payload = await response.json()
    expect(payload.error).toBe("An exception is already in force for this branch")
    expect(payload.exception).toMatchObject({ id: 41, active: true })
  })

  it("an unexpected failure is a generic 500 with the detail logged, never the message", async () => {
    mocks.grantPaymentControlException.mockRejectedValue(new Error("relation payment_control_exceptions does not exist"))
    const response = await POST(post({ branchId: 5 }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.not.toMatchObject({ error: expect.stringContaining("relation") })
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "PAYMENT_CONTROL_EXCEPTION_GRANT")
  })
})
