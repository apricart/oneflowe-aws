import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Two things a reader does on the side-by-side screen that are easy to break
 * without noticing, because neither shows up in a snapshot of the numbers:
 *
 *  * widening one panel to the full row, which must move only that panel;
 *  * clicking a bar, which must bring the detail table into view — on a
 *    six-panel screen it opens well past the fold.
 *
 * Every request is stubbed to an empty answer; these tests are about the
 * chrome, not the figures.
 */

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url?.includes("/options?")) return { data: { options: [] }, isLoading: false }
    if (url?.includes("/drill-down?")) {
      return {
        data: {
          dimensionLabel: "Branch",
          metricLabel: "Procurement Value",
          period: { startDate: "2026-07-01", endDate: "2026-09-12" },
          rows: [],
          totals: { lineCount: 0, orderCount: 0, valueCents: 0, quantityByUnit: [] },
          hasMore: false,
        },
        isLoading: false,
      }
    }
    return {
      data: {
        rows: [{
          key: "7", label: "North Zone", value: 100, previousValue: 0, changePct: null,
          spendCents: 100, quantity: 0, orderCount: 1, avgUnitPriceCents: 0, share: 100, cumulativeShare: 100,
        }],
        series: [],
        periods: [],
        format: "currency",
        label: "Procurement Value",
        formula: "",
        mode: "rank",
        chart: "bar",
        concentrationEligible: true,
        quantityUnit: { selected: null, conflict: false, available: [] },
      },
      isLoading: false,
    }
  },
}))

// The chart itself is Recharts and needs a real layout; a stand-in exposes the
// one interaction under test — the drill-down click.
vi.mock("./comparison-charts", () => ({
  ComparisonChart: ({ rows, dimension, onDrillDown }: any) => (
    <button type="button" onClick={() => onDrillDown({ dimension, key: rows[0].key, label: rows[0].label })}>
      bar {dimension}
    </button>
  ),
  SeriesTable: () => null,
}))

import { SideBySideWorkspace } from "./side-by-side-workspace"
import { executiveDefaultDates } from "./executive-filters"

const filters = () => ({
  ...executiveDefaultDates(),
  organizationIds: [],
  branchIds: [],
  categoryIds: [],
  unit: null,
})

const scrollIntoView = vi.fn()

beforeEach(() => {
  scrollIntoView.mockClear()
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView
})

describe("full-width panels", () => {
  it("widens only the panel whose checkbox was ticked", () => {
    render(<SideBySideWorkspace filters={filters()} />)

    const byBranch = screen.getByRole("checkbox", { name: "Show By branch at full width" })
    const byRequester = screen.getByRole("checkbox", { name: "Show By requester at full width" })
    const cardOf = (checkbox: HTMLElement) => checkbox.closest("[data-slot=card]") as HTMLElement

    const titles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)

    expect(cardOf(byBranch).className).not.toContain("xl:col-span-2")
    expect(titles()).toEqual([
      "By product", "By requester", "By branch", "By month", "Requesters over months", "Products over months",
    ])

    fireEvent.click(byBranch)
    expect(cardOf(byBranch).className).toContain("xl:col-span-2")
    expect(cardOf(byRequester).className).not.toContain("xl:col-span-2")
    // A widened panel leads the grid; the rest keep their order behind it.
    expect(titles()).toEqual([
      "By branch", "By product", "By requester", "By month", "Requesters over months", "Products over months",
    ])

    fireEvent.click(byBranch)
    expect(cardOf(byBranch).className).not.toContain("xl:col-span-2")
    expect(titles()[2]).toBe("By branch")
  })
})

describe("drill-down on click", () => {
  it("opens the detail table below and scrolls it into view", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    expect(document.getElementById("executive-drill-down")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))

    expect(document.getElementById("executive-drill-down")).not.toBeNull()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }))
  })

  it("scrolls again when a different bar is selected, not on unrelated re-renders", () => {
    render(<SideBySideWorkspace filters={filters()} />)

    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // Same selection again: the table is already in view.
    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    // A different entity is a different table. (Requester and product each
    // have two panels, so the month panel is the unambiguous second click.)
    fireEvent.click(screen.getByRole("button", { name: "bar month" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
})
