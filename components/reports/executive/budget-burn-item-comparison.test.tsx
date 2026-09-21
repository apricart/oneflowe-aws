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
      current: { startDate: "2026-07-31T19:00:00.000Z", endDate: "2026-08-31T18:59:59.999Z", complete: true },
      prior: { month: "2026-07", startDate: "2026-06-30T19:00:00.000Z", endDate: "2026-07-31T18:59:59.999Z" },
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
    expect(screen.getByText(/August 2026 against the same window in July 2026/)).toBeTruthy()
    const table = screen.getByRole("table")
    expect(within(table).getByText("A4 Paper")).toBeTruthy()
    expect(within(table).getByText("15")).toBeTruthy()
    expect(within(table).getByText("10")).toBeTruthy()
    expect(within(table).getByText("+5")).toBeTruthy()
    expect(within(table).getByText("+50.0%")).toBeTruthy()
    expect(screen.getAllByText("Rs 2,250")).toHaveLength(2)
    expect(screen.getAllByText("Rs 602")).toHaveLength(2)
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
