import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The status read: which branch, may this caller see it, and what does the
 * caller get back. The branch fence is the pure access module's
 * (`lib/payment-control-access.test.ts`); this pins that the route applies
 * it, pins the tenant to the session, and redacts for an ordering user.
 */

const mocks = vi.hoisted(() => ({
  currentRole: null as string | null,
  getRequestScope: vi.fn(),
  resolveScopedBranchIds: vi.fn(),
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
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))
vi.mock("@/lib/db", () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.branchRows }) }) }) },
}))
vi.mock("@/lib/server/multi-branch-scope", () => ({ resolveScopedBranchIds: mocks.resolveScopedBranchIds }))
vi.mock("@/lib/server/payment-control", () => ({ resolveBranchPaymentControl: mocks.resolveBranchPaymentControl }))

import { GET } from "./route"

const USER = "3b1a6a3e-1111-4c7b-9a2e-000000000001"
const NOW = new Date("2026-09-21T09:00:00.000Z")

const status = () => ({
  state: "BLOCKED",
  orderingAllowed: true,
  reason: "EXCEPTION_ACTIVE",
  configured: true,
  overdueCount: 2,
  threshold: 2,
  limitReached: true,
  overdueItems: [{ reference: "INV-1", overdueSince: new Date("2026-08-01T00:00:00.000Z"), amountCents: 1000 }],
  blockedSince: null,
  exception: {
    id: 41,
    organizationId: 10,
    branchId: 5,
    startAt: NOW,
    expiresAt: new Date("2026-10-21T09:00:00.000Z"),
    revokedAt: null,
    grantedByUserId: "ho-user",
    grantedByName: "Head Office",
    reason: "Cheque in transit",
    revokedByUserId: null,
    revokeReason: null,
  },
  exceptionActive: true,
  timeline: [
    { key: "exception-granted:41", label: "Head Office exception granted", description: "Cheque in transit", at: NOW, state: "complete" },
    { key: "exception-active", label: "Ordering allowed by exception", description: "...", at: null, state: "current" },
  ],
  evaluatedAt: NOW,
})

function signIn(role: string | null, scope: Partial<{ organizationId: number | null; branchId: number | null }> = {}) {
  mocks.currentRole = role
  mocks.getRequestScope.mockResolvedValue(role ? { role, userId: USER, organizationId: 10, branchId: null, ...scope } : null)
}

const get = (query = "") => GET(new NextRequest(`http://localhost/api/v1/payment-control${query}`))

beforeEach(() => {
  mocks.getRequestScope.mockReset()
  mocks.resolveScopedBranchIds.mockReset().mockResolvedValue([])
  mocks.resolveBranchPaymentControl.mockReset().mockResolvedValue(status())
  mocks.logError.mockReset()
  mocks.branchRows = [{ id: 5, organizationId: 10, name: "North" }]
})

describe("GET /api/v1/payment-control — guards", () => {
  it("refuses without a session", async () => {
    signIn(null)
    expect((await get("?branchId=5")).status).toBe(401)
    expect(mocks.resolveBranchPaymentControl).not.toHaveBeenCalled()
  })

  it.each(["BRANCH_ADMIN", "ORDER_PORTAL"])("%s reads its own branch without naming it, and cannot name another", async (role) => {
    signIn(role, { branchId: 5 })
    expect((await get()).status).toBe(200)
    expect(mocks.resolveBranchPaymentControl).toHaveBeenLastCalledWith(expect.anything(), { organizationId: 10, branchId: 5 })

    expect((await get("?branchId=6")).status).toBe(403)
  })

  it.each(["GROUP_USER", "GROUP_ORDER_PORTAL"])("%s reads only a branch in its resolved assignment set", async (role) => {
    signIn(role)
    mocks.resolveScopedBranchIds.mockResolvedValue([5, 6])
    expect((await get("?branchId=5")).status).toBe(200)
    expect(mocks.resolveScopedBranchIds).toHaveBeenCalledWith(expect.anything(), USER)

    mocks.branchRows = [{ id: 7, organizationId: 10, name: "Elsewhere" }]
    expect((await get("?branchId=7")).status).toBe(403)
  })

  it("a group role with nothing assigned is refused, never widened to the tenant", async () => {
    signIn("GROUP_USER")
    expect((await get("?branchId=5")).status).toBe(403)
    expect(mocks.resolveBranchPaymentControl).not.toHaveBeenCalled()
  })

  it("Head Office must name the branch and it must be in its tenant", async () => {
    signIn("HEAD_OFFICE")
    expect((await get()).status).toBe(400)

    mocks.branchRows = [{ id: 5, organizationId: 2, name: "Foreign" }]
    expect((await get("?branchId=5")).status).toBe(404)
    expect(mocks.resolveBranchPaymentControl).not.toHaveBeenCalled()
  })

  it("a branch that does not exist is a 404", async () => {
    signIn("SUPER_ADMIN", { organizationId: null })
    mocks.branchRows = []
    expect((await get("?branchId=999")).status).toBe(404)
  })

  it("a failure is a generic 500 with the detail logged", async () => {
    signIn("HEAD_OFFICE")
    mocks.resolveBranchPaymentControl.mockRejectedValue(new Error("boom"))
    const response = await get("?branchId=5")
    expect(response.status).toBe(500)
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "PAYMENT_CONTROL_READ")
  })
})

describe("GET /api/v1/payment-control — the payload", () => {
  it("is not shared-cacheable", async () => {
    signIn("HEAD_OFFICE")
    expect((await get("?branchId=5")).headers.get("cache-control")).toBe("private, no-store, max-age=0")
  })

  it("a manager sees who granted the exception and why", async () => {
    signIn("HEAD_OFFICE")
    const payload = await (await get("?branchId=5")).json()
    expect(payload.canManageExceptions).toBe(true)
    expect(payload.exception).toMatchObject({ id: 41, active: true, reason: "Cheque in transit", grantedBy: { userId: "ho-user", name: "Head Office" } })
    expect(payload.timeline[0].description).toBe("Cheque in transit")
  })

  it("an ordering user sees that Head Office allowed ordering and until when — not who or why", async () => {
    signIn("ORDER_PORTAL", { branchId: 5 })
    const payload = await (await get()).json()
    expect(payload.canManageExceptions).toBe(false)
    expect(payload.exception).toMatchObject({ id: 41, active: true, expiresAt: "2026-10-21T09:00:00.000Z", reason: null, grantedBy: null })
    expect(payload.timeline[0].description).toBe("Ordering allowed temporarily despite overdue payments.")
  })

  it("Super Admin manages any tenant's branch", async () => {
    signIn("SUPER_ADMIN", { organizationId: null })
    mocks.branchRows = [{ id: 5, organizationId: 2, name: "Other tenant" }]
    const payload = await (await get("?branchId=5")).json()
    expect(payload.canManageExceptions).toBe(true)
    expect(mocks.resolveBranchPaymentControl).toHaveBeenLastCalledWith(expect.anything(), { organizationId: 2, branchId: 5 })
  })

  it("carries the state, the counts, the limit and the timeline with ISO dates", async () => {
    signIn("HEAD_OFFICE")
    const payload = await (await get("?branchId=5")).json()
    expect(payload).toMatchObject({
      branch: { id: 5, name: "North" },
      state: "BLOCKED",
      orderingAllowed: true,
      reason: "EXCEPTION_ACTIVE",
      configured: true,
      overdueCount: 2,
      threshold: 2,
      limitReached: true,
      overdueItems: [{ reference: "INV-1", overdueSince: "2026-08-01T00:00:00.000Z", amountCents: 1000 }],
      exceptionActive: true,
      evaluatedAt: "2026-09-21T09:00:00.000Z",
    })
    expect(payload.timeline[0].at).toBe("2026-09-21T09:00:00.000Z")
  })
})
