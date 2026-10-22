import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return { ...actual, writeFile: vi.fn() }
})

import BranchReportsPage from "./page"

/**
 * The Branch report, fed the four shapes its endpoint returns
 * (`summaryOnly`, `trendOnly`, `allTime`, and the item list), rendered with its
 * real tabs, KPI cards and table.
 */
function routes(items = [
  { id: 11, name: "North Branch", status: "active", organizationName: "Acme", groupName: "Distribution", totalOrders: 20, fulfilledOrders: 18, revenue: 200_000, refunds: 0 },
  { id: 12, name: "South Branch", status: "inactive", organizationName: "Acme", groupName: null, totalOrders: 5, fulfilledOrders: 5, revenue: 50_000, refunds: 1_000 },
]) {
  installFetch([
    ["/api/v1/analytics/branches/performance", (url: URL) => {
      if (url.searchParams.get("allTime") === "true") return { years: [2026, 2025] }
      if (url.searchParams.get("summaryOnly") === "true") {
        return { summary: { totalOrders: 25, totalRevenue: 250_000, totalRefunds: 1_000, activeBranches: 1 }, comparison: null }
      }
      if (url.searchParams.get("trendOnly") === "true") {
        return { trend: [{ date: "2026-09", revenue: 250_000, orders: 25 }], compareTrend: [] }
      }
      return { items }
    }],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
    ["/api/v1/groups", { items: [] }],
    ["/api/v1/branches", { items: [] }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
  ])
}

async function openTab(name: RegExp) {
  const tab = await screen.findByRole("tab", { name })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Branch report", () => {
  it("asks for the organization's figures in all four shapes", async () => {
    routes()
    renderWithApp(<BranchReportsPage />)
    await waitFor(() => {
      const urls = callsTo("/api/v1/analytics/branches/performance").map((call) => call.url)
      expect(urls.some((url) => url.includes("summaryOnly=true"))).toBe(true)
      expect(urls.some((url) => url.includes("trendOnly=true"))).toBe(true)
      expect(urls.some((url) => url.includes("allTime=true"))).toBe(true)
    })
    expect(callsTo("/api/v1/analytics/branches/performance").every((call) => call.url.includes("organizationId=5"))).toBe(true)
  })

  it("lists branches in the report and filters them by name", async () => {
    routes()
    renderWithApp(<BranchReportsPage />)
    await openTab(/Reports?/i)

    await waitFor(() => expect(screen.getAllByText("North Branch").length).toBeGreaterThan(0))
    expect(screen.getAllByText("South Branch").length).toBeGreaterThan(0)

    fireEvent.change(screen.getByPlaceholderText("Search branches..."), { target: { value: "south" } })
    await waitFor(() => expect(screen.queryAllByText("North Branch")).toHaveLength(0))
    expect(screen.getAllByText("South Branch").length).toBeGreaterThan(0)
  })

  it("renders an empty report", async () => {
    routes([])
    renderWithApp(<BranchReportsPage />)
    await openTab(/Reports?/i)
    await waitFor(() => expect(callsTo("/api/v1/analytics/branches/performance").length).toBeGreaterThan(2))
    expect(screen.queryAllByText("North Branch")).toHaveLength(0)
  })

  it("labels each branch's type and rolls children up under their parent", async () => {
    routes([
      { id: 21, name: "Head Branch", status: "active", hierarchyRole: "PARENT", parentBranchId: null, parentBranchName: null, organizationName: "Acme", groupName: null, totalOrders: 2, fulfilledOrders: 2, revenue: 10_000, refunds: 0 },
      { id: 22, name: "Kid Branch", status: "active", hierarchyRole: "CHILD", parentBranchId: 21, parentBranchName: "Head Branch", organizationName: "Acme", groupName: null, totalOrders: 3, fulfilledOrders: 1, revenue: 5_000, refunds: 0 },
      { id: 23, name: "Lone Branch", status: "active", hierarchyRole: "STANDALONE", parentBranchId: null, parentBranchName: null, organizationName: "Acme", groupName: null, totalOrders: 1, fulfilledOrders: 1, revenue: 1_000, refunds: 0 },
    ] as any)
    renderWithApp(<BranchReportsPage />)
    await openTab(/Reports?/i)

    await waitFor(() => expect(screen.getAllByText("Kid Branch").length).toBeGreaterThan(0))
    expect(screen.getAllByText("Child of Head Branch").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Parent branch").length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole("switch", { name: "Roll up by parent" }))
    await waitFor(() => expect(screen.queryAllByText("Kid Branch")).toHaveLength(0))
    expect(screen.getAllByText("Parent + 1 child branch").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Lone Branch").length).toBeGreaterThan(0)
    // Head Branch's own 2 orders plus its child's 3.
    expect(screen.getByText("2 rows listed")).toBeTruthy()
    expect(screen.getAllByText("3 / 5").length).toBeGreaterThan(0)
  })

  it("narrows by branch type or parent only once one is chosen", async () => {
    routes()
    renderWithApp(<BranchReportsPage />)
    await openTab(/Reports?/i)
    await waitFor(() => expect(screen.getAllByText("North Branch").length).toBeGreaterThan(0))
    expect(callsTo("/api/v1/analytics/branches/performance").some((call) => /hierarchyRoles|parentBranchIds/.test(call.url))).toBe(false)
  })

  it("keeps a Branch Admin to its own branch", async () => {
    resetUi({ id: "ba", role: "BRANCH_ADMIN", organizationId: 5, branchId: 11 })
    routes()
    renderWithApp(<BranchReportsPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/branches/performance").length).toBeGreaterThan(0))
    expect(callsTo("/api/v1/analytics/branches/performance").every((call) => /branchIds?=11/.test(call.url))).toBe(true)
  })
})
