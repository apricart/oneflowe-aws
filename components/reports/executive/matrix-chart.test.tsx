import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { MatrixChart, MatrixTable, cellDrillTarget, indexCells, type MatrixResponse } from "./matrix-chart"

/**
 * The requester × product grid, as the reader sees it.
 *
 * Recharts draws nothing in jsdom, so the columns are checked through the
 * legend and the copy, and the figures through the table — which is also the
 * path a screen reader takes. What matters most is the drill target a cell
 * produces: the person as the key and the product as a narrowing, which is
 * what makes the detail table show that pair and not the person across every
 * focused product.
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

/** The money formatter separates "Rs" from the figure with a non-breaking space. */
const text = (node: Element) => (node.textContent ?? "").replace(/\u00a0/g, " ")

const AHMED = "6ec33598-9ec2-4a1a-86df-cd0801ee0178"
const SANA = "0f9a2d4c-7b1e-4e3a-9c5d-2a6b8c0d1e2f"

const response = (over: Partial<MatrixResponse> = {}): MatrixResponse => ({
  rowDimension: "user",
  columnDimension: "product",
  rowLabel: "Requester",
  columnLabel: "Product",
  metric: "spend",
  grain: "line",
  format: "currency",
  label: "Procurement Value",
  formula: "",
  period: { startDate: "2026-06-01", endDate: "2026-08-31" },
  quantityUnit: { selected: null, conflict: false, available: [] },
  limits: { rows: 12, columns: 12 },
  rows: [{ key: AHMED, label: "Ahmed", total: 13000 }, { key: SANA, label: "Sana", total: 8500 }],
  columns: [
    { key: "186", label: "Paper", total: 10500 },
    { key: "187", label: "Toner", total: 6000 },
    { key: "188", label: "Diesel", total: 5000 },
  ],
  cells: [
    { row: AHMED, column: "186", value: 7000, spendCents: 7000, quantity: 14, orderCount: 2 },
    { row: AHMED, column: "187", value: 6000, spendCents: 6000, quantity: 2, orderCount: 1 },
    { row: SANA, column: "186", value: 3500, spendCents: 3500, quantity: 7, orderCount: 2 },
    { row: SANA, column: "188", value: 5000, spendCents: 5000, quantity: 50, orderCount: 1 },
  ],
  ...over,
})

describe("a cell's drill target", () => {
  it("names the row entity as the key and the column entity as a narrowing of the shared filters", () => {
    const target = cellDrillTarget(response(), { key: AHMED, label: "Ahmed", total: 0 }, { key: "187", label: "Toner", total: 0 })
    expect(target).toEqual({
      dimension: "user",
      key: AHMED,
      label: "Ahmed · Toner",
      narrow: { productIds: ["187"] },
    })
  })

  it("follows the axes whichever way the grid is laid", () => {
    const transposed = response({ rowDimension: "product", columnDimension: "user" })
    const target = cellDrillTarget(transposed, { key: "187", label: "Toner", total: 0 }, { key: AHMED, label: "Ahmed", total: 0 })
    expect(target).toEqual({ dimension: "product", key: "187", label: "Toner · Ahmed", narrow: { userIds: [AHMED] } })

    const byBranch = response({ rowDimension: "user", columnDimension: "branch" })
    expect(cellDrillTarget(byBranch, { key: AHMED, label: "Ahmed", total: 0 }, { key: "7", label: "North", total: 0 }).narrow)
      .toEqual({ branchIds: ["7"] })
    const byCategory = response({ rowDimension: "branch", columnDimension: "category" })
    expect(cellDrillTarget(byCategory, { key: "7", label: "North", total: 0 }, { key: "4", label: "Fuel", total: 0 }).narrow)
      .toEqual({ categoryIds: ["4"] })
  })

  it("indexes cells by pair so a lookup never scans", () => {
    const index = indexCells(response().cells)
    expect(index.get(`${AHMED}|186`)?.value).toBe(7000)
    expect(index.has(`${AHMED}|188`)).toBe(false)
  })
})

describe("the grid table", () => {
  it("shows every pair as its own figure, a dash for a pair that never happened, and the margins", () => {
    render(<MatrixTable response={response()} />)
    const table = within(screen.getByRole("table"))

    expect(table.getByRole("columnheader", { name: "Requester" })).toBeTruthy()
    for (const name of ["Paper", "Toner", "Diesel", "Total"]) expect(table.getByRole("columnheader", { name })).toBeTruthy()

    // Ahmed's row: Paper 7,000 · Toner 6,000 · Diesel — · total 13,000.
    const ahmed = table.getByRole("row", { name: /Ahmed/ })
    const cells = within(ahmed).getAllByRole("cell").map(text)
    expect(cells).toEqual(["Rs 70", "Rs 60", "—", "Rs 130"])
    expect(within(ahmed).getByLabelText("Ahmed, Diesel: nothing")).toBeTruthy()

    // The column margins along the bottom.
    const totals = table.getByRole("row", { name: /^Total/ })
    expect(within(totals).getAllByRole("cell").map(text)).toEqual(["Rs 105", "Rs 60", "Rs 50", ""])
  })

  it("opens the order lines for exactly the clicked pair", () => {
    const onDrillDown = vi.fn()
    render(<MatrixTable response={response()} onDrillDown={onDrillDown} />)
    fireEvent.click(screen.getByRole("button", { name: /Sana, Diesel: Rs\u00a050/ }))
    expect(onDrillDown).toHaveBeenCalledWith({
      dimension: "user",
      key: SANA,
      label: "Sana · Diesel",
      narrow: { productIds: ["188"] },
    })
    // A pair that never happened has nothing to open.
    expect(screen.queryByRole("button", { name: /Ahmed, Diesel/ })).toBeNull()
  })

  it("renders nothing without both axes, and says why order cells do not add up", () => {
    const { container } = render(<MatrixTable response={response({ rows: [] })} />)
    expect(container.querySelector("table")).toBeNull()

    render(<MatrixTable response={response({ metric: "orders", format: "count", label: "Orders" })} />)
    expect(screen.getByText(/one order in each cell and one order in the margin/)).toBeTruthy()
    expect(screen.getAllByRole("columnheader", { name: "Orders" })).toHaveLength(1)
  })
})

describe("the grid columns", () => {
  it("names every requester in the legend, and says the figures are never combined", () => {
    render(<MatrixChart response={response()} onDrillDown={() => {}} />)
    const legend = screen.getByRole("list")
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ahmed", "Sana"])
    expect(screen.getByText(/never combined across requesters/)).toBeTruthy()
    expect(screen.getByText(/Select any column to open the order lines/)).toBeTruthy()
  })

  it("does not invite a click when nothing handles it", () => {
    render(<MatrixChart response={response()} />)
    expect(screen.queryByText(/Select any column/)).toBeNull()
  })
})
