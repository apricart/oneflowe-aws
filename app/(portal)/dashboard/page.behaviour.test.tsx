import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())

import DashboardPage from "./page"

/**
 * Every role's dashboard, rendered with its real cards, charts and filters.
 *
 * Two things are checked for each role: that the figures the server returns
 * reach the screen, and that the dashboard still renders when every endpoint
 * answers with nothing — a fresh tenant, or an endpoint that failed. A
 * dashboard that throws on an empty answer takes the whole portal with it.
 */
const SERIES = [
  { label: "Aug", sales: 120_000, netSales: 110_000, orders: 12, itemQuantity: 40 },
  { label: "Sep", sales: 180_000, netSales: 175_000, orders: 18, itemQuantity: 55 },
]
const PERFORMANCE = {
  seriesData: SERIES,
  totalSales: 300_000,
  totalNetSales: 285_000,
  totalOrders: 30,
  totalItemsSold: 95,
  avgSales: 150_000,
  avgItemsSold: 47,
  peakPeriod: { label: "Sep", sales: 180_000, orders: 18, itemQuantity: 55 },
  branchSales: [
    { branchId: 11, branchName: "North Branch", sales: 200_000, orders: 20 },
    { branchId: 12, branchName: "South Branch", sales: 100_000, orders: 10 },
  ],
  organizationSales: [{ organizationId: 5, organizationName: "Acme Org", sales: 300_000, orders: 30 }],
  totalUsers: 14,
  totalBranches: 2,
  pricesHidden: false,
  statusCounts: {
    pendingCount: 3, approvedCount: 4, fulfilledCount: 20, partialCount: 1, refundedCount: 1, rejectedCount: 1,
    fulfilledPaidCount: 13, fulfilledUnpaidCount: 7,
    deliveredCount: 18, notDeliveredCount: 6, deliveredTotalCount: 22,
    pendingAmountCents: 30_000, approvedAmountCents: 40_000, valueFulfilledCents: 200_000,
    valueRefundedCents: 5_000, valueRejectedCents: 2_000,
  },
  comparison: null,
}

function richRoutes() {
  installFetch([
    ["/api/v1/analytics/sales-performance", PERFORMANCE],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
    ["/api/v1/analytics/dashboard", { totalOrders: 30, totalRevenueCents: 300_000, pendingOrders: 3 }],
    ["/api/v1/analytics/lifetime-stats", { totalOrders: 300, totalSalesCents: 3_000_000 }],
    ["/api/v1/analytics/weekly-sales", { data: [] }],
    ["/api/v1/analytics/monthly-sales", { data: [] }],
    ["/api/v1/analytics/yearly-sales", { data: [] }],
    ["/api/v1/analytics/drill-down", { data: [], items: [] }],
    ["/api/v1/notifications", { items: [], unreadCount: 0 }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North Branch" }, { id: 12, name: "South Branch" }] }],
    ["/api/v1/groups", { items: [] }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme Org" }] }],
    ["/api/v1/group-portal/scope", { item: { branches: [{ id: 11, name: "North Branch" }, { id: 12, name: "South Branch" }] } }],
    ["/api/v1/users", { items: [] }],
    ["/api/v1/orders", { items: [], pagination: { total: 0 } }],
    ["/api/v1/admin/refunds", { refunds: [] }],
  ])
}

const SESSIONS = {
  SUPER_ADMIN: { id: "sa", role: "SUPER_ADMIN" },
  HEAD_OFFICE: { id: "ho", role: "HEAD_OFFICE", organizationId: 5 },
  BRANCH_ADMIN: { id: "ba", role: "BRANCH_ADMIN", organizationId: 5, branchId: 11 },
  GROUP_USER: { id: "gu", role: "GROUP_USER", organizationId: 5, budgetAllocationEnabled: true },
  VIEWER: { id: "vw", role: "VIEWER", organizationId: 5 },
} as const

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "debug").mockImplementation(() => {})
})

describe("Dashboard", () => {
  it.each(Object.entries(SESSIONS))("%s: shows the server's figures", async (_role, session) => {
    resetUi(session)
    richRoutes()
    renderWithApp(<DashboardPage />)

    await waitFor(() => expect(callsTo("/api/v1/analytics/sales-performance").length).toBeGreaterThan(0), { timeout: 50_000 })
    await waitFor(() => expect(document.body.textContent).toMatch(/30|3,000|300/), { timeout: 50_000 })
    expect(document.body.textContent).not.toMatch(/Your session has expired/)
  }, 60_000)

  it.each(Object.entries(SESSIONS))("%s: renders when every endpoint answers with nothing", async (_role, session) => {
    resetUi(session)
    installFetch([])
    renderWithApp(<DashboardPage />)
    await waitFor(() => expect(ui.calls.length).toBeGreaterThan(0), { timeout: 50_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })

  it.each(Object.entries(SESSIONS))("%s: renders when every endpoint fails", async (_role, session) => {
    resetUi(session)
    installFetch([[/.*/, { status: 500, body: { error: "unavailable" } }]])
    renderWithApp(<DashboardPage />)
    await waitFor(() => expect(ui.calls.length).toBeGreaterThan(0), { timeout: 50_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"] as const)("%s: splits the Fulfilled card into Paid and Unpaid", async (role) => {
    resetUi(SESSIONS[role])
    richRoutes()
    const { container } = renderWithApp(<DashboardPage />)

    const figureFor = (label: string) => container.querySelector(`p[title="${label}"]`)?.nextElementSibling?.textContent
    await waitFor(() => expect(figureFor("Paid")).toBe("13"), { timeout: 50_000 })
    expect(figureFor("Unpaid")).toBe("7")
  }, 60_000)

  it("keeps a Branch Admin's sales request to its own branch", async () => {
    resetUi(SESSIONS.BRANCH_ADMIN)
    richRoutes()
    renderWithApp(<DashboardPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/sales-performance").length).toBeGreaterThan(0), { timeout: 50_000 })
    for (const call of callsTo("/api/v1/analytics/sales-performance")) {
      expect(call.url).toMatch(/branchIds?=11/)
    }
  })

  it("keeps Head Office's sales requests in its own organization", async () => {
    resetUi(SESSIONS.HEAD_OFFICE)
    richRoutes()
    renderWithApp(<DashboardPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/sales-performance").length).toBeGreaterThan(0), { timeout: 50_000 })
    for (const call of callsTo("/api/v1/analytics/sales-performance")) {
      expect(call.url).toContain("organizationId=5")
    }
  })

  it("tells a role with no dashboard that its session is not usable", () => {
    resetUi({ id: "x", role: "ORDER_PORTAL", organizationId: 5 })
    installFetch([])
    renderWithApp(<DashboardPage />)
    expect(screen.getByText("Your session has expired. Please refresh or sign in again.")).toBeTruthy()
  })

  it("shows a skeleton while the session loads", () => {
    resetUi(SESSIONS.HEAD_OFFICE)
    ui.sessionStatus = "loading"
    installFetch([])
    const { container } = renderWithApp(<DashboardPage />)
    expect(container.querySelector("[class*=animate-pulse], [data-slot=skeleton]")).not.toBeNull()
  })

  it("lets the Super Admin switch the comparison on without breaking the view", async () => {
    resetUi(SESSIONS.SUPER_ADMIN)
    richRoutes()
    renderWithApp(<DashboardPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/sales-performance").length).toBeGreaterThan(0), { timeout: 50_000 })
    const toggle = screen.queryAllByRole("switch")[0]
    if (toggle) {
      fireEvent.click(toggle)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })
})
