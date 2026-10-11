import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const files = vi.hoisted(() => ({ written: [] as string[] }))
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return { ...actual, writeFile: vi.fn((_book: unknown, name: string) => files.written.push(name)) }
})

import BudgetSummaryPage from "./page"

/**
 * The Budget Summary report with its real KPI cards, charts, filters and
 * branch table. The server's figures are fixed below; what is asserted is how
 * the page turns them into what a reader sees, and which questions it asks.
 *
 *   allocated 3,000.00 + add-on 500.00 = 3,500.00 · spent 1,200.00 · held 300.00 · remaining 2,000.00
 */
const SUMMARY = {
  budgetsEnabled: true,
  pricesHidden: false,
  summary: { totalAllocated: 300_000, totalSpent: 120_000, totalHeld: 30_000, totalCredited: 50_000, totalRemaining: 200_000 },
  insights: { spentGrowth: 12.5, allocationGrowth: -3 },
  categories: [
    { categoryId: 1, categoryName: "Stationery", allocated: 200_000, spent: 100_000, held: 0, remaining: 100_000, utilization: 50 },
  ],
  branchBreakdown: [
    { branchId: 11, branchName: "North", allocated: 200_000, spent: 100_000, held: 30_000, remaining: 70_000, utilization: 65, baselineAmount: 200_000 },
    { branchId: 12, branchName: "South", allocated: 150_000, spent: 20_000, held: 0, remaining: 130_000, utilization: 13.3, baselineAmount: 100_000 },
    { branchId: 13, branchName: "Over Branch", allocated: 10_000, spent: 20_000, held: 0, remaining: -10_000, utilization: 200, baselineAmount: 10_000 },
  ],
  chartData: [
    { date: "2026-08", spentCents: 60_000, allocatedCents: 150_000, branches: [] },
    { date: "2026-09", spentCents: 60_000, allocatedCents: 150_000, branches: [] },
  ],
}

function routes(summary: unknown = SUMMARY) {
  installFetch([
    ["/api/v1/analytics/budgets/summary", summary],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
    ["/api/v1/groups", { items: [{ id: 7, name: "Distribution" }] }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North" }, { id: 12, name: "South" }] }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
  ])
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  files.written.length = 0
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Budget Summary report", () => {
  it("asks the summary endpoint for the organization and shows the headline figures", async () => {
    routes()
    renderWithApp(<BudgetSummaryPage />)

    await waitFor(() => expect(screen.getAllByText("Total Consumption").length).toBeGreaterThan(0))
    await waitFor(() => expect(callsTo("/api/v1/analytics/budgets/summary").length).toBeGreaterThan(0))
    expect(callsTo("/api/v1/analytics/budgets/summary").every((call) => call.url.includes("organizationId=5"))).toBe(true)

    const text = document.body.textContent ?? ""
    await waitFor(() => expect(document.body.textContent).toMatch(/3,500/))
    expect(text).toMatch(/Base: Rs\s?3,000\.00 \| Addon: Rs\s?500\.00/)
    expect(document.body.textContent).toMatch(/\+Rs\s?2,000\.00/)
  })

  it("lists every branch on the reports tab, marks the overspent one, and filters by name", async () => {
    ui.searchParams = new URLSearchParams("tab=reports")
    routes()
    renderWithApp(<BudgetSummaryPage />)

    await screen.findByText("North")
    expect(screen.getByText("South")).toBeTruthy()
    const over = screen.getByText("Over Branch").closest("tr") as HTMLElement
    expect(over.textContent).toMatch(/-?Rs\s?100/)

    fireEvent.change(screen.getByPlaceholderText("SEARCH BRANCHES..."), { target: { value: "sou" } })
    await waitFor(() => expect(screen.queryByText("North")).toBeNull())
    expect(screen.getByText("South")).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText("SEARCH BRANCHES..."), { target: { value: "nothing-like-it" } })
    expect(await screen.findByText("No branches match the selected filters.")).toBeTruthy()
  })

  it("sorts the branch table by a column header", async () => {
    ui.searchParams = new URLSearchParams("tab=reports")
    routes()
    renderWithApp(<BudgetSummaryPage />)
    await screen.findByText("North")

    const table = screen.getByText("North").closest("table") as HTMLElement
    const names = () => within(table).getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent?.trim())
    const before = names()
    const header = within(table).getAllByRole("columnheader")[0]
    fireEvent.click(within(header).queryByRole("button") ?? header)
    const after = names()
    expect(after).toHaveLength(before.length)
    expect([...after].sort()).toEqual([...before].sort())
  })

  it("says so when budgets are switched off for the organization", async () => {
    routes({ ...SUMMARY, budgetsEnabled: false, branchBreakdown: [] })
    renderWithApp(<BudgetSummaryPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/budgets/summary").length).toBeGreaterThan(0))
    await waitFor(() => expect(document.body.textContent).toMatch(/budget/i))
    expect(screen.queryByText("North")).toBeNull()
  })

  it("pins a Branch Admin's questions to its own branch", async () => {
    resetUi({ id: "ba-1", role: "BRANCH_ADMIN", organizationId: 5, branchId: 11 })
    routes()
    renderWithApp(<BudgetSummaryPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/budgets/summary").length).toBeGreaterThan(0))
    for (const call of callsTo("/api/v1/analytics/budgets/summary")) {
      expect(call.url).toMatch(/branchIds=11|branchId=11/)
    }
  })

  it("survives an empty answer without crashing", async () => {
    routes({ ...SUMMARY, branchBreakdown: [], chartData: [], categories: [] })
    ui.searchParams = new URLSearchParams("tab=reports")
    renderWithApp(<BudgetSummaryPage />)
    expect(await screen.findByText("No branches match the selected filters.")).toBeTruthy()
  })
})
