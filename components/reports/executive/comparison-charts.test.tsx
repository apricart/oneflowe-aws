import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import {
  BUDGET_BESIDE_COLOR,
  ComparisonChart,
  SeriesTable,
  budgetShareLabel,
  columnTickLabel,
  columnTicksAngled,
  entityColor,
  type ComparisonRow,
  type EntitySeries,
} from "./comparison-charts"

/**
 * The renderers behind every panel on the Product Performance tab.
 *
 * Recharts draws nothing in jsdom — its ResponsiveContainer measures a box that
 * has no size — so these assert on what surrounds the drawing: the legend, the
 * footnotes that tell a reader how to interpret it, the table forms, and the
 * drill-down each form offers. That is also the path a screen reader takes.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const row = (over: Partial<ComparisonRow>): ComparisonRow => ({
  key: "1",
  label: "North",
  value: 150_000,
  previousValue: 100_000,
  changePct: 50,
  spendCents: 150_000,
  quantity: 30,
  orderCount: 3,
  avgUnitPriceCents: 5_000,
  share: 60,
  cumulativeShare: 60,
  ...over,
})

const rows = [row({}), row({ key: "2", label: "South", value: 100_000, share: 40, cumulativeShare: 100, changePct: null })]

const series: EntitySeries[] = [
  { key: "a", label: "Ahmed", points: [{ period: "2026-07", value: 1_000 }, { period: "2026-08", value: 0 }] },
  { key: "b", label: "Sana", points: [{ period: "2026-07", value: 500 }, { period: "2026-08", value: 700 }] },
]

const base = {
  rows,
  series: [],
  periods: [],
  format: "currency",
  metricLabel: "Procurement Value",
  dimensionLabel: "Branch",
  unit: null,
  concentrationEligible: true,
  dimension: "branch" as const,
}

describe("entity colours", () => {
  it("gives each slot its own hue when colourful and one hue otherwise, cycling past six", () => {
    expect(entityColor(0, true)).not.toBe(entityColor(1, true))
    expect(entityColor(6, true)).toBe(entityColor(0, true))
    expect(entityColor(3, false)).toBe(entityColor(0, false))
  })
})

describe("ranked bars and columns", () => {
  it("lists every entity in the legend with the drill-down hint", () => {
    const onDrillDown = vi.fn()
    render(<ComparisonChart {...base} chart="bar" colorful onDrillDown={onDrillDown} />)
    expect(screen.getByText("North")).toBeTruthy()
    expect(screen.getByText("South")).toBeTruthy()
    expect(screen.getByText("Select any branch to open the order lines behind it, for this same period and these same filters.")).toBeTruthy()
  })

  it("names the metric, not the entities, in a single-hue legend and omits the hint when nothing drills", () => {
    render(<ComparisonChart {...base} chart="column" colorful={false} dimension="month" dimensionLabel="Month" />)
    expect(screen.getByText("Procurement Value")).toBeTruthy()
    expect(screen.queryByText(/Select any/)).toBeNull()
  })

  // Recharts does not draw the axis in jsdom, so the rule that decides how a
  // column's tick is drawn is asserted directly. Upright ticks are for a
  // handful of short names; the twelve product names the Product Performance
  // panels carry, or a single long one, are angled and shortened so they do
  // not overwrite each other — the full name stays in the legend and tooltip.
  it("keeps a handful of short column ticks upright and angles a crowded or long-named axis", () => {
    const short = (count: number) => Array.from({ length: count }, (_, index) => ({ label: `Row ${index}` }))
    expect(columnTicksAngled(short(6))).toBe(false)
    expect(columnTicksAngled(short(7))).toBe(true)
    expect(columnTicksAngled([{ label: "Sugar" }, { label: "Tapal Danedar Teabags (600 PCS)" }])).toBe(true)
    expect(columnTicksAngled([])).toBe(false)
  })

  it("shortens an angled tick with an ellipsis only past the cap, never mid-space", () => {
    expect(columnTickLabel("Nestle Everyday (1 KG)")).toBe("Nestle Everyday (1 KG)")
    expect(columnTickLabel("Tapal Danedar Teabags (600 PCS)")).toBe("Tapal Danedar Teabags…")
    expect(columnTickLabel("Muhammad Nauman Liaqat Ahmed")).toBe("Muhammad Nauman Liaqa…")
    // The cut lands on a space here; it is dropped rather than left dangling before the ellipsis.
    expect(columnTickLabel("Nestle Everyday Milk Pack 2KG")).toBe("Nestle Everyday Milk…")
    expect(columnTickLabel(undefined)).toBe("")
  })
})

describe("a budget beside the columns", () => {
  // The same rows the branch panel draws, each carrying the Total Budget the
  // server set beside its figure. South was given nothing.
  const budgeted = [
    row({ totalBudgetCents: 300_000 }),
    row({ key: "2", label: "South", value: 100_000, share: 40, cumulativeShare: 100, changePct: null, totalBudgetCents: 0 }),
  ]

  it("legends the Total Budget in the track colour ahead of the entities, and says how to read the share", () => {
    render(<ComparisonChart {...base} rows={budgeted} chart="column" colorful budgetBeside onDrillDown={() => {}} />)
    const legend = screen.getByRole("list")
    const items = within(legend).getAllByRole("listitem")
    expect(items.map((item) => item.textContent)).toEqual(["Total budget", "North", "South"])
    expect((items[0].querySelector("[aria-hidden]") as HTMLElement | null)?.style.background).toBe(BUDGET_BESIDE_COLOR)
    expect(screen.getByText(/Total budget is allocated \+ add-ons for every month in the period/)).toBeTruthy()
    expect(screen.getByText(/excludes pending orders, so its share of budget reads lower than the Overview/)).toBeTruthy()
    // The drill-down hint still names the entity, not the budget.
    expect(screen.getByText(/Select any branch to open the order lines/)).toBeTruthy()
  })

  it("draws no budget and prints no note when the response carried none", () => {
    render(<ComparisonChart {...base} chart="column" colorful />)
    expect(screen.queryByText("Total budget")).toBeNull()
    expect(screen.queryByText(/allocated \+ add-ons/)).toBeNull()
  })

  it("reads the figure as a share of the budget, or says there is none", () => {
    expect(budgetShareLabel(150_000, 300_000)).toBe("50.0%")
    expect(budgetShareLabel(450_000, 300_000)).toBe("150.0%")
    expect(budgetShareLabel(100_000, 0)).toBe("no budget")
    expect(budgetShareLabel(100_000, undefined)).toBe("no budget")
  })

  it("adds the budget and its share to the table, blank-safe for an unbudgeted entity", () => {
    render(<ComparisonChart {...base} rows={budgeted} chart="table" budgetBeside />)
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent)
    expect(headers).toEqual(["Branch", "Procurement Value", "Total Budget", "% of budget", "Share", "vs prior", "Orders"])
    const north = within(screen.getByRole("row", { name: /North/ })).getAllByRole("cell").map((cell) => (cell.textContent ?? "").replace(/\u00a0/g, " "))
    expect(north.slice(1, 4)).toEqual(["Rs 1,500", "Rs 3,000", "50.0%"])
    const south = within(screen.getByRole("row", { name: /South/ })).getAllByRole("cell").map((cell) => (cell.textContent ?? "").replace(/\u00a0/g, " "))
    expect(south.slice(1, 4)).toEqual(["Rs 1,000", "Rs 0", "no budget"])
  })
})

describe("the table form", () => {
  it("shows every figure as text and drills from the first cell", () => {
    const onDrillDown = vi.fn()
    render(<ComparisonChart {...base} chart="table" onDrillDown={onDrillDown} />)
    expect(screen.getByText("Share")).toBeTruthy()
    expect(screen.getByText("60.0%")).toBeTruthy()
    expect(screen.getByText("+50.0% vs prior")).toBeTruthy()
    expect(screen.getByText("no prior period")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "South" }))
    expect(onDrillDown).toHaveBeenCalledWith({ dimension: "branch", key: "2", label: "South" })
  })

  it("drops the share column for a metric that is not a part of a whole", () => {
    render(<ComparisonChart {...base} chart="table" concentrationEligible={false} />)
    expect(screen.queryByText("Share")).toBeNull()
  })
})

describe("the trend form", () => {
  it("draws one legend entry per entity and says a missing month is zero", () => {
    render(<ComparisonChart {...base} chart="line" rows={[]} series={series} periods={["2026-07", "2026-08"]} dimension="user" dimensionLabel="Requester" />)
    expect(screen.getByText("Ahmed")).toBeTruthy()
    expect(screen.getByText("Sana")).toBeTruthy()
    expect(screen.getByText("Procurement Value per month. A period with no purchase reads as zero, not as a gap.")).toBeTruthy()
  })

  it("says per day on a day axis, and that a point names one entity in one month otherwise", () => {
    const { unmount } = render(<ComparisonChart {...base} chart="line" rows={[]} series={series} periods={["2026-08-01"]} dimension="day" dimensionLabel="Day" onDrillDown={() => {}} />)
    expect(screen.getByText(/Procurement Value per day\./)).toBeTruthy()
    expect(screen.getByText(/Select any point to open/)).toBeTruthy()
    unmount()

    render(<ComparisonChart {...base} chart="line" rows={[]} series={series} periods={["2026-07"]} dimension="user" dimensionLabel="Requester" onDrillDown={() => {}} />)
    expect(screen.getByText(/Select any point — one requester in one month/)).toBeTruthy()
  })

  it("offers the same rows as a table, one column per period, drilling by entity", () => {
    const onSelectEntity = vi.fn()
    render(<SeriesTable series={series} periods={["2026-07", "2026-08"]} format="currency" onSelectEntity={onSelectEntity} />)
    expect(screen.getByText("2026-07")).toBeTruthy()
    expect(screen.getByText("2026-08")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Sana" }))
    expect(onSelectEntity).toHaveBeenCalledWith("b", 1)
  })
})

describe("the share and value-vs-quantity forms", () => {
  it("states that a donut's shares are of the entities shown, not of everything", () => {
    render(<ComparisonChart {...base} chart="donut" onDrillDown={() => {}} />)
    expect(screen.getByText(/Shares are of the 2 branch shown/)).toBeTruthy()
    expect(screen.getByText("Select any slice to open the order lines behind it, for this same period and these same filters.")).toBeTruthy()
  })

  it("explains that a scatter needs quantities rather than drawing nothing", () => {
    render(<ComparisonChart {...base} chart="scatter" rows={rows.map((r) => ({ ...r, quantity: 0 }))} />)
    expect(screen.getByText(/Value against quantity needs order lines with a quantity/)).toBeTruthy()
  })

  it("labels the quantity axis with the unit and reads the bubbles for the reader", () => {
    render(<ComparisonChart {...base} chart="scatter" unit="Litre" onDrillDown={() => {}} />)
    expect(screen.getByText(/bubble size is order count/)).toBeTruthy()
  })
})

describe("the prior-period form", () => {
  it("legends this period against the prior one", () => {
    render(<ComparisonChart {...base} chart="grouped" />)
    expect(screen.getByText("Procurement Value, this period")).toBeTruthy()
    expect(screen.getByText("Prior period")).toBeTruthy()
  })
})
