import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The Product Performance screen as a whole: which questions it asks the
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
/** When set, every comparison is still in flight and has no answer yet. */
let panelsLoading = false
/** When set, the requester option list is still in flight and has no answer yet. */
let optionsPending = false

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url) requested.push(url)
    if (!url) return { data: undefined, isLoading: false }
    if (url.startsWith("/api/v1/branches")) {
      return { data: { items: [{ id: 7, name: "North Zone", groupId: 4, groupName: "Distribution" }] }, isLoading: false }
    }
    if (url.includes("/options?")) {
      if (url.includes("dimension=product")) {
        return {
          data: {
            options: [{ key: "186", label: "A4 Paper" }, { key: "187", label: "Toner" }, { key: "188", label: "Diesel" }],
          },
          isLoading: false,
        }
      }
      // As the server answers it: the people who ordered at the branches in
      // scope, so changing the branch changes who may be compared at all.
      if (optionsPending) return { data: undefined, isLoading: true }
      const branchIds = new URL(`http://x${url}`).searchParams.get("branchIds")
      return { data: { options: REQUESTERS_BY_BRANCH[branchIds ?? "7"] ?? [] }, isLoading: false }
    }
    if (url.includes("/drill-down?")) {
      return {
        data: {
          dimensionLabel: "Branch",
          metricLabel: "Consumed",
          period: { startDate: "2026-07-01", endDate: "2026-09-12" },
          rows: [],
          totals: { lineCount: 0, orderCount: 0, valueCents: 0, quantity: 0, quantityByUnit: [] },
          hasMore: false,
        },
        isLoading: false,
      }
    }
    if (panelsLoading) return { data: undefined, isLoading: true }
    if (url.includes("/matrix?")) return { data: matrixResponse(url), isLoading: false }
    return { data: comparisonResponse(url), isLoading: false }
  },
}))

/** Who the options endpoint lists per branch. Sana ordered at both; Ahmed only at 7. */
const REQUESTERS_BY_BRANCH: Record<string, Array<{ key: string; label: string }>> = {
  "7": [{ key: "u1", label: "Ahmed" }, { key: "u2", label: "Sana" }],
  "9": [{ key: "u2", label: "Sana" }, { key: "u3", label: "Bilal" }],
}

/** The canned answer to the one `/matrix` request, shaped by the same flags. */
function matrixResponse(url: string) {
  const isQuantity = url.includes("metric=quantity")
  return {
    rowDimension: "user",
    columnDimension: "product",
    rowLabel: "Requester",
    columnLabel: "Product",
    metric: isQuantity ? "quantity" : "spend",
    grain: "line",
    format: isQuantity ? "quantity" : "currency",
    label: isQuantity ? "Quantity" : "Consumed",
    formula: "",
    period: { startDate: "2026-07-01", endDate: "2026-09-12" },
    quantityUnit: { selected: selectedUnit, conflict: false, available: [] },
    limits: { rows: 12, columns: 12 },
    rows: emptyRows ? [] : [{ key: "u1", label: "Ahmed", total: 700 }, { key: "u2", label: "Sana", total: 300 }],
    columns: emptyRows ? [] : [{ key: "186", label: "A4 Paper", total: 600 }, { key: "187", label: "Toner", total: 400 }],
    cells: emptyRows ? [] : [
      { row: "u1", column: "186", value: 400, spendCents: 400, quantity: 4, orderCount: 1 },
      { row: "u1", column: "187", value: 300, spendCents: 300, quantity: 1, orderCount: 1 },
      { row: "u2", column: "186", value: 200, spendCents: 200, quantity: 2, orderCount: 1 },
      { row: "u2", column: "187", value: 100, spendCents: 100, quantity: 1, orderCount: 1 },
    ],
    blocked,
  }
}

/** The canned answer to one `/compare` request, shaped by the flags above. */
function comparisonResponse(url: string) {
  const isSeries = url.includes("chart=line")
  const isQuantity = url.includes("metric=quantity")
  // As the server does: the budget is set beside the row only when asked for.
  const budgetBeside = url.includes("budget=1")
  return {
    rows: isSeries || emptyRows ? [] : [{
      key: "7", label: "North Zone", value: 100, previousValue: 0, changePct: null,
      spendCents: 100, quantity: 0, orderCount: 1, avgUnitPriceCents: 0, share: 100, cumulativeShare: 100,
      ...(budgetBeside ? { totalBudgetCents: 400 } : {}),
    }],
    budgetBeside,
    series: isSeries && !emptyRows ? [{ key: "u1", label: "Ahmed", points: [{ period: "2026-07", value: 1 }] }] : [],
    periods: isSeries ? ["2026-07"] : [],
    format: isQuantity ? "quantity" : "currency",
    label: isQuantity ? "Quantity" : "Consumed",
    formula: "",
    mode: isSeries ? "series" : "rank",
    chart: isSeries ? "line" : "column",
    concentrationEligible: true,
    quantityUnit: { selected: selectedUnit, conflict: false, available: [] },
    blocked,
  }
}

// The ranked table is the real one: its rows and its row button are what the
// "graph + table" test reads. The charts and the trend table are stubbed.
vi.mock("./matrix-chart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./matrix-chart")>()
  return {
    ...actual,
    MatrixChart: ({ response, onDrillDown }: any) => (
      <button
        type="button"
        onClick={() => onDrillDown(actual.cellDrillTarget(response, response.rows[1], response.columns[1]))}
      >
        grid cell
      </button>
    ),
  }
})

vi.mock("./comparison-charts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./comparison-charts")>()
  return {
    ...actual,
    ComparisonChart: ({ rows, series, dimension, onDrillDown }: any) => (
      <button type="button" onClick={() => onDrillDown({ dimension, key: rows[0]?.key ?? series[0]?.key, label: "x" })}>
        bar {dimension}
      </button>
    ),
    SeriesTable: () => null,
  }
})

/**
 * The spreadsheet library, reduced to what the download hands it: a sheet is
 * its rows, a workbook is its sheets by name, and "write" is recorded.
 */
type FakeWorkbook = { SheetNames: string[]; Sheets: Record<string, { rows: unknown[][] }>; Props?: unknown }
const writeFile = vi.fn<(workbook: FakeWorkbook, filename: string) => void>()

vi.mock("xlsx", () => ({
  utils: {
    book_new: (): FakeWorkbook => ({ SheetNames: [], Sheets: {} }),
    aoa_to_sheet: (rows: unknown[][]) => ({ rows }),
    book_append_sheet: (workbook: FakeWorkbook, sheet: { rows: unknown[][] }, name: string) => {
      workbook.SheetNames.push(name)
      workbook.Sheets[name] = sheet
    },
  },
  writeFile,
}))

import { SideBySideWorkspace } from "./side-by-side-workspace"
import { executiveDefaultDates } from "./executive-filters"

const filters = () => ({
  ...executiveDefaultDates(),
  organizationIds: [],
  groupIds: [],
  branchIds: ["7"],
  categoryIds: [],
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

/** The latest `/matrix` request, parsed. */
function gridRequest() {
  const url = requested.filter((entry) => entry.includes("/matrix?")).at(-1)
  if (!url) throw new Error("no grid request")
  return new URL(`http://x${url}`).searchParams
}

/** The distinct `/matrix` URLs asked for, in first-seen order. */
const gridUrls = () => Array.from(new Set(requested.filter((entry) => entry.includes("/matrix?"))))

function openPicker(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }))
  return screen.getByRole("list")
}

/** Ticks Ahmed and Sana to compare, which is what turns "By product" into the grid. */
function compareAhmedAndSana() {
  const list = openPicker(/All requesters/)
  fireEvent.click(within(list).getByText("Ahmed"))
  fireEvent.click(within(list).getByText("Sana"))
  return list
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
  panelsLoading = false
  optionsPending = false
  writeFile.mockClear()
  scrollIntoView.mockClear()
  window.HTMLElement.prototype.scrollIntoView = scrollIntoView
})

describe("what the screen asks for", () => {
  it("draws seven panels by default, each from the shared filters, ranked panels at 12 and trends at 6", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    expect(panelTitles()).toEqual([
      "By product", "By category", "By requester", "By branch", "By month",
      "Requesters over months", "Products over months",
    ])
    const panels = panelRequests()
    expect([...panels.keys()].sort()).toEqual([
      "branch:column", "category:column", "month:column", "product:column", "product:line", "user:column", "user:line",
    ])
    for (const params of panels.values()) {
      expect(params.get("branchIds")).toBe("7")
      expect(params.get("metric")).toBe("spend")
      expect(params.get("statuses")).toBe("consumed")
      expect(params.get("limit")).toBe(params.get("chart") === "line" ? "6" : "12")
      expect(params.has("productIds")).toBe(false)
      expect(params.has("userIds")).toBe(false)
    }
    // Only the two panels whose entities hold a budget ask for it beside their columns.
    const askingForBudget = [...panels.entries()].filter(([, params]) => params.get("budget") === "1").map(([id]) => id).sort()
    expect(askingForBudget).toEqual(["branch:column", "month:column"])
    expect(screen.getByText(/All products/, { selector: "strong" })).toBeTruthy()
    expect(screen.getByText(/measured by consumed/)).toBeTruthy()
    expect(screen.queryByText(/Procurement Value/i)).toBeNull()
    expect(screen.getByText(/compared across products, categories, requesters, branches and months at once/)).toBeTruthy()

    // With nobody compared there is no grid to ask for: every panel is a ranking or a trend.
    expect(gridUrls()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "grid cell" })).toBeNull()
  })

  it("narrows the grid to the ticked requesters and focused products, as ordinary filters", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()
    const list = openPicker(/All products/)
    fireEvent.click(within(list).getByText("A4 Paper"))
    fireEvent.click(within(list).getByText("Toner"))

    // Requesters as rows, products as columns, under the same filters and cap.
    const grid = gridRequest()
    expect(grid.get("rows")).toBe("user")
    expect(grid.get("columns")).toBe("product")
    expect(grid.get("metric")).toBe("spend")
    expect(grid.get("statuses")).toBe("consumed")
    expect(grid.get("limit")).toBe("12")
    expect(grid.get("branchIds")).toBe("7")
    expect(grid.get("userIds")).toBe("u1,u2")
    expect(grid.get("productIds")).toBe("186,187")
    expect(grid.has("keys")).toBe(false)
  })

  it("narrows every panel to the ticked requesters, and ranks exactly them on the requester panels", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All requesters/)
    const panels = after(() => fireEvent.click(within(list).getByText("Sana")))

    expect(panels.size).toBe(7)
    for (const params of panels.values()) expect(params.get("userIds")).toBe("u2")
    expect(panels.get("user:column")?.get("keys")).toBe("u2")
    expect(panels.get("user:line")?.get("keys")).toBe("u2")
    expect(panels.get("branch:column")?.has("keys")).toBe(false)
    expect(panels.get("product:column")?.has("keys")).toBe(false)
    expect(panels.get("category:column")?.has("keys")).toBe(false)

    // The product picker follows the requester selection; the requester picker never narrows itself.
    const options = requested.filter((url) => url.includes("/options?"))
    const productOptions = options.filter((url) => url.includes("dimension=product")).at(-1)
    const userOptions = options.filter((url) => url.includes("dimension=user")).at(-1)
    expect(productOptions).toContain("userIds=u2")
    expect(productOptions).toContain("statuses=consumed")
    expect(userOptions).toContain("statuses=consumed")
    expect(userOptions).not.toContain("userIds=")
  })

  it("drops a compared requester the newly selected branch does not list, and keeps the rest", () => {
    const { rerender } = render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()
    expect(panelRequests().get("user:column")?.get("userIds")).toBe("u1,u2")

    // Branch 9 lists Sana and Bilal; Ahmed ordered nothing there, so comparing
    // him would narrow all seven panels to a person with no rows in scope.
    requested.length = 0
    rerender(<SideBySideWorkspace filters={{ ...filters(), branchIds: ["9"] }} />)

    const panels = panelRequests()
    expect(panels.size).toBe(7)
    for (const params of panels.values()) {
      expect(params.get("branchIds")).toBe("9")
      expect(params.get("userIds")).toBe("u2")
    }
    // One person left, so the trigger names them rather than counting.
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(screen.getByRole("button", { name: /Sana/ })).toBeTruthy()
  })

  it("keeps the whole comparison when every compared requester orders at the new branch too", () => {
    const { rerender } = render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All requesters/)
    fireEvent.click(within(list).getByText("Sana"))

    requested.length = 0
    rerender(<SideBySideWorkspace filters={{ ...filters(), branchIds: ["9"] }} />)

    for (const params of panelRequests().values()) expect(params.get("userIds")).toBe("u2")
  })

  it("leaves the comparison alone while the new requester list is still in flight", () => {
    const { rerender } = render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()

    // No answer yet for the new branch: dropping against an empty list would
    // silently discard a selection the reader made a moment ago.
    optionsPending = true
    requested.length = 0
    rerender(<SideBySideWorkspace filters={{ ...filters(), branchIds: ["9"] }} />)

    for (const params of panelRequests().values()) expect(params.get("userIds")).toBe("u1,u2")
  })

  it("turns the product panel into the requester × product grid once two people are compared", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    // One person compared: the product panel is still its plain ranking, and no grid is asked for.
    const list = openPicker(/All requesters/)
    let panels = after(() => fireEvent.click(within(list).getByText("Ahmed")))
    expect(panels.has("product:column")).toBe(true)
    expect(gridUrls()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "grid cell" })).toBeNull()

    // Two: the product panel is served by the grid — requesters as rows,
    // products as columns, drawn grouped — and its ranking request is gone.
    requested.length = 0
    fireEvent.click(within(list).getByText("Sana"))
    panels = panelRequests()
    expect(panels.has("product:column")).toBe(false)
    expect(panels.has("product:line")).toBe(true)
    expect(screen.getAllByRole("button", { name: "grid cell" })).toHaveLength(1)
    expect(gridUrls()).toHaveLength(1)
    const grid = gridRequest()
    expect(grid.get("rows")).toBe("user")
    expect(grid.get("columns")).toBe("product")
    expect(grid.get("userIds")).toBe("u1,u2")
    expect(grid.get("limit")).toBe("12")
    // The panel keeps its place, its title and its question.
    expect(panelTitles()).toEqual([
      "By product", "By category", "By requester", "By branch", "By month",
      "Requesters over months", "Products over months",
    ])

    // Untick one and the plain ranking is back.
    panels = after(() => fireEvent.click(within(list).getByText("Ahmed")))
    expect(panels.has("product:column")).toBe(true)
    expect(gridUrls()).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "grid cell" })).toBeNull()
  })

  it("keeps By product in the single-product layout with day-by-day, and back", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All products/)
    const panels = after(() => fireEvent.click(within(list).getByText("A4 Paper")))

    // The selected product's total remains visible; only the redundant
    // category and product-over-time panels are withheld.
    expect(panelTitles()).toEqual([
      "By product", "By requester", "By branch", "By month", "Requesters over months", "Day-by-day consumption",
    ])
    expect(requested.filter((url) => url.includes("/matrix?"))).toHaveLength(0)
    expect(screen.getByText("A4 Paper", { selector: "strong" })).toBeTruthy()
    expect(screen.getByText(/compared across products, requesters, branches and months at once/)).toBeTruthy()
    expect(screen.getByText(/Day-by-day consumption is shown below/)).toBeTruthy()
    expect([...panels.keys()].sort()).toEqual(["branch:column", "day:line", "month:column", "product:column", "user:column", "user:line"])
    for (const params of panels.values()) expect(params.get("productIds")).toBe("186")

    fireEvent.click(within(list).getByText("Toner"))
    expect(panelTitles()).toContain("By product")
    expect(panelTitles()).toContain("By category")
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

    expect(panels.size).toBe(6)
    for (const params of panels.values()) {
      expect(params.get("metric")).toBe("quantity")
      expect(params.get("statuses")).toBe("revenue")
      expect(params.get("productIds")).toBe("186")
      expect(params.get("userIds")).toBe("u1")
    }
    expect(screen.getByText(/measured by quantity/)).toBeTruthy()
    expect(document.getElementById("executive-drill-down")).not.toBeNull()
    const drill = new URL(`http://x${requested.filter((u) => u.includes("/drill-down?")).at(-1)}`).searchParams
    expect(drill.get("metric")).toBe("quantity")
    expect(drill.has("statuses")).toBe(false)
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
    expect(panels.size).toBe(7)
    for (const params of panels.values()) {
      expect(params.has("productIds")).toBe(false)
      expect(params.get("branchIds")).toBe("7")
    }
  })
})

describe("the budget beside By branch and By month", () => {
  const budgetRequests = () => [...panelRequests().entries()]
    .filter(([, params]) => params.get("budget") === "1")
    .map(([id]) => id)
    .sort()
  const withheldNotes = () => screen.queryAllByText(/Budget is (money|held per branch)/).map((note) => note.textContent)

  it("is asked for under Amount with nothing focused, drawn with its legend and note, and never on the Explore-style panels", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    expect(budgetRequests()).toEqual(["branch:column", "month:column"])
    expect(withheldNotes()).toEqual([])
    // The two panels' tables carry the budget columns; no other panel's does.
    fireEvent.click(screen.getByRole("button", { name: "Show By branch as a table" }))
    let table = screen.getByRole("table")
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Branch", "Consumed", "Total Budget", "% of budget", "Share", "vs prior", "Orders",
    ])
    expect(within(table).getByText("25.0%")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Show By branch as a chart" }))
    fireEvent.click(screen.getByRole("button", { name: "Show By requester as a table" }))
    table = screen.getByRole("table")
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).not.toContain("Total Budget")
  })

  it("is withdrawn under Quantity, because a budget is money, and the panels say so", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    after(() => fireEvent.click(screen.getByRole("button", { name: "Quantity" })))
    expect(budgetRequests()).toEqual([])
    expect(withheldNotes()).toEqual([
      "Budget is money, so it is shown beside the bars only when measuring by amount.",
      "Budget is money, so it is shown beside the bars only when measuring by amount.",
    ])
  })

  it("is withdrawn while a product is in focus, and comes back when the focus is cleared", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All products/)
    after(() => fireEvent.click(within(list).getByText("A4 Paper")))
    expect(budgetRequests()).toEqual([])
    expect(withheldNotes()).toEqual([
      "Budget is held per branch, not per product, so it is shown only against all products. Clear the product focus to see it.",
      "Budget is held per branch, not per product, so it is shown only against all products. Clear the product focus to see it.",
    ])

    after(() => fireEvent.click(screen.getByRole("button", { name: /Clear selection/ })))
    expect(budgetRequests()).toEqual(["branch:column", "month:column"])
    expect(withheldNotes()).toEqual([])
  })

  it("is withdrawn while requesters are compared, naming them as what to clear", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    const list = openPicker(/All requesters/)
    after(() => fireEvent.click(within(list).getByText("Ahmed")))
    expect(budgetRequests()).toEqual([])
    expect(withheldNotes()).toHaveLength(2)
    expect(withheldNotes()[0]).toMatch(/not per requester.*Clear the requesters to see it\./)
  })

  it("is withdrawn under a category filter from the filter bar, which narrows to lines the budget cannot follow", () => {
    render(<SideBySideWorkspace filters={{ ...filters(), categoryIds: ["4"] }} />)
    expect(budgetRequests()).toEqual([])
    expect(withheldNotes()[0]).toMatch(/not per product/)
  })
})

describe("what the panels say", () => {
  it("shows the server's unit-conflict message in place of every chart", () => {
    blocked = { reason: "unit-conflict", message: "Quantity cannot be totalled across Litre, Ream. Choose one unit of measure, or narrow the selection to products sharing one." }
    render(<SideBySideWorkspace filters={filters()} />)
    expect(screen.getAllByText(/Quantity cannot be totalled across Litre, Ream/)).toHaveLength(7)
    expect(screen.queryByRole("button", { name: /^bar / })).toBeNull()
  })

  it("footnotes the unit every panel is measured in", () => {
    selectedUnit = "Ream"
    render(<SideBySideWorkspace filters={filters()} />)
    const notes = screen.getAllByText(/Other units in this period are excluded rather than added to it/)
    expect(notes).toHaveLength(7)
    expect(notes[0].textContent).toContain("Measured in Ream only")
  })

  it("explains an empty panel instead of drawing nothing", () => {
    emptyRows = true
    render(<SideBySideWorkspace filters={filters()} />)
    expect(screen.getAllByText("Nothing in the selected period under these filters.")).toHaveLength(7)
  })

  it("offers every panel as a table, the ranked ones included, opening the same drill-down from a row", () => {
    render(<SideBySideWorkspace filters={filters()} />)

    // "Graph + table" on all seven, not only the trends.
    expect(screen.getAllByRole("button", { name: /^Show .* as a table$/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Show By product as a table", "Show By category as a table", "Show By requester as a table",
      "Show By branch as a table", "Show By month as a table",
      "Show Requesters over months as a table", "Show Products over months as a table",
    ])

    fireEvent.click(screen.getByRole("button", { name: "Show By branch as a table" }))
    const table = screen.getByRole("table")
    // The branch panel carries its budget beside the figure under Amount.
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Branch", "Consumed", "Total Budget", "% of budget", "Share", "vs prior", "Orders",
    ])
    expect(within(table).getByRole("button", { name: "North Zone" })).toBeTruthy()
    // The chart of that one panel has given way to its rows; the others still draw.
    expect(screen.queryByRole("button", { name: "bar branch" })).toBeNull()
    expect(screen.getByRole("button", { name: "bar month" })).toBeTruthy()

    fireEvent.click(within(table).getByRole("button", { name: "North Zone" }))
    expect(document.getElementById("executive-drill-down")).not.toBeNull()
    const drill = new URL(`http://x${requested.filter((u) => u.includes("/drill-down?")).at(-1)}`).searchParams
    expect(drill.get("dimension")).toBe("branch")
    expect(drill.get("key")).toBe("7")
    expect(drill.get("statuses")).toBe("consumed")

    fireEvent.click(screen.getByRole("button", { name: "Show By branch as a chart" }))
    expect(screen.getByRole("button", { name: "bar branch" })).toBeTruthy()
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
      "By branch", "By product", "By category", "By requester", "By month",
      "Requesters over months", "Products over months",
    ])

    fireEvent.click(byBranch)
    expect(cardOf(byBranch).className).not.toContain("xl:col-span-2")
    expect(panelTitles()[3]).toBe("By branch")

    // The product panel widens the same way once it has become the grid.
    compareAhmedAndSana()
    expect(screen.getByRole("button", { name: "grid cell" })).toBeTruthy()
    const grid = screen.getByRole("checkbox", { name: "Show By product at full width" })
    fireEvent.click(grid)
    expect(cardOf(grid).className).toContain("xl:col-span-2")
    expect(panelTitles()[0]).toBe("By product")
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

describe("drill-down from the grid", () => {
  it("opens the order lines for one pair: the person as the key, the product as a narrowing", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()
    const list = openPicker(/All products/)
    fireEvent.click(within(list).getByText("A4 Paper"))
    fireEvent.click(within(list).getByText("Toner"))

    fireEvent.click(screen.getByRole("button", { name: "grid cell" }))
    expect(document.getElementById("executive-drill-down")).not.toBeNull()
    const drill = new URL(`http://x${requested.filter((u) => u.includes("/drill-down?")).at(-1)}`).searchParams
    expect(drill.get("dimension")).toBe("user")
    expect(drill.get("key")).toBe("u2")
    // The cell's product replaces the screen's two-product focus for this table alone.
    expect(drill.get("productIds")).toBe("187")
    expect(drill.get("branchIds")).toBe("7")
    expect(drill.get("statuses")).toBe("consumed")
  })

  it("offers the same from the grid's table, one button per pair with a figure", () => {
    render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()
    fireEvent.click(screen.getByRole("button", { name: "Show By product as a table" }))
    const table = screen.getByRole("table")
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Requester", "A4 Paper", "Toner", "Total",
    ])
    fireEvent.click(within(table).getByRole("button", { name: /^Ahmed, Toner:/ }))
    const drill = new URL(`http://x${requested.filter((u) => u.includes("/drill-down?")).at(-1)}`).searchParams
    expect(drill.get("key")).toBe("u1")
    expect(drill.get("productIds")).toBe("187")
  })
})

describe("download as Excel", () => {
  const downloadButton = () => screen.getByRole("button", { name: /Download Excel/ }) as HTMLButtonElement

  it("waits until every panel has answered", () => {
    panelsLoading = true
    render(<SideBySideWorkspace filters={filters()} />)
    expect(downloadButton().disabled).toBe(true)
    fireEvent.click(downloadButton())
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("writes the cover sheet and one sheet per panel on screen, under the current focus and filters", async () => {
    render(<SideBySideWorkspace filters={{ ...filters(), groupIds: ["4"] }} />)
    expect(downloadButton().disabled).toBe(false)

    fireEvent.click(within(openPicker(/All products/)).getByText("A4 Paper"))
    fireEvent.click(within(openPicker(/All requesters/)).getByText("Sana"))
    fireEvent.click(downloadButton())

    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const [workbook, filename] = writeFile.mock.calls[0]

    // Exactly the single-focus layout, in registry order, behind a cover sheet.
    expect(workbook.SheetNames).toEqual([
      "Report", "By product", "By requester", "By branch", "By month", "Requesters over months", "Day-by-day consumption",
    ])
    expect(filename).toMatch(/^product-performance-amount-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/)

    // The cover names what was selected — the branch by name, not by id.
    const cover = workbook.Sheets.Report.rows
    expect(cover).toContainEqual(["Products in focus", "A4 Paper"])
    expect(cover).toContainEqual(["Requesters compared", "Sana"])
    expect(cover).toContainEqual(["Groups", "Distribution"])
    expect(cover).toContainEqual(["Branches", "North Zone"])
    expect(cover).toContainEqual(["Measured by", "Amount (Consumed)"])

    // A ranked sheet: header, then the mocked row with money in rupees.
    const branch = workbook.Sheets["By branch"].rows
    expect(branch[0]).toEqual([
      "Rank", "Branch", "Consumed (PKR)", "Share %", "Cumulative share %",
      "Previous period Consumed (PKR)", "Change %", "Orders",
    ])
    expect(branch[1]).toEqual([1, "North Zone", 1, 100, 100, 0, null, 1])

    // A trend sheet: one column per period and a total.
    const trend = workbook.Sheets["Requesters over months"].rows
    expect(trend[0]).toEqual(["Requester", "2026-07", "Total Consumed (PKR)"])
    expect(trend[1]).toEqual(["Ahmed", 0.01, 0.01])
  })

  it("writes the screen's own explanation for a panel with nothing to draw", async () => {
    blocked = { reason: "unit-conflict", message: "Quantity cannot be totalled across Litre, Ream." }
    render(<SideBySideWorkspace filters={filters()} />)
    fireEvent.click(downloadButton())

    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const [workbook] = writeFile.mock.calls[0]
    expect(workbook.SheetNames).toHaveLength(8)
    expect(workbook.Sheets["By product"].rows).toEqual([["Note"], ["Quantity cannot be totalled across Litre, Ream."]])
  })

  it("writes the product panel as the grid once two people are compared: one row per person, margins included", async () => {
    render(<SideBySideWorkspace filters={filters()} />)
    compareAhmedAndSana()
    fireEvent.click(downloadButton())

    await waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1))
    const [workbook] = writeFile.mock.calls[0]
    expect(workbook.SheetNames).toContain("By product")
    // The grid as drawn: one row per requester, one column per product, the
    // person's total last and the products' totals along the bottom.
    const grid = workbook.Sheets["By product"].rows
    expect(grid[0]).toEqual(["Requester / Product", "A4 Paper", "Toner", "Total Consumed (PKR)"])
    expect(grid[1]).toEqual(["Ahmed", 4, 3, 7])
    expect(grid[2]).toEqual(["Sana", 2, 1, 3])
    expect(grid[3]).toEqual(["Total", 6, 4, null])
  })
})
