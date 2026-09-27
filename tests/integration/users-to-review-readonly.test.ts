import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  role: "HEAD_OFFICE",
  loadCreatorMonth: vi.fn(),
  loadBranchBudgets: vi.fn(),
  loadScopedBranches: vi.fn(),
  resolveExecutiveScope: vi.fn(),
}))

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: "head-office-1", role: mocks.role } })),
}))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/server/budget-burn-queries", () => ({
  budgetFiltersFor: (window: unknown) => window,
  loadCreatorMonth: mocks.loadCreatorMonth,
}))
vi.mock("@/lib/server/executive-analytics-queries", () => ({
  loadBranchBudgets: mocks.loadBranchBudgets,
}))
vi.mock("@/lib/server/executive-analytics-scope", () => ({
  loadScopedBranches: mocks.loadScopedBranches,
  resolveExecutiveScope: mocks.resolveExecutiveScope,
}))

import * as budgetBurnRoute from "@/app/api/v1/analytics/executive/budget-burn/route"

function requester(overrides: Record<string, unknown> = {}) {
  return {
    userId: "requester-1",
    branchId: 7,
    role: "ORDER_PORTAL",
    requesterName: "Requester One",
    employeeId: "E-1",
    accountStatus: "ACTIVE",
    spendCents: 0,
    pendingCents: 0,
    orderCount: 0,
    pendingOrderCount: 0,
    rejectedOrderCount: 0,
    recentConsumedCents: 0,
    ...overrides,
  }
}

function branchAdmin(overrides: Record<string, unknown> = {}) {
  return requester({
    userId: "branch-admin-1",
    role: "BRANCH_ADMIN",
    requesterName: "Branch Admin",
    employeeId: "BA-1",
    ...overrides,
  })
}

async function call(query = "month=2026-08") {
  const response = await budgetBurnRoute.GET(
    new NextRequest(`http://localhost/api/v1/analytics/executive/budget-burn?${query}`),
  )
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role = "HEAD_OFFICE"
  mocks.resolveExecutiveScope.mockImplementation(async (_session, params: URLSearchParams) => ({
    ok: true,
    role: mocks.role,
    userId: "head-office-1",
    organizationIds: [11],
    branchIds: params.get("branchIds") ? [7] : null,
  }))
  mocks.loadScopedBranches.mockResolvedValue([{ id: 7, name: "Main Branch" }])
  mocks.loadBranchBudgets.mockResolvedValue([{
    branchId: 7,
    totalBudgetCents: 2_000_000,
    remainingCents: 1_000_000,
  }])
  mocks.loadCreatorMonth.mockImplementation(async (_scope, window: { start: Date }) => {
    const month = new Date(window.start.getTime() + (5 * 60 * 60 * 1000)).toISOString().slice(0, 7)
    if (month === "2026-06") return [requester({ spendCents: 500_000, orderCount: 1 })]
    if (month === "2026-07") return [requester({ spendCents: 600_000, orderCount: 1 })]
    return [
      requester({
        spendCents: 700_000,
        pendingCents: 100_000,
        orderCount: 2,
        pendingOrderCount: 1,
        recentConsumedCents: 200_000,
      }),
      branchAdmin({ spendCents: 200_000, orderCount: 1 }),
    ]
  })
})

describe("Users to review read-only route integration", () => {
  it("reconciles the three month values, current branch share, and MoM percentage", async () => {
    const { status, body } = await call("month=2026-08&organizationIds=11&groupIds=3&branchIds=7")

    expect(status).toBe(200)
    expect(body.scope).toEqual({ role: "HEAD_OFFICE", organizationIds: [11], branchCount: 1 })
    expect(body.windows.pattern.map((bucket: { month: string }) => bucket.month)).toEqual([
      "2026-06", "2026-07", "2026-08",
    ])
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]).toMatchObject({
      userId: "requester-1",
      requesterName: "Requester One",
      branchId: 7,
      branchName: "Main Branch",
      metrics: {
        consumedCents: 800_000,
        spendCents: 700_000,
        pendingCents: 100_000,
        shareOfBranchPct: 80,
        momFlagged: true,
        orderCount: 2,
        pendingOrderCount: 1,
      },
    })
    expect(body.rows[0].metrics.months.map((month: { consumedCents: number }) => month.consumedCents)).toEqual([
      500_000, 600_000, 800_000,
    ])
    expect(body.rows[0].metrics.momPct).toBeCloseTo(33.3333, 3)
    expect(body.branches[0]).toMatchObject({
      branchId: 7,
      consumedCents: 1_000_000,
      otherCreatorsConsumedCents: 200_000,
    })
    expect(body.requesterCount).toBe(1)
    expect(body.highlightedCount).toBe(1)

    const params = mocks.resolveExecutiveScope.mock.calls[0][1] as URLSearchParams
    expect(params.get("organizationIds")).toBe("11")
    expect(params.get("groupIds")).toBe("3")
    expect(params.get("branchIds")).toBe("7")
  })

  it("fails closed for a role outside the watchlist allowlist before loading values", async () => {
    mocks.role = "GROUP_USER"
    const { status, body } = await call()

    expect(status).toBe(403)
    expect(body.error).toBe("Forbidden: Insufficient permissions")
    expect(mocks.loadCreatorMonth).not.toHaveBeenCalled()
    expect(mocks.loadBranchBudgets).not.toHaveBeenCalled()
    expect(mocks.loadScopedBranches).not.toHaveBeenCalled()
  })
})
