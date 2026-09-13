import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The Compare Side by Side screen as a whole: which questions it asks the
 * server, with which filters, and what it keeps when the reader changes one
 * thing.
 *
 * Every request is answered from a small table of canned responses so the
 * assertions can run against the URLs the screen builds — the contract with the
 * server that the integration suite verifies from the other side — and against
 * the copy the reader sees. The charts themselves are stubbed to a button per
 * row, which is the one interaction under test here.
 */

const requested: string[] = []
let blocked: { reason: string; message: string } | undefined
let selectedUnit: string | null = null
let emptyRows = false

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url) requested.push(url)
    if (!url) return { data: undefined, isLoading: false }
    if (url.includes("/options?")) {
      return {
        data: {
          options: url.includes("dimension=product")
            ? [{ key: "186", label: "A4 Paper" }, { key: "187", label: "Toner" }, { key: "188", label: "Diesel" }]
            : [{ key: "u1", label: "Ahmed" }, { key: "u2", label: "Sana" }],
        },
        isLoading: false,
      }
    }
    if (url.includes("/drill-down?")) {
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
    const isSeries = url.includes("chart=line")
    return {
      data: {
        rows: isSeries || emptyRows ? [] : [{
          key: "7", label: "North Zone", value: 100, previousValue: 0, changePct: null,
          spendCents: 100, quantity: 0, orderCount: 1, avgUnitPriceCents: 0, share: 100, cumulativeShare: 100,
        }],
        series: isSeries && !emptyRows ? [{ key: "u1", label: "Ahmed", points: [{ period: "2026-07", value: 1 }] }] : [],
        periods: isSeries ? ["2026-07"] : [],
        format: url.includes("metric=quantity") ? "quantity" : "currency",
        label: url.includes("metric=quantity") ? "Quantity" : "Procurement Value",
        formula: "",
        mode: isSeries ? "series" : "rank",
        chart: isSeries ? "line" : "bar",
        concentrationEligible: true,
        quantityUnit: { selected: selectedUnit, conflict: false, available: [] },
        blocked,
      },
      isLoading: false,
    }
  },
}))

vi.mock("./comparison-charts", () => ({
  ComparisonChart: ({ rows, series, dimension, onDrillDown }: any) => (
    <button type="button" onClick={() => onDrillDown({ dimension, key: rows[0]?.key ?? series[0]?.key, label: "x" })}>
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
  branchIds: ["7"],
  categoryIds: [],
  unit: null,
})

/**
 * The comparison requests of the latest render, parsed.
 *
 * Every mounted panel re-requests on each render, so clearing the log before
 * an action and reading it after gives exactly the panels now on screen.
 */
function panelRequests() {
  const seen = new Map<string, URLSearchParams>()
  for (const url of requested) {
    if (!url.includes("/compare?")) continue
    const params = new URL(`http://x${url}`).searchParams
    // One entry per panel: dimension + chart identifies it. The last request wins.
    seen.set(`${params.get("dimension")}:${params.get("chart")}`, params)
  }
  return seen
}

const panelTitles = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)

function openPicker(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }))
  return screen.getByRole("list")
}

/** Runs an interaction and returns only the requests it caused. */
function after(action: () => void) {
  requested.length = 0
  action()
  return panelRequests()
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const scrollIntoView = vi.fn()

beforeEach(() => {
  requested.length = 0
  blocked = undefined
  selectedUnit = null
  emptyRows = false
  scrollIntoView.mockClear()
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView
})

describe("what the screen asks for", () => {
  it("draws six panels by default, each from the shared filters, ranked panels at 12 and trends at 6", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    expect(panelTitles()).toEqual([
      "By product", "By requester", "By branch", "By month", "Requesters over months", "Products over months",
    ])
    const panels = panelRequests()
    expect([...panels.keys()].sort()).toEqual([
      "branch:bar", "month:column", "product:bar", "product:line", "user:bar", "user:line",
    ])
    for (const params of panels.values()) {
      expect(params.get("branchIds")).toBe("7")
      expect(params.get("metric")).toBe("spend")
      expect(params.get("limit")).toBe(params.get("chart") === "line" ? "6" : "12")
      expect(params.has("productIds")).toBe(false)
      expect(params.has("userIds")).toBe(false)
    }
    expect(screen.getByText(/All products/, { selector: "strong" })).toBeTruthy()
    expect(screen.getByText(/compared across products, requesters, branches and months at once/)).toBeTruthy()
  })

  it("narrows every panel to the ticked requesters, and ranks exactly them on the requester panels", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All requesters/)
    const panels = after(() => fireEvent.click(within(list).getByText("Sana")))

    expect(panels.size).toBe(6)
    for (const params of panels.values()) expect(params.get("userIds")).toBe("u2")
    expect(panels.get("user:bar")?.get("keys")).toBe("u2")
    expect(panels.get("user:line")?.get("keys")).toBe("u2")
    expect(panels.get("branch:bar")?.has("keys")).toBe(false)
    expect(panels.get("product:bar")?.has("keys")).toBe(false)

    // The product picker follows the requester selection; the requester picker never narrows itself.
    const options = requested.filter((url) => url.includes("/options?"))
    expect(options.at(-2)).toContain("dimension=product")
    expect(options.at(-2)).toContain("userIds=u2")
    expect(options.at(-1)).toContain("dimension=user")
    expect(options.at(-1)).not.toContain("userIds=")
  })

  it("collapses to the single-product layout with day-by-day, and back", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All products/)
    const panels = after(() => fireEvent.click(within(list).getByText("A4 Paper")))

    expect(panelTitles()).toEqual([
      "By requester", "By branch", "By month", "Requesters over months", "Day-by-day consumption",
    ])
    expect(screen.getByText("A4 Paper", { selector: "strong" })).toBeTruthy()
    expect(screen.getByText(/compared across requesters, branches and months at once/)).toBeTruthy()
    expect(screen.getByText(/Day-by-day consumption is shown below/)).toBeTruthy()
    expect([...panels.keys()].sort()).toEqual(["branch:bar", "day:line", "month:column", "user:bar", "user:line"])
    for (const params of panels.values()) expect(params.get("productIds")).toBe("186")

    fireEvent.click(within(list).getByText("Toner"))
    expect(panelTitles()).toContain("By product")
    expect(panelTitles()).not.toContain("Day-by-day consumption")
    expect(screen.getByText("A4 Paper and Toner", { selector: "strong" })).toBeTruthy()
    expect(screen.getByText(/Choose a single product to see day-by-day consumption/)).toBeTruthy()

    fireEvent.click(within(list).getByText("Diesel"))
    expect(screen.getByText("3 products", { selector: "strong" })).toBeTruthy()
  })

  it("keeps the focus, the compared people and the open table when the measure flips", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    fireEvent.click(within(openPicker(/All products/)).getByText("A4 Paper"))
    fireEvent.click(within(openPicker(/All requesters/)).getByText("Ahmed"))
    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))
    expect(document.getElementById("executive-drill-down")).not.toBeNull()

    const panels = after(() => fireEvent.click(screen.getByRole("button", { name: "Quantity" })))

    expect(panels.size).toBe(5)
    for (const params of panels.values()) {
      expect(params.get("metric")).toBe("quantity")
      expect(params.get("productIds")).toBe("186")
      expect(params.get("userIds")).toBe("u1")
    }
    expect(screen.getByText(/measured by quantity/)).toBeTruthy()
    expect(document.getElementById("executive-drill-down")).not.toBeNull()
    const drill = new URL(`http://x${requested.filter((u) => u.includes("/drill-down?")).at(-1)}`).searchParams
    expect(drill.get("metric")).toBe("quantity")
    expect(drill.get("productIds")).toBe("186")
    expect(drill.get("userIds")).toBe("u1")
  })

  it("clears the focus, the people and the table together, leaving the filter bar alone", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    expect(screen.queryByRole("button", { name: /Clear selection/ })).toBeNull()
    fireEvent.click(within(openPicker(/All products/)).getByText("A4 Paper"))
    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))

    const panels = after(() => fireEvent.click(screen.getByRole("button", { name: /Clear selection/ })))
    expect(document.getElementById("executive-drill-down")).toBeNull()
    expect(screen.getByText(/All products/, { selector: "strong" })).toBeTruthy()
    expect(panels.size).toBe(6)
    for (const params of panels.values()) {
      expect(params.has("productIds")).toBe(false)
      expect(params.get("branchIds")).toBe("7")
    }
  })
})

describe("what the panels say", () => {
  it("shows the server's unit-conflict message in place of every chart", () => {
    blocked = { reason: "unit-conflict", message: "Quantity cannot be totalled across Litre, Ream. Choose one unit of measure, or narrow the selection to products sharing one." }
    render(<SideBySideWorkspace filters={filters()} />)
    expect(screen.getAllByText(/Quantity cannot be totalled across Litre, Ream/)).toHaveLength(6)
    expect(screen.queryByRole("button", { name: /^bar / })).toBeNull()
  })

  it("footnotes the unit every panel is measured in", () => {
    selectedUnit = "Ream"
    render(<SideBySideWorkspace filters={filters()} />)
    const notes = screen.getAllByText(/Other units in this period are excluded rather than added to it/)
    expect(notes).toHaveLength(6)
    expect(notes[0].textContent).toContain("Measured in Ream only")
  })

  it("explains an empty panel instead of drawing nothing", () => {
    emptyRows = true
    render(<SideBySideWorkspace filters={filters()} />)
    expect(screen.getAllByText("Nothing in the selected period under these filters.")).toHaveLength(6)
  })
})

describe("full-width panels", () => {
  it("widens only the panel whose checkbox was ticked, and brings it to the front", () => {
    render(<SideBySideWorkspace filters={filters()} />)

    const byBranch = screen.getByRole("checkbox", { name: "Show By branch at full width" })
    const byRequester = screen.getByRole("checkbox", { name: "Show By requester at full width" })
    const cardOf = (checkbox: HTMLElement) => checkbox.closest("[data-slot=card]") as HTMLElement

    expect(cardOf(byBranch).className).not.toContain("xl:col-span-2")

    fireEvent.click(byBranch)
    expect(cardOf(byBranch).className).toContain("xl:col-span-2")
    expect(cardOf(byRequester).className).not.toContain("xl:col-span-2")
    expect(panelTitles()).toEqual([
      "By branch", "By product", "By requester", "By month", "Requesters over months", "Products over months",
    ])

    fireEvent.click(byBranch)
    expect(cardOf(byBranch).className).not.toContain("xl:col-span-2")
    expect(panelTitles()[2]).toBe("By branch")
  })

  it("never offers the checkbox on the day panel, which is always full width", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    fireEvent.click(within(openPicker(/All products/)).getByText("A4 Paper"))
    expect(screen.queryByRole("checkbox", { name: "Show Day-by-day consumption at full width" })).toBeNull()
    const day = screen.getByText("Day-by-day consumption").closest("[data-slot=card]") as HTMLElement
    expect(day.className).toContain("xl:col-span-2")
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

    fireEvent.click(screen.getByRole("button", { name: "bar branch" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("button", { name: "bar month" }))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
  })
})
