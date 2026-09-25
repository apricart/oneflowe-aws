import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { BUDGET_BURN_THRESHOLDS } from "@/lib/budget-burn-risk"

const requested: string[] = []
let response: any = null
let loading = false
let failed = false

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url) requested.push(url)
    return { data: response, error: failed ? new Error("secret failure") : null, isLoading: loading }
  },
}))

import { BudgetBurnItemComparisonPanel } from "./budget-burn-item-comparison"
import { HIGHLIGHT_MARKER } from "./budget-burn-watchlist"

const selection = {
  userId: "0f0b3c1e-9a3d-4d47-8e2a-6a3f0e9b5c11",
  branchId: 12,
  requesterName: "Ahmed Raza",
  branchName: "GSMP-KKI",
  month: "2026-08",
}

const months = ["2026-06", "2026-07", "2026-08"]

const itemMonths = (values: Array<[number, number]>) =>
  values.map(([quantity, spendCents], index) => ({ month: months[index], quantity, spendCents, orderCount: 1 }))

function respond(overrides: Record<string, unknown> = {}) {
  response = {
    userId: selection.userId,
    branchId: selection.branchId,
    month: selection.month,
    windows: {
      // The same three buckets the row above was drawn from.
      pattern: months.map((month, index) => ({
        month,
        startDate: `2026-0${6 + index}-01T00:00:00.000Z`,
        endDate: `2026-0${6 + index}-28T00:00:00.000Z`,
        complete: true,
      })),
    },
    items: [
      {
        productId: 9,
        productName: "A4 Paper",
        unit: "Ream",
        months: itemMonths([[10, 5_000], [5, 602_000], [102, 2_250_000]]),
        momPct: 273.75,
        momFlagged: true,
      },
      {
        productId: 4,
        productName: "Toner",
        unit: "Piece",
        months: itemMonths([[2, 6_000], [0, 0], [0, 0]]),
        momPct: null,
        momFlagged: false,
      },
    ],
    monthTotals: [
      { month: "2026-06", quantity: 12, spendCents: 11_000, orderCount: 2 },
      { month: "2026-07", quantity: 5, spendCents: 602_000, orderCount: 1 },
      { month: "2026-08", quantity: 102, spendCents: 2_250_000, orderCount: 1 },
    ],
    truncated: false,
    ...overrides,
  }
}

beforeEach(() => {
  requested.length = 0
  response = null
  loading = false
  failed = false
})

describe("budget-burn item comparison panel", () => {
  it("requests one requester, branch and month, and renders a column per month", () => {
    respond()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)

    const url = new URL(`http://localhost${requested.at(-1)}`)
    expect(url.pathname).toBe("/api/v1/analytics/executive/budget-burn/item-comparison")
    expect(url.searchParams.get("userId")).toBe(selection.userId)
    expect(url.searchParams.get("branchIds")).toBe("12")
    expect(url.searchParams.get("month")).toBe("2026-08")

    expect(screen.getByRole("heading", { name: /Item-wise 3-month consumption/ })).toBeTruthy()
    expect(screen.getByText(/Ahmed Raza at GSMP-KKI: Jun 2026–Aug 2026, month by month/)).toBeTruthy()
    const table = screen.getByRole("table")
    // The columns name the months, never "this month" / "last month".
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Product", "Unit", "Jun 2026", "Jul 2026", "Aug 2026", "vs prev month",
    ])
    expect(within(table).getByText("A4 Paper")).toBeTruthy()
    expect(within(table).getByText("Toner")).toBeTruthy()
  })

  it("states the rule behind a highlight and never rests it on colour", () => {
    respond()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.getByText(new RegExp(`at least ${BUDGET_BURN_THRESHOLDS.momSpikePct}% above the previous month`))).toBeTruthy()

    const rows = within(screen.getByRole("table")).getAllByRole("row")
    // The spiking product's newest month and its percentage both carry a marker.
    const paper = rows.find((row) => row.textContent?.includes("A4 Paper"))!
    expect(paper.textContent).toContain(HIGHLIGHT_MARKER)
    expect(paper.textContent).toContain("+273.8%")
    // The one that stopped carries no marker and a dash for "no baseline".
    const toner = rows.find((row) => row.textContent?.includes("Toner"))!
    expect(toner.textContent).not.toContain(HIGHLIGHT_MARKER)
    expect(toner.textContent).toContain("—")
  })

  it("shows the money per month with the quantity beneath it, and the per-month totals", () => {
    respond()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    const table = screen.getByRole("table")
    expect(within(table).getByText("qty 10")).toBeTruthy()
    expect(within(table).getByText("qty 102")).toBeTruthy()
    // The totals are what the month cells on the row above must equal.
    expect(screen.getByText("June 2026")).toBeTruthy()
    expect(screen.getByText("August 2026")).toBeTruthy()
    expect(screen.getAllByText("Rs 110").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Rs 22,500").length).toBeGreaterThan(0)
  })

  it("shows loading, empty, safe error and truncation states", () => {
    loading = true
    const { unmount } = render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.queryByRole("table")).toBeNull()
    unmount()

    loading = false
    respond({ items: [], monthTotals: [] })
    const empty = render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.getByText(/No consumed items were found/)).toBeTruthy()
    empty.unmount()

    response = null
    failed = true
    const error = render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    expect(screen.queryByText("secret failure")).toBeNull()
    error.unmount()

    failed = false
    respond({ truncated: true })
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.getByText(/hit its row cap/)).toBeTruthy()
  })

  it("draws its heading before the response lands, from the month it was opened for", () => {
    loading = true
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.getByRole("heading", { name: /Item-wise 3-month consumption/ })).toBeTruthy()
    expect(screen.getByText(/Jun 2026–Aug 2026/)).toBeTruthy()
  })

  it("closes on request", () => {
    respond()
    const onClose = vi.fn()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: /Close/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
