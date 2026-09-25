import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { BUDGET_BESIDE_COLOR, SERIES, STATUS_COLOR } from "./chart-kit"
import {
  ComparisonChart,
  SeriesTable,
  budgetShareLabel,
  columnTickLabel,
  budgetColumnLabel,
  budgetColumnLabelContent,
  budgetLabelY,
  columnLabelNudge,
  columnLabelsRotated,
  columnTicksAngled,
  columnTopMargin,
  dualColumnLabel,
  dualColumnLabelLines,
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

  it("turns the figures upright once the columns are narrower than a figure is wide", () => {
    // Width-independent, like the rule that angles the ticks below them: a
    // panel cannot measure itself, so the rule is set on the narrow case and
    // relaxed only for the one wider shape the panel knows it is in.
    expect(columnLabelsRotated(6)).toBe(false)
    expect(columnLabelsRotated(7)).toBe(true)
    expect(columnLabelsRotated(0)).toBe(false)
    // Widened to the whole row there is twice the width, and the ranked
    // panels cap at twelve entities — so a widened panel never rotates.
    expect(columnLabelsRotated(7, true)).toBe(false)
    expect(columnLabelsRotated(12, true)).toBe(false)
  })

  it("steps an upright pair off its columns' centres, and only an upright pair", () => {
    // Upright, a figure is as wide as its type and the budget pair's columns
    // stand about ten pixels apart; across, `budgetLabelY` keeps them apart
    // by lifting one onto its own line instead.
    expect(columnLabelNudge(true, true)).toBeGreaterThan(0)
    expect(columnLabelNudge(true, false)).toBe(0)
    expect(columnLabelNudge(false, true)).toBe(0)
    expect(columnLabelNudge(false, false)).toBe(0)
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

describe("both figures over a product column", () => {
  const ream = row({ label: "Ream 80gsm", value: 14_280_000, spendCents: 14_280_000, quantity: 12 })

  it("prints quantity above value, off the row and not off the drawn measure", () => {
    // The same two strings whichever way the toggle is set: under Amount the
    // column is drawn from `spendCents`, under Quantity from `quantity`, and
    // the row carries both either way.
    expect(dualColumnLabelLines(ream)).toEqual({ quantity: "12", money: "142.8K" })
  })

  it("drops the currency mark, and only there", () => {
    // The two figures need the width; the mark stays on the axis, the tooltip
    // and the table, which is what the caption below the chart points at.
    expect(dualColumnLabelLines(ream).money).not.toContain("₨")
    expect(dualColumnLabelLines({ quantity: 0, spendCents: -150_000 })).toEqual({ quantity: "0", money: "-1.5K" })
    expect(dualColumnLabelLines({ quantity: 1_500, spendCents: 250_000_000 })).toEqual({ quantity: "1.5K", money: "2.5M" })
  })

  it("centres both lines over the column it was handed, quantity above money", () => {
    // Recharts hands a label its own viewBox and its index, never the row, so
    // the geometry and the lookup are what this is checking. 40 wide from x=10
    // centres on 30; the column top is y=100.
    const Label = dualColumnLabel([ream], "currency", false)
    const { container } = render(
      <svg>
        <Label index={0} viewBox={{ x: 10, y: 100, width: 40, height: 80 }} />
      </svg>,
    )
    const texts = Array.from(container.querySelectorAll("text"))
    expect(texts.map((node) => node.textContent)).toEqual(["12", "142.8K"])
    expect(texts.map((node) => node.getAttribute("x"))).toEqual(["30", "30"])
    // Both sit above the column, and the quantity above the money.
    const ys = texts.map((node) => Number(node.getAttribute("y")))
    expect(ys[0]).toBeLessThan(ys[1])
    expect(ys[1]).toBeLessThan(100)
  })

  it("draws nothing rather than guessing when Recharts has not measured the column yet", () => {
    const Label = dualColumnLabel([ream], "currency", false)
    const { container } = render(<svg><Label index={0} viewBox={{ x: 10, width: 40 }} /></svg>)
    expect(container.querySelectorAll("text")).toHaveLength(0)
  })

  it("tells the reader how to read the pair, and says so only on a panel that prints it", () => {
    const { unmount } = render(<ComparisonChart {...base} chart="column" colorful dualValueLabels />)
    expect(screen.getByText(/quantity above its value/)).toBeTruthy()
    unmount()

    render(<ComparisonChart {...base} chart="column" colorful />)
    expect(screen.queryByText(/quantity above its value/)).toBeNull()
  })

  it("keeps the single label when a budget stands beside the column", () => {
    // Two columns already; a second pair of figures over them would read as
    // four, so the pair is withheld rather than drawn ambiguously.
    render(<ComparisonChart {...base} chart="column" colorful dualValueLabels budgetBeside />)
    expect(screen.queryByText(/quantity above its value/)).toBeNull()
    expect(screen.getByText(/Total budget is allocated \+ add-ons/)).toBeTruthy()
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

  it("prints the budget over its own column, bare of the currency mark", () => {
    expect(budgetColumnLabel(30_000_000)).toBe("300.0K")
    expect(budgetColumnLabel(800_000_000)).toBe("8.0M")
    expect(budgetColumnLabel(30_000_000)).not.toContain("₨")
  })

  it("prints nothing over an entity that was given no budget", () => {
    // There is no column to label, and a "0" drawn at the baseline would sit
    // on the axis ticks. The tooltip and the table say "no budget" in words.
    expect(budgetColumnLabel(0)).toBe("")
    expect(budgetColumnLabel(-1)).toBe("")
    expect(budgetColumnLabel(null)).toBe("")
    expect(budgetColumnLabel(undefined)).toBe("")
  })

  it("lifts the budget figure clear when the branch has consumed nearly all of it", () => {
    // y grows downward: a smaller top is a taller column. Well apart, each
    // figure floats over its own column.
    expect(budgetLabelY(40, 200)).toBe(35)
    expect(budgetLabelY(40, 60)).toBe(35)

    // Within a line of each other — the branch this panel exists to surface —
    // the budget moves, because it is the reference, and it lands one line
    // above the *value* figure: just under its budget…
    expect(budgetLabelY(100, 104)).toBe(104 - 5 - 15)
    // …exactly on it…
    expect(budgetLabelY(100, 100)).toBe(100 - 5 - 15)
    // …or over it, so the pair always reads budget above value.
    expect(budgetLabelY(104, 100)).toBe(100 - 5 - 15)
  })

  it("derives the value column's top from the budget column's own geometry", () => {
    // One axis from zero and a shared baseline, so the budget column's height
    // is the scale: 300K over 240px puts a 150K value column's top halfway up,
    // at y=160. That is 155 for its label, far enough that the budget figure
    // stays at its own natural 40 - 5.
    const Label = budgetColumnLabelContent([row({ value: 150_000, totalBudgetCents: 300_000 })], false)
    const { container } = render(
      <svg><Label index={0} viewBox={{ x: 10, y: 40, width: 40, height: 240 }} /></svg>,
    )
    const text = container.querySelector("text")
    expect(text?.textContent).toBe("3.0K")
    expect(text?.getAttribute("x")).toBe("30")
    expect(Number(text?.getAttribute("y"))).toBe(budgetLabelY(40, 160))
  })

  it("falls back to the natural position before the column has been measured", () => {
    const Label = budgetColumnLabelContent([row({ totalBudgetCents: 300_000 })], false)
    const { container } = render(<svg><Label index={0} viewBox={{ x: 10, y: 40, width: 40 }} /></svg>)
    expect(Number(container.querySelector("text")?.getAttribute("y"))).toBe(35)
  })

  it("draws no budget figure for an entity that was given none", () => {
    const Label = budgetColumnLabelContent([row({ totalBudgetCents: 0 })], false)
    const { container } = render(
      <svg><Label index={0} viewBox={{ x: 10, y: 300, width: 40, height: 0 }} /></svg>,
    )
    expect(container.querySelectorAll("text")).toHaveLength(0)
  })

  it("leaves headroom for whichever label form the columns carry", () => {
    const plain = columnTopMargin({ dual: false, rotated: false })
    expect(plain).toBe(20)
    // A budget figure may be lifted a line; two stacked figures need two
    // lines; an upright figure stands on its whole length.
    expect(columnTopMargin({ dual: false, budgetBeside: true, rotated: false })).toBeGreaterThan(plain)
    expect(columnTopMargin({ dual: true, rotated: false }))
      .toBeGreaterThan(columnTopMargin({ dual: false, budgetBeside: true, rotated: false }))
    expect(columnTopMargin({ dual: false, rotated: true }))
      .toBeGreaterThan(columnTopMargin({ dual: true, rotated: false }))
  })

  it("wears the reference role, which is neither a series slot nor a status", () => {
    // The Total Budget is a quantity given, not an entity and not a state, so
    // it must never be assignable to either — an entity wearing the budget's
    // colour, or the budget wearing a status, would both misread.
    expect(BUDGET_BESIDE_COLOR).toBe("var(--viz-reference)")
    expect(SERIES).not.toContain(BUDGET_BESIDE_COLOR)
    expect(Object.values(STATUS_COLOR)).not.toContain(BUDGET_BESIDE_COLOR)
    // And it is a mark in its own right, not the track it used to borrow.
    expect(BUDGET_BESIDE_COLOR).not.toBe("var(--viz-track)")
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
