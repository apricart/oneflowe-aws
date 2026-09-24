import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

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

const selection = {
  userId: "0f0b3c1e-9a3d-4d47-8e2a-6a3f0e9b5c11",
  branchId: 12,
  requesterName: "Ahmed Raza",
  branchName: "GSMP-KKI",
  month: "2026-08",
}

function respond(overrides: Record<string, unknown> = {}) {
  response = {
    userId: selection.userId,
    branchId: selection.branchId,
    month: selection.month,
    windows: {
      months: 3,
      // Jun–Aug against Mar–May: the same two windows the 3M figure was built from.
      current: { startMonth: "2026-06", endMonth: "2026-08", startDate: "2026-05-31T19:00:00.000Z", endDate: "2026-08-31T18:59:59.999Z", complete: true },
      prior: { startMonth: "2026-03", endMonth: "2026-05", startDate: "2026-02-28T19:00:00.000Z", endDate: "2026-05-31T18:59:59.999Z" },
    },
    items: [{
      productId: 9,
      productName: "A4 Paper",
      unit: "Ream",
      currentQuantity: 15,
      priorQuantity: 10,
      deltaQuantity: 5,
      deltaPct: 50,
      currentSpendCents: 225_000,
      priorSpendCents: 60_200,
      currentOrderCount: 3,
      priorOrderCount: 2,
    }],
    currentTotalSpendCents: 225_000,
    priorTotalSpendCents: 60_200,
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
  it("requests one requester, branch and month and renders both sides", () => {
    respond()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)

    const url = new URL(`http://localhost${requested.at(-1)}`)
    expect(url.pathname).toBe("/api/v1/analytics/executive/budget-burn/item-comparison")
    expect(url.searchParams.get("userId")).toBe(selection.userId)
    expect(url.searchParams.get("branchIds")).toBe("12")
    expect(url.searchParams.get("month")).toBe("2026-08")

    expect(screen.getByText(/Ahmed Raza at GSMP-KKI/)).toBeTruthy()
    expect(screen.getByText(/Jun 2026–Aug 2026 against the equal-length window before it, Mar 2026–May 2026/)).toBeTruthy()
    expect(screen.getByRole("heading", { name: /Item-wise 3-month comparison/ })).toBeTruthy()
    const table = screen.getByRole("table")
    // The columns name the runs of months, never "this month" / "last month".
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Product", "Unit", "Qty last 3M", "Qty prior 3M", "Δ Qty", "Δ%", "Spend last 3M", "Spend prior 3M",
    ])
    expect(within(table).getByText("A4 Paper")).toBeTruthy()
    expect(within(table).getByText("15")).toBeTruthy()
    expect(within(table).getByText("10")).toBeTruthy()
    expect(within(table).getByText("+5")).toBeTruthy()
    expect(within(table).getByText("+50.0%")).toBeTruthy()
    expect(screen.getAllByText("Rs 2,250")).toHaveLength(2)
    expect(screen.getAllByText("Rs 602")).toHaveLength(2)
    // The two totals are labelled with the ranges they cover, not with a month.
    expect(screen.getByText("Jun 2026–Aug 2026")).toBeTruthy()
    expect(screen.getByText("Mar 2026–May 2026")).toBeTruthy()
  })

  it("shows loading, empty, safe error and truncation states", () => {
    loading = true
    const { unmount } = render(<BudgetBurnItemComparisonPanel selection={selection} onClose={vi.fn()} />)
    expect(screen.queryByRole("table")).toBeNull()
    unmount()

    loading = false
    respond({ items: [], currentTotalSpendCents: 0, priorTotalSpendCents: 0 })
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

  it("closes on request", () => {
    respond()
    const onClose = vi.fn()
    render(<BudgetBurnItemComparisonPanel selection={selection} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: /Close/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
