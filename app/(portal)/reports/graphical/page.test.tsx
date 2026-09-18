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
 * the Product Performance tab mounts the workspace with the shared filters,
 * and the tab is a URL.
 */

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  useAPI: vi.fn(),
}))

/**
 * The router's view of the search params, as a small store.
 *
 * Next patches `window.history.replaceState` so that `useSearchParams` follows
 * it; the test reproduces that by routing the spy below into this store, so a
 * tab click re-renders the page the way it does in the browser.
 */
const location = vi.hoisted(() => {
  let search = ""
  const listeners = new Set<() => void>()
  return {
    get: () => search,
    set(next: string) {
      search = next
      for (const listener of listeners) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
})

vi.mock("next/navigation", async () => {
  const React = await import("react")
  return {
    usePathname: () => "/reports/graphical",
    useSearchParams: () => new URLSearchParams(React.useSyncExternalStore(location.subscribe, location.get)),
  }
})
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

const replaceState = vi.fn<(state: unknown, unused: string, url?: string | URL | null) => void>()

beforeEach(() => {
  mocks.useAPI.mockReset()
  mocks.useAPI.mockReturnValue({ data: undefined, error: undefined, isLoading: false })
  location.set("")
  replaceState.mockReset()
  replaceState.mockImplementation((_state, _unused, url) => {
    location.set(new URL(String(url), "http://x").search)
  })
  window.history.replaceState = replaceState
})

describe("who gets the page", () => {
  it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_ORDER_PORTAL"])(
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

  // The multi-branch approver reads the same three levels over the branches
  // its assignments reach; the endpoints behind them fence every figure.
  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "head_office", "GROUP_USER"])("gives %s the three levels", (role) => {
    signIn(role)
    render(<GraphicalReportsPage />)
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Executive Overview", "Product Performance", "Explore & Compare",
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
  it("opens on the overview and switches to Product Performance with the shared filters", () => {
    signIn("HEAD_OFFICE")
    render(<GraphicalReportsPage />)
    expect(screen.getByTestId("kpis")).toBeTruthy()
    expect(screen.queryByTestId("side-by-side")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "Product Performance" }))
    expect(screen.getByRole("tab", { name: "Product Performance" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("side-by-side").textContent).toBe("all")
    expect(screen.queryByTestId("kpis")).toBeNull()

    fireEvent.click(screen.getByRole("tab", { name: "Explore & Compare" }))
    expect(screen.getByTestId("explore")).toBeTruthy()
    expect(screen.queryByTestId("side-by-side")).toBeNull()
  })

  it("writes the chosen tab to the URL, and clears it for the overview", () => {
    signIn("HEAD_OFFICE")
    render(<GraphicalReportsPage />)

    fireEvent.click(screen.getByRole("tab", { name: "Product Performance" }))
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/reports/graphical?tab=product-performance")

    fireEvent.click(screen.getByRole("tab", { name: "Executive Overview" }))
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/reports/graphical")
    expect(screen.getByTestId("kpis")).toBeTruthy()
  })

  it("opens straight on the tab the URL names, which is what the sidebar entry links to", () => {
    signIn("GROUP_USER")
    location.set("?tab=product-performance")
    render(<GraphicalReportsPage />)
    expect(screen.getByRole("tab", { name: "Product Performance" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("side-by-side")).toBeTruthy()
    expect(screen.queryByTestId("kpis")).toBeNull()
    // Arriving on a tab is not a navigation of its own; nothing is written back.
    expect(replaceState).not.toHaveBeenCalled()
  })

  it("falls back to the overview for a tab the URL names that does not exist", () => {
    signIn("SUPER_ADMIN")
    location.set("?tab=nonsense")
    render(<GraphicalReportsPage />)
    expect(screen.getByRole("tab", { name: "Executive Overview" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("kpis")).toBeTruthy()
  })

  it("keeps the same filter row above every level, opening on this quarter", () => {
    signIn("SUPER_ADMIN")
    render(<GraphicalReportsPage />)
    const quarterStart = new Date()
    quarterStart.setMonth(Math.floor(quarterStart.getMonth() / 3) * 3, 1)
    const expected = toCalendarDate(quarterStart)
    expect(screen.getByTestId("filters").textContent).toBe(expected)
    fireEvent.click(screen.getByRole("tab", { name: "Product Performance" }))
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
