import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BUDGET_BURN_DEFAULT_ROWS,
  BUDGET_BURN_THRESHOLDS,
  currentAppMonth,
} from "@/lib/budget-burn-risk"

/**
 * The "Users to review" panel.
 *
 * What matters here is the request it makes — scope filters only, the month,
 * the bounded limit — what a click hands the drill-down, and that the
 * highlight is never carried by colour alone. A table asking a different
 * question from the one it drills into is the failure this panel must never
 * have. The figures come from the server and are covered by the integration
 * suite.
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
  HIGHLIGHT_MARKER,
  NOT_PROOF_COPY,
  SCOPE_NOTE_COPY,
  drillFiltersFor,
  highlightNote,
  momCellTitle,
  monthLabel,
  monthRangeLabel,
  shortMonthLabel,
  type BudgetBurnDrillSelection,
  type BudgetBurnItemDrillSelection,
  type BudgetBurnResponse,
  type BudgetBurnRow,
} from "./budget-burn-watchlist"
import { money } from "./chart-kit"

/**
 * `money` separates "Rs" from the amount with a non-breaking space. Testing
 * Library normalizes it inside `getByText`, but an accessible name matched by
 * regex, and a raw `toContain`, do not — so expected amounts are built from
 * the formatter itself rather than typed out.
 */
function rsPattern(cents: number): string {
  return money(cents).replace(/[\u00a0 ]/g, "\\s")
}

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
  // June, July, August — all whole months because August is over.
  pattern: [
    { month: "2026-06", startDate: "2026-05-31T19:00:00.000Z", endDate: "2026-06-30T18:59:59.999Z", complete: true },
    { month: "2026-07", startDate: "2026-06-30T19:00:00.000Z", endDate: "2026-07-31T18:59:59.999Z", complete: true },
    { month: "2026-08", startDate: "2026-07-31T19:00:00.000Z", endDate: "2026-08-31T18:59:59.999Z", complete: true },
  ],
  recent: { startDate: "2026-08-24T18:59:59.999Z", endDate: "2026-08-31T18:59:59.999Z" },
}

/** Ahmed: ₨110 → ₨6,020 → ₨22,500, a highlighted month-over-month rise. */
const row = (over: Partial<BudgetBurnRow> = {}): BudgetBurnRow => ({
  userId: AHMED,
  requesterName: "Ahmed Raza",
  employeeId: "7712",
  role: "ORDER_PORTAL",
  accountStatus: "ACTIVE" as const,
  branchId: 12,
  branchName: "GSMP-KKI",
  metrics: {
    spendCents: 2_200_000,
    pendingCents: 50_000,
    consumedCents: 2_250_000,
    shareOfBranchPct: 95.66,
    months: [
      { month: "2026-06", spendCents: 11_000, pendingCents: 0, consumedCents: 11_000 },
      { month: "2026-07", spendCents: 602_000, pendingCents: 0, consumedCents: 602_000 },
      { month: "2026-08", spendCents: 2_200_000, pendingCents: 50_000, consumedCents: 2_250_000 },
    ],
    momPct: 273.75,
    momFlagged: true,
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

/** The same person, quiet: no highlight, and a previous month too small to read. */
const quietRow = (): BudgetBurnRow => row({
  userId: "quiet-user",
  requesterName: "Sana Iqbal",
  employeeId: "8810",
  branchId: 13,
  branchName: "REGION 2",
  metrics: {
    ...row().metrics,
    spendCents: 1_500,
    pendingCents: 0,
    consumedCents: 1_500,
    months: [
      { month: "2026-06", spendCents: 700_000, pendingCents: 0, consumedCents: 700_000 },
      { month: "2026-07", spendCents: 1_000, pendingCents: 0, consumedCents: 1_000 },
      { month: "2026-08", spendCents: 1_500, pendingCents: 0, consumedCents: 1_500 },
    ],
    momPct: 50,
    momFlagged: false,
    orderCount: 1,
    pendingOrderCount: 0,
    rejectedOrderCount: 0,
  },
})

function respond(over: Partial<BudgetBurnResponse> = {}) {
  response = {
    month: "2026-08",
    windows,
    rows: [row()],
    branches: [],
    highlightedCount: 1,
    requesterCount: 15,
    limit: BUDGET_BURN_DEFAULT_ROWS,
    truncated: false,
    thresholds: BUDGET_BURN_THRESHOLDS,
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
  it("carries the review copy, the scope note and the rule behind the highlight", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText(NOT_PROOF_COPY)).toBeTruthy()
    expect(screen.getByText(SCOPE_NOTE_COPY, { exact: false })).toBeTruthy()
    // A colour with no stated rule is a rumour; the rule is printed.
    expect(screen.getByText(/Jun 2026–Aug 2026 shown, each month on its own/)).toBeTruthy()
    expect(screen.getByText(new RegExp(`at least ${BUDGET_BURN_THRESHOLDS.momSpikePct}% above the previous month`))).toBeTruthy()
    expect(screen.getByText(/from a previous month of at least Rs 5,000/)).toBeTruthy()
  })

  it("names one column per month of the pattern, oldest first", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Requester", "Branch", "Jun 2026", "Jul 2026", "Aug 2026", "vs prev month", "Orders",
    ])
  })

  it("draws each month's consumption and the percentage between the last two", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    const table = screen.getByRole("table")
    expect(within(table).getByRole("button", { name: "Ahmed Raza" })).toBeTruthy()
    expect(within(table).getByText("GSMP-KKI")).toBeTruthy()
    // 11,000 → 602,000 → 2,250,000 cents.
    expect(within(table).getByText(/Rs 110$/)).toBeTruthy()
    expect(within(table).getByText(/Rs 6,020$/)).toBeTruthy()
    expect(within(table).getByText(/Rs 22,500$/)).toBeTruthy()
    // Pending is broken out where it exists, never folded away silently.
    expect(within(table).getByText("incl. Rs 500 pending")).toBeTruthy()
    expect(within(table).getByText(/\+274%/)).toBeTruthy()
    expect(screen.getByText(/Showing 1 of 15 requesters · 1 highlighted/)).toBeTruthy()
  })

  it("never carries the highlight on colour alone", () => {
    respond({ rows: [row(), quietRow()] })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} onDrillItems={vi.fn()} />)

    // The highlighted row's newest month and its percentage both carry a marker.
    const highlighted = screen.getByRole("button", { name: new RegExp(`Ahmed Raza, August 2026: ${rsPattern(2_250_000)} — highlighted`) })
    expect(highlighted.textContent).toContain(HIGHLIGHT_MARKER)
    const percent = screen.getByRole("button", { name: new RegExp(`Ahmed Raza: July 2026: ${rsPattern(602_000)} → August 2026: ${rsPattern(2_250_000)}`) })
    expect(percent.textContent).toContain(HIGHLIGHT_MARKER)
    expect(percent.getAttribute("aria-label")).toContain(`At or above the ${BUDGET_BURN_THRESHOLDS.momSpikePct}% review threshold`)

    // The quiet row carries neither marker nor "highlighted" in its label.
    // `[.]` rather than an escaped dot: the amount is Rs 15 and the sentence
    // ends there, so an unanchored match would also accept Rs 150.
    const quiet = screen.getByRole("button", { name: new RegExp(`Sana Iqbal, August 2026: ${rsPattern(1_500)}[.] Open`) })
    expect(quiet.textContent).not.toContain(HIGHLIGHT_MARKER)
    expect(quiet.getAttribute("aria-label")).not.toContain("highlighted")
  })

  it("lists a requester who consumed nothing in the selected month", () => {
    // The shape the panel exists to show: heavy last month, silent this month.
    const lapsed = row({
      userId: "lapsed-user",
      requesterName: "Faisal Khan",
      metrics: {
        ...row().metrics,
        spendCents: 0, pendingCents: 0, consumedCents: 0,
        months: [
          { month: "2026-06", spendCents: 0, pendingCents: 0, consumedCents: 0 },
          { month: "2026-07", spendCents: 20_000_000, pendingCents: 0, consumedCents: 20_000_000 },
          { month: "2026-08", spendCents: 0, pendingCents: 0, consumedCents: 0 },
        ],
        momPct: -100,
        momFlagged: false,
        orderCount: 0, pendingOrderCount: 0, rejectedOrderCount: 0,
      },
    })
    respond({ rows: [lapsed] })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Faisal Khan" })).toBeTruthy()
    expect(screen.getByRole("button", { name: new RegExp(`Faisal Khan, July 2026: ${rsPattern(20_000_000)}`) })).toBeTruthy()
    expect(screen.getByText("-100%")).toBeTruthy()
  })

  it("shows a dash where there is no previous month to compare against", () => {
    respond({ rows: [row({ metrics: { ...row().metrics, momPct: null, momFlagged: false } })] })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} onDrillItems={vi.fn()} />)
    const percent = screen.getByRole("button", { name: /Ahmed Raza: July 2026/ })
    expect(percent.textContent).toBe("—")
  })

  it("shows the empty state when nobody consumed anything", () => {
    respond({ rows: [], highlightedCount: 0, requesterCount: 0 })
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} />)
    expect(screen.getByText("Nothing to review")).toBeTruthy()
    expect(screen.getByText(/No requester consumed budget/)).toBeTruthy()
    expect(screen.queryByRole("table")).toBeNull()
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
    expect(screen.getByText(/7712 · order initiator · inactive/)).toBeTruthy()
  })
})

describe("the drill hand-off", () => {
  it("drills the selected month from the name, clearing every non-scope filter", () => {
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
    // The cell is Spend + Pending, so the listing must include pending orders.
    expect(selection.statuses).toBe("consumed")
    expect(selection.spendCents).toBe(2_200_000)
    expect(selection.pendingCents).toBe(50_000)
    expect(selection.pendingOrderCount).toBe(1)
    expect(selection.month).toBe("2026-08")
  })

  it("drills an older month from its own cell, on that month's dates", () => {
    respond()
    const onDrill = vi.fn<(selection: BudgetBurnDrillSelection) => void>()
    render(<BudgetBurnWatchlist filters={filters} onDrill={onDrill} />)
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`Ahmed Raza, July 2026: ${rsPattern(602_000)}`) }))

    const selection = onDrill.mock.calls[0][0]
    expect(selection.month).toBe("2026-07")
    expect(selection.filters.startDate).toBe("2026-07-01")
    expect(selection.filters.endDate).toBe("2026-07-31")
    expect(selection.spendCents).toBe(602_000)
    expect(selection.pendingCents).toBe(0)
    // The aggregate counts orders for the selected month only — never invent one.
    expect(selection.pendingOrderCount).toBeNull()
    // The row's branch still narrows the read.
    expect(selection.target.narrow).toEqual({ branchIds: ["12"] })
  })

  it("marks the row whose drill-down is open", () => {
    respond()
    render(<BudgetBurnWatchlist filters={filters} onDrill={vi.fn()} selectedKey={`${AHMED}:12`} />)
    expect(screen.getByRole("button", { name: "Ahmed Raza" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("opens an item-wise comparison from the percentage without changing the name drill", () => {
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

    const button = screen.getByRole("button", { name: new RegExp(`Ahmed Raza: July 2026: ${rsPattern(602_000)} → August 2026: ${rsPattern(2_250_000)}`) })
    expect(button.textContent).toContain("+274%")
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
    // 21:30 UTC on the 19th is 02:30 on the 20th in Karachi.
    const mtd = { startDate: "2026-08-31T19:00:00.000Z", endDate: "2026-09-19T21:30:00.000Z" }
    expect(drillFiltersFor(filters, mtd).startDate).toBe("2026-09-01")
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

  it("states the pending money without a count for an older month", () => {
    render(<BudgetBurnDrillNote selection={{ ...selection, pendingOrderCount: null }} onClose={vi.fn()} />)
    expect(screen.getByText(/plus Rs 50,000 in pending orders/)).toBeTruthy()
    expect(screen.queryByText(/pending order totalling/)).toBeNull()
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
  it("names the month in words, and short for a column head", () => {
    expect(monthLabel("2026-08")).toBe("August 2026")
    expect(monthLabel("2026-01")).toBe("January 2026")
    expect(shortMonthLabel("2026-08")).toBe("Aug 2026")
  })

  it("names a run of months on both ends, so a run across a year is unambiguous", () => {
    expect(monthRangeLabel("2026-06", "2026-08")).toBe("Jun 2026–Aug 2026")
    expect(monthRangeLabel("2025-11", "2026-01")).toBe("Nov 2025–Jan 2026")
    // A run of one is just the month, spelled out.
    expect(monthRangeLabel("2026-08", "2026-08")).toBe("August 2026")
  })

  it("prints the whole rule behind the highlight, thresholds included", () => {
    const note = highlightNote(windows.pattern, BUDGET_BURN_THRESHOLDS)
    expect(note).toContain("Jun 2026–Aug 2026")
    expect(note).toContain(`${BUDGET_BURN_THRESHOLDS.momSpikePct}%`)
    expect(note).toContain(money(BUDGET_BURN_THRESHOLDS.momMinBaselineCents))
  })

  it("explains a percentage by naming both months, both amounts and the verdict", () => {
    const flagged = momCellTitle(row().metrics, BUDGET_BURN_THRESHOLDS)
    expect(flagged).toContain(`July 2026: ${money(602_000)}`)
    expect(flagged).toContain(`August 2026: ${money(2_250_000)}`)
    expect(flagged).toContain("At or above the 15% review threshold")

    const quiet = momCellTitle(quietRow().metrics, BUDGET_BURN_THRESHOLDS)
    expect(quiet).toContain("Below the 15% review threshold")
    // It rose 50%, but off ₨10 — the baseline guard is the reason and says so.
    expect(quiet).toContain(`under the ${money(BUDGET_BURN_THRESHOLDS.momMinBaselineCents)} baseline`)

    const noBaseline = momCellTitle({ ...row().metrics, momPct: null, momFlagged: false }, BUDGET_BURN_THRESHOLDS)
    expect(noBaseline).toContain("no baseline to compare against")
  })
})
