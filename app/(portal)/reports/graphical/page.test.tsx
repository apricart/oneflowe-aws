import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The Graphical Reports page: who gets a page at all, and how the three levels
 * are reached.
 *
 * The role check here only decides what renders — every endpoint behind the
 * page re-derives the caller's role from the database and refuses on its own
 * (see `tests/integration/executive-analytics-api.test.ts`). So the assertions
 * here are about the reader's experience: an unauthorised role is told why,
 * and the Compare Side by Side tab mounts the workspace with the shared filters.
 */

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  useAPI: vi.fn(),
}))

vi.mock("next-auth/react", () => ({ useSession: mocks.useSession }))
vi.mock("@/lib/hooks/use-api", () => ({ useAPI: mocks.useAPI }))
vi.mock("@/components/reports/executive/executive-filters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/reports/executive/executive-filters")>()
  return { ...actual, ExecutiveFilters: ({ value }: any) => <div data-testid="filters">{value.startDate}</div> }
})
vi.mock("@/components/reports/executive/side-by-side-workspace", () => ({
  SideBySideWorkspace: ({ filters }: any) => <div data-testid="side-by-side">{filters.branchIds.join(",") || "all"}</div>,
}))
vi.mock("@/components/reports/executive/explore-workspace", () => ({
  ExploreWorkspace: () => <div data-testid="explore" />,
}))
vi.mock("@/components/reports/executive/overview-charts", () => ({
  BudgetVsActualChart: () => null,
  ProcurementTrendChart: () => null,
  UtilizationRankingChart: () => null,
  CategoryParetoChart: () => null,
  BranchCategoryHeatmap: () => null,
  StatusCompositionChart: () => null,
  PriceVariancePanel: () => null,
}))
vi.mock("@/components/reports/executive/summary-panels", () => ({
  KpiRow: () => <div data-testid="kpis" />,
  AttentionList: () => null,
}))

import GraphicalReportsPage from "./page"
import { toCalendarDate } from "@/components/reports/quick-date-range"

function signIn(role: string | null, status: "authenticated" | "loading" = "authenticated") {
  mocks.useSession.mockReturnValue({ status, data: role ? { user: { role } } : null })
}

beforeEach(() => {
  mocks.useAPI.mockReset()
  mocks.useAPI.mockReturnValue({ data: undefined, error: undefined, isLoading: false })
})

describe("who gets the page", () => {
  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL", "GROUP_USER"])(
    "tells %s the report is not available for their role, and fetches nothing",
    (role) => {
      signIn(role)
      render(<GraphicalReportsPage />)
      expect(screen.getByText("Graphical Reports is not available for your role")).toBeTruthy()
      expect(screen.queryByRole("tab")).toBeNull()
      // No request is made on the reader's behalf; the URL is null.
      for (const call of mocks.useAPI.mock.calls) expect(call[0]).toBeNull()
    },
  )

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "head_office"])("gives %s the three levels", (role) => {
    signIn(role)
    render(<GraphicalReportsPage />)
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Executive Overview", "Compare Side by Side", "Explore & Compare",
    ])
    expect(mocks.useAPI).toHaveBeenCalledWith(expect.stringContaining("/api/v1/analytics/executive/overview?"))
  })

  it("shows a loading state while the session is unresolved", () => {
    signIn(null, "loading")
    render(<GraphicalReportsPage />)
    expect(screen.getByText("Loading…")).toBeTruthy()
  })
})

describe("the levels", () => {
  it("opens on the overview and switches to Compare Side by Side with the shared filters", () => {
    signIn("HEAD_OFFICE")
    render(<GraphicalReportsPage />)
    expect(screen.getByTestId("kpis")).toBeTruthy()
    expect(screen.queryByTestId("side-by-side")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "Compare Side by Side" }))
    expect(screen.getByRole("tab", { name: "Compare Side by Side" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("side-by-side").textContent).toBe("all")
    expect(screen.queryByTestId("kpis")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "Explore & Compare" }))
    expect(screen.getByTestId("explore")).toBeTruthy()
    expect(screen.queryByTestId("side-by-side")).toBeNull()
  })

  it("keeps the same filter row above every level, opening on this quarter", () => {
    signIn("SUPER_ADMIN")
    render(<GraphicalReportsPage />)
    const quarterStart = new Date()
    quarterStart.setMonth(Math.floor(quarterStart.getMonth() / 3) * 3, 1)
    const expected = toCalendarDate(quarterStart)
    expect(screen.getByTestId("filters").textContent).toBe(expected)
    fireEvent.click(screen.getByRole("tab", { name: "Compare Side by Side" }))
    expect(screen.getByTestId("filters").textContent).toBe(expected)
  })

  it("surfaces a failed overview request without hiding the tabs", () => {
    signIn("HEAD_OFFICE")
    mocks.useAPI.mockReturnValue({ data: undefined, error: new Error("boom"), isLoading: false })
    render(<GraphicalReportsPage />)
    expect(screen.getByText(/The analytics could not be loaded/)).toBeTruthy()
    expect(screen.getAllByRole("tab")).toHaveLength(3)
  })
})
