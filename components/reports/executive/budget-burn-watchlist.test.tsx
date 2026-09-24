import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BUDGET_BURN_DEFAULT_ROWS,
  BUDGET_BURN_REASON_LABELS,
  BUDGET_BURN_THRESHOLDS,
  currentAppMonth,
} from "@/lib/budget-burn-risk"

/**
 * The "Users to review" panel.
 *
 * What matters here is the request it makes — scope filters only, the month,
 * the bounded limit — and what a click hands the drill-down, because a table
 * asking a different question from the one it drills into is the failure this
 * panel must never have. The figures come from the server and are covered by
 * the integration suite.
 */

const requested: string[] = []
let response: any = null
let loading = false
let failed = false

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url) requested.push(url)
    return { data: response, error: failed ? new Error("boom") : null, isLoading: loading }
  },
}))

import {
  BudgetBurnDrillNote,
  BudgetBurnWatchlist,
  NOT_PROOF_COPY,
  SCOPE_NOTE_COPY,
  drillFiltersFor,
  monthLabel,
  monthRangeLabel,
  reasonExplanation,
  type BudgetBurnDrillSelection,
  type BudgetBurnItemDrillSelection,
  type BudgetBurnResponse,
  type BudgetBurnRow,
} from "./budget-burn-watchlist"

const filters = {
  startDate: "2026-03-01",
  endDate: "2026-09-12",
  organizationIds: ["3"],
  groupIds: ["4"],
  branchIds: ["7", "9"],
  categoryIds: ["21"],
  productIds: ["186"],
  userIds: ["6ec33598-9ec2-4a1a-86df-cd0801ee0178"],
}

const AHMED = "0f0b3c1e-9a3d-4d47-8e2a-6a3f0e9b5c11"

const windows: BudgetBurnResponse["windows"] = {
  // 1 Aug 00:00 +05:00 … 31 Aug 23:59:59.999 +05:00
  current: { startDate: "2026-07-31T19:00:00.000Z", endDate: "2026-08-31T18:59:59.999Z", complete: true, elapsedDays: 31, daysInMonth: 31 },
  // Jun–Aug against Mar–May, both whole months because August is over.
  trend: {
    months: 3,
    current: { startMonth: "2026-06", endMonth: "2026-08", startDate: "2026-05-31T19:00:00.000Z", endDate: "2026-08-31T18:59:59.999Z" },
    prior: { startMonth: "2026-03", endMonth: "2026-05", startDate: "2026-02-28T19:00:00.000Z", endDate: "2026-05-31T18:59:59.999Z" },
  },
  recent: { startDate: "2026-08-24T18:59:59.999Z", endDate: "2026-08-31T18:59:59.999Z" },
}

const row = (over: Partial<BudgetBurnRow> = {}): BudgetBurnRow => ({
  userId: AHMED,
  requesterName: "Ahmed Raza",
  employeeId: "7712",
  role: "ORDER_PORTAL",
  accountStatus: "ACTIVE" as const,
  branchId: 12,
  branchName: "GSMP-KKI",
  score: 7,
  reasons: ["high_share", "trend_spike", "late_surge"],
  metrics: {
    spendCents: 220_000_000,
    pendingCents: 5_000_000,
    consumedCents: 225_000_000,
    shareOfBranchPct: 95.66,
    trendPct: 273.75,
    trendConsumedCents: 225_000_000,
    priorTrendConsumedCents: 60_200_000,
    branchUtilizationPct: 78.4,
    vsPeerPct: null,
    peerBranchMedianUtilizationPct: null,
    recentSharePct: 62.2,
    orderCount: 2,
    pendingOrderCount: 1,
    rejectedOrderCount: 0,
  },
  ...over,
})

function respond(over: Partial<BudgetBurnResponse> = {}) {
  response = {
    month: "2026-08",
    windows,
    rows: [row()],
    branches: [],
    flaggedCount: 1,
    unflaggedCount: 14,
    limit: BUDGET_BURN_DEFAULT_ROWS,
    truncated: false,
    thresholds: BUDGET_BURN_THRESHOLDS,
    reasonLabels: BUDGET_BURN_REASON_LABELS,
    ...over,
  }
}

function lastRequest(): URLSearchParams {
  return new URL(`http://localhost${requested.at(-1)!.replace(/^\/api/, "/api")}`).searchParams
}

beforeEach(() => {
  requested.length = 0
  response = null
  loading = false
  failed = false
})

describe("the request", () => {
  it("sends the scope filters, the current month and the bounded limit — and nothing else", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    const params = lastRequest()
    expect(requested.at(-1)!.startsWith("/api/v1/analytics/executive/budget-burn?")).toBe(true)
    expect(params.get("organizationIds")).toBe("3")
    expect(params.get("groupIds")).toBe("4")
    expect(params.get("branchIds")).toBe("7,9")
    expect(params.get("month")).toBe(currentAppMonth(new Date()))
    expect(params.get("limit")).toBe(String(BUDGET_BURN_DEFAULT_ROWS))
    for (const dropped of ["startDate", "endDate", "categoryIds", "productIds", "userIds", "unit"]) {
      expect(params.has(dropped), dropped).toBe(false)
    }
  })

  it("steps back a month and asks again; the current month is the ceiling", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Previous month" }))
    const [year, month] = currentAppMonth(new Date()).split("-").map(Number)
    const previous = new Date(Date.UTC(year, month - 2, 1))
    expect(lastRequest().get("month")).toBe(`${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`)
    expect((screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe("what the reader sees", () => {
  it("carries the review copy and the scope note", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(NOT_PROOF_COPY)).toBeTruthy()
    expect(screen.getByText(SCOPE_NOTE_COPY, { exact: false })).toBeTruthy()
    // The growth column is the one figure that is not the selected month, so
    // the panel names both of its ranges rather than leaving it implied.
    expect(screen.getByText(/The 3M column compares Jun 2026–Aug 2026 against Mar 2026–May 2026/)).toBeTruthy()
    expect(screen.getByText(/every other figure is the month alone/)).toBeTruthy()
  })

  it("renders each flagged row with its figures and a chip per reason", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    const table = screen.getByRole("table")
    expect(within(table).getByRole("button", { name: "Ahmed Raza" })).toBeTruthy()
    expect(within(table).getByText("GSMP-KKI")).toBeTruthy()
    expect(within(table).getByText("95.7%")).toBeTruthy()
    expect(within(table).getByText("+274%")).toBeTruthy()
    // No peer figure is a dash, not a zero.
    expect(within(table).getAllByText("—").length).toBeGreaterThan(0)
    const chips = within(table).getByRole("list", { name: "Why flagged" })
    expect(within(chips).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["High share", "+3M", "Late surge"])
    // Every chip explains its threshold.
    expect(within(chips).getByText("High share").getAttribute("title")).toContain(`${BUDGET_BURN_THRESHOLDS.highSharePct}%`)
    expect(screen.getByText(/Showing 1 of 1 flagged · 14 below the review score of 4/)).toBeTruthy()
  })

  it("shows the empty state with the count below the line", () => {
    respond({ rows: [], flaggedCount: 0, unflaggedCount: 31 })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText("Nothing to review")).toBeTruthy()
    expect(screen.getByText(/31 requesters consumed budget; none reached the review score of 4/)).toBeTruthy()
    expect(screen.queryByRole("table")).toBeNull()
  })

  it("says so when nobody consumed anything", () => {
    respond({ rows: [], flaggedCount: 0, unflaggedCount: 0 })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(/No requester consumed budget/)).toBeTruthy()
  })

  it("shows a skeleton while loading and a safe message on failure", () => {
    loading = true
    const { unmount } = render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.queryByText("Nothing to review")).toBeNull()
    unmount()

    loading = false
    failed = true
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(/could not be loaded/)).toBeTruthy()
    expect(screen.queryByText("boom")).toBeNull()
  })

  it("warns when the read hit its cap", () => {
    respond({ truncated: true })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(/hit its row cap/)).toBeTruthy()
  })

  it("names the pending and rejected counts beside the order count", () => {
    respond({ rows: [row({ metrics: { ...row().metrics, orderCount: 0, pendingOrderCount: 1, rejectedOrderCount: 3 } })] })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText("0 · 1 pending · 3 rej.")).toBeTruthy()
  })

  it("marks a retired account", () => {
    respond({ rows: [row({ accountStatus: "INACTIVE" })] })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(/7712 · order portal · inactive/)).toBeTruthy()
  })
})

describe("the drill hand-off", () => {
  it("names the requester and the row's branch for the month, and clears every non-scope filter", () => {
    respond()
    const onDrill = vi.fn<(selection: BudgetBurnDrillSelection) => void>()
    render(<BudgetBurnWatchlist filters={filters} onDrill={onDrill} />)
    fireEvent.click(screen.getByRole("button", { name: "Ahmed Raza" }))

    expect(onDrill).toHaveBeenCalledTimes(1)
    const selection = onDrill.mock.calls[0][0]
    expect(selection.target).toEqual({
      dimension: "user",
      key: AHMED,
      label: "Ahmed Raza",
      narrow: { branchIds: ["12"] },
    })
    // The month as the date-only strings the drill-down parses in Karachi.
    expect(selection.filters.startDate).toBe("2026-08-01")
    expect(selection.filters.endDate).toBe("2026-08-31")
    expect(selection.filters.categoryIds).toEqual([])
    expect(selection.filters.productIds).toEqual([])
    expect(selection.filters.userIds).toEqual([])
    expect("unit" in selection.filters).toBe(false)
    // Scope travels unchanged; the row's branch overrides it through `narrow`.
    expect(selection.filters.organizationIds).toEqual(["3"])
    expect(selection.filters.groupIds).toEqual(["4"])
    expect(selection.filters.branchIds).toEqual(["7", "9"])
    // The row's figure is Spend + Pending, so the listing must include pending orders.
    expect(selection.statuses).toBe("consumed")
    expect(selection.spendCents).toBe(220_000_000)
    expect(selection.pendingCents).toBe(5_000_000)
    expect(selection.pendingOrderCount).toBe(1)
    expect(selection.month).toBe("2026-08")
  })

  it("marks the row whose drill-down is open", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} selectedKey={`${AHMED}:12`} />)
    expect(screen.getByRole("button", { name: "Ahmed Raza" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("opens an item-wise comparison from the growth value without changing the name drill", () => {
    respond()
    const onDrill = vi.fn<(selection: BudgetBurnDrillSelection) => void>()
    const onDrillItems = vi.fn<(selection: BudgetBurnItemDrillSelection) => void>()
    render(
      <BudgetBurnWatchlist
        filters={filters}
        onDrill={onDrill}
        onDrillItems={onDrillItems}
        selectedItemsKey={`${AHMED}:12:2026-08`}
      />,
    )

    const button = screen.getByRole("button", { name: "Compare Ahmed Raza items over 3 months" })
    expect(button.textContent).toBe("+274%")
    // The tooltip carries both runs of months and both totals, because the
    // percentage is not a ratio of the Spend shown beside it.
    const title = button.getAttribute("title") ?? ""
    expect(title).toContain("Jun 2026–Aug 2026")
    expect(title).toContain("Mar 2026–May 2026")
    expect(button.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(button)
    expect(onDrillItems).toHaveBeenCalledWith({
      userId: AHMED,
      branchId: 12,
      requesterName: "Ahmed Raza",
      branchName: "GSMP-KKI",
      month: "2026-08",
    })
    expect(onDrill).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Ahmed Raza" }))
    expect(onDrill).toHaveBeenCalledTimes(1)
  })

  it("turns a month-to-date window into today's date, in Karachi", () => {
    const mtd = {
      ...windows,
      current: { ...windows.current, endDate: "2026-09-19T21:30:00.000Z", complete: false, elapsedDays: 20, daysInMonth: 30 },
    }
    // 21:30 UTC on the 19th is 02:30 on the 20th in Karachi.
    expect(drillFiltersFor(filters, mtd).endDate).toBe("2026-09-20")
  })
})

describe("the note above the drill-down", () => {
  const selection: BudgetBurnDrillSelection = {
    target: { dimension: "user", key: AHMED, label: "Ahmed Raza", narrow: { branchIds: ["12"] } },
    filters,
    statuses: "consumed",
    month: "2026-08",
    requesterName: "Ahmed Raza",
    branchName: "GSMP-KKI",
    spendCents: 220_000_000,
    pendingCents: 5_000_000,
    pendingOrderCount: 1,
  }

  it("states the sum the lines add up to and which part of it is only pending", () => {
    render(<BudgetBurnDrillNote selection={selection} onClose={vi.fn()} />)
    // 220,000,000 + 5,000,000 cents = Rs 2,250,000 — the consumed figure, not the spend.
    expect(screen.getByText("Rs 2,250,000")).toBeTruthy()
    expect(screen.getByText(/plus 1 pending order totalling/)).toBeTruthy()
    expect(screen.getByText(/marked pending below/)).toBeTruthy()
    expect(screen.getByText(/Nothing pending is counted until it is approved/)).toBeTruthy()
  })

  it("says plainly when nothing is pending, and closes", () => {
    const onClose = vi.fn()
    render(<BudgetBurnDrillNote selection={{ ...selection, pendingCents: 0, pendingOrderCount: 0 }} onClose={onClose} />)
    expect(screen.getByText(/no pending orders/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe("labels", () => {
  it("names the month in words", () => {
    expect(monthLabel("2026-08")).toBe("August 2026")
    expect(monthLabel("2026-01")).toBe("January 2026")
  })

  it("names a run of months on both ends, so a run across a year is unambiguous", () => {
    expect(monthRangeLabel("2026-06", "2026-08")).toBe("Jun 2026–Aug 2026")
    expect(monthRangeLabel("2025-11", "2026-01")).toBe("Nov 2025–Jan 2026")
    // A run of one is just the month, spelled out.
    expect(monthRangeLabel("2026-08", "2026-08")).toBe("August 2026")
  })

  it("explains every reason with its own threshold", () => {
    const t = BUDGET_BURN_THRESHOLDS
    expect(reasonExplanation("high_share", t)).toContain(`${t.highSharePct}%`)
    expect(reasonExplanation("trend_spike", t)).toContain(`+${t.trendSpikePct}%`)
    expect(reasonExplanation("trend_spike", t)).toContain("previous 3 months")
    expect(reasonExplanation("above_peers", t)).toContain(`${t.abovePeersPct}%`)
    expect(reasonExplanation("above_peers", t)).toContain("other branches in scope")
    expect(reasonExplanation("late_surge", t)).toContain(`${t.lateSurgeDays} days`)
    expect(reasonExplanation("high_held", t)).toContain(`${t.highHeldPctOfBudget}%`)
    expect(reasonExplanation("rejected_orders", t)).toContain(String(t.rejectedOrdersMin))
  })
})
