import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import {
  BUDGET_BESIDE_COLOR,
  ChartCard,
  DataTable,
  ExecutiveVizStyles,
  Legend,
  SERIES,
  STATUS_COLOR,
  changeLabel,
  countShort,
  formatByKind,
  formatMarkLabelByKind,
  formatShortByKind,
  money,
  moneyShort,
  moneyShortBare,
  percent,
  sequentialStep,
} from "./chart-kit"

/**
 * The chrome every panel on the Product Performance tab is wrapped in, and the
 * formatters every label and tooltip goes through.
 *
 * A wrong abbreviation or a card that draws an empty axis instead of saying why
 * would mislead on every panel at once, so both are pinned here.
 */

describe("formatters", () => {
  it("prints exact money for tooltips and abbreviated money for axes", () => {
    expect(money(184_000_000)).toMatch(/1,840,000/)
    expect(money(0)).toMatch(/0/)
    expect(moneyShort(184_000_000)).toBe("₨1.8M")
    expect(moneyShort(64_000_000)).toBe("₨640.0K")
    expect(moneyShort(150_000_000_000)).toBe("₨1.5B")
    expect(moneyShort(4_200)).toBe("₨42")
    expect(moneyShort(-4_200_00)).toBe("-₨4.2K")
  })

  it("abbreviates counts and keeps percentages to one decimal", () => {
    expect(countShort(1_234)).toBe("1.2K")
    expect(countShort(2_500_000)).toBe("2.5M")
    expect(countShort(12.345)).toBe("12.35")
    expect(percent(23.456)).toBe("23.5%")
    expect(percent(23.456, 0)).toBe("23%")
    expect(percent(Number.NaN)).toBe("—")
  })

  it("routes each format kind to the right formatter", () => {
    expect(formatByKind(150_000, "currency")).toMatch(/1,500/)
    expect(formatByKind(42.5, "percent")).toBe("42.5%")
    expect(formatByKind(2_100, "quantity")).toBe("2.1K")
    expect(formatByKind(7, "count")).toBe("7")
    expect(formatShortByKind(150_000, "currency")).toBe("₨1.5K")
    expect(formatShortByKind(42.5, "percent")).toBe("43%")
  })

  it("drops the currency mark for a label drawn on a mark, and only there", () => {
    // Upright columns are the crowded case — twelve across half a card, two
    // per category once a budget stands beside each. The axis keeps the mark.
    expect(moneyShortBare(14_280_000)).toBe("142.8K")
    expect(moneyShortBare(-420_000)).toBe("-4.2K")
    expect(formatMarkLabelByKind(150_000, "currency")).toBe("1.5K")
    expect(formatShortByKind(150_000, "currency")).toBe("₨1.5K")
    // Every other kind is untouched — there was never a mark to drop.
    for (const kind of ["quantity", "count", "percent"]) {
      expect(formatMarkLabelByKind(2_100, kind)).toBe(formatShortByKind(2_100, kind))
    }
  })

  it("tells 'no prior period' apart from 'no change'", () => {
    expect(changeLabel(null)).toEqual({ text: "no prior period", tone: "flat" })
    expect(changeLabel(undefined)).toEqual({ text: "no prior period", tone: "flat" })
    expect(changeLabel(Number.NaN)).toEqual({ text: "no prior period", tone: "flat" })
    expect(changeLabel(0.01)).toEqual({ text: "no change", tone: "flat" })
    expect(changeLabel(12.34)).toEqual({ text: "+12.3% vs prior", tone: "up" })
    expect(changeLabel(-7.5)).toEqual({ text: "-7.5% vs prior", tone: "down" })
  })

  it("maps a ratio onto the sequential ramp and reserves the track for nothing", () => {
    expect(sequentialStep(0)).toBe("var(--viz-track)")
    expect(sequentialStep(Number.NaN)).toBe("var(--viz-track)")
    expect(sequentialStep(0.1)).toBe("var(--viz-seq-100)")
    expect(sequentialStep(1)).toBe("var(--viz-seq-700)")
  })
})

describe("ChartCard", () => {
  const base = { title: "By branch", question: "Which branches consumed the most?" }

  it("shows a skeleton while loading, and neither the chart nor an empty message", () => {
    const { container } = render(<ChartCard {...base} loading><p>chart</p></ChartCard>)
    expect(container.querySelector(".animate-pulse")).toBeTruthy()
    expect(screen.queryByText("chart")).toBeNull()
  })

  it("shows the error message instead of the chart", () => {
    render(<ChartCard {...base} error="This comparison could not be loaded."><p>chart</p></ChartCard>)
    expect(screen.getByText("This comparison could not be loaded.")).toBeTruthy()
    expect(screen.queryByText("chart")).toBeNull()
  })

  it("explains an empty period rather than drawing an empty axis", () => {
    render(<ChartCard {...base} empty="Nothing in the selected period under these filters."><p>chart</p></ChartCard>)
    expect(screen.getByText("Nothing in the selected period under these filters.")).toBeTruthy()
    expect(screen.queryByText("chart")).toBeNull()
  })

  it("reveals the formula behind the figure on the info button", () => {
    render(<ChartCard {...base} formula="SUM(order.totalCents - order.refundAmountCents)"><p>chart</p></ChartCard>)
    expect(screen.queryByText(/SUM\(order\.totalCents/)).toBeNull()
    fireEvent.click(screen.getByLabelText("How By branch is calculated"))
    expect(screen.getByText("SUM(order.totalCents - order.refundAmountCents)")).toBeTruthy()
  })

  it("swaps the chart for its table and back, only when a table is supplied", () => {
    const { rerender } = render(<ChartCard {...base} table={<p>rows</p>}><p>chart</p></ChartCard>)
    expect(screen.getByText("chart")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Show By branch as a table"))
    expect(screen.getByText("rows")).toBeTruthy()
    expect(screen.queryByText("chart")).toBeNull()
    fireEvent.click(screen.getByLabelText("Show By branch as a chart"))
    expect(screen.getByText("chart")).toBeTruthy()

    rerender(<ChartCard {...base}><p>chart</p></ChartCard>)
    expect(screen.queryByLabelText("Show By branch as a table")).toBeNull()
  })

  it("renders the toolbar next to the built-in buttons", () => {
    render(<ChartCard {...base} toolbar={<button type="button">Full width</button>}><p>chart</p></ChartCard>)
    expect(screen.getByRole("button", { name: "Full width" })).toBeTruthy()
  })
})

describe("DataTable", () => {
  it("makes the first cell a button that reports the row's key, not its index-derived label", () => {
    const onSelectRow = vi.fn()
    render(
      <DataTable
        columns={["Branch", "Value"]}
        rows={[["North", "₨1.5K"], ["North", "₨2.0K"]]}
        rowKeys={["7", "9"]}
        onSelectRow={onSelectRow}
      />,
    )
    const buttons = screen.getAllByRole("button", { name: "North" })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(onSelectRow).toHaveBeenCalledWith("9", 1)
  })

  it("explains an empty table", () => {
    render(<DataTable columns={["Branch"]} rows={[]} />)
    expect(screen.getByText("No rows in the selected period.")).toBeTruthy()
  })
})

describe("Legend", () => {
  it("keeps two entities with one label apart, and never warns about keys", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {})
    render(<Legend items={[
      { key: "a", label: "Ahmed", color: "red" },
      { key: "b", label: "Ahmed", color: "blue" },
      { label: "Procurement Value", color: "green" },
      { label: "Procurement Value", color: "green" },
    ]} />)
    expect(screen.getAllByText("Ahmed")).toHaveLength(2)
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("same key"), expect.anything(), expect.anything())
    warn.mockRestore()
  })
})

describe("the reference role", () => {
  it("is its own token, never a series slot, a status, or the track", () => {
    // A Total Budget is a quantity given: not an entity, not a state. Sharing
    // a token with any of those would let one be mistaken for the other.
    expect(BUDGET_BESIDE_COLOR).toBe("var(--viz-reference)")
    expect(SERIES as readonly string[]).not.toContain(BUDGET_BESIDE_COLOR)
    expect(Object.values(STATUS_COLOR)).not.toContain(BUDGET_BESIDE_COLOR)
    expect(BUDGET_BESIDE_COLOR).not.toBe("var(--viz-track)")
  })

  it("is defined in both themes, with its own step for each surface", () => {
    // Dark mode is selected, never an automatic flip: the reference sits
    // outside the series lightness band in each theme — darker than them on
    // the light surface, lighter on the dark one — which is where its
    // separation from all six series hues comes from.
    const { container } = render(<ExecutiveVizStyles />)
    const css = container.querySelector("style")?.innerHTML ?? ""
    const steps = Array.from(css.matchAll(/--viz-reference:\s*(#[0-9a-f]{6})/g)).map((match) => match[1])
    expect(steps).toHaveLength(2)
    expect(steps[0]).not.toBe(steps[1])
  })
})
