import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import {
  MatrixChart,
  MatrixTable,
  cellDrillTarget,
  columnData,
  indexCells,
  otherSegmentLabel,
  transposeMatrix,
  type MatrixResponse,
} from "./matrix-chart"

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

describe("the grid turned round", () => {
  it("swaps the axes, their labels, their caps and every cell, and changes no figure", () => {
    const turned = transposeMatrix(response({ limits: { rows: 12, columns: 6 } }))
    expect(turned.rowDimension).toBe("product")
    expect(turned.columnDimension).toBe("user")
    expect(turned.rowLabel).toBe("Product")
    expect(turned.columnLabel).toBe("Requester")
    expect(turned.limits).toEqual({ rows: 6, columns: 12 })
    expect(turned.rows.map((row) => row.label)).toEqual(["Paper", "Toner", "Diesel"])
    expect(turned.columns.map((column) => column.label)).toEqual(["Ahmed", "Sana"])
    expect(indexCells(turned.cells).get(`188|${SANA}`)?.value).toBe(5000)
    expect(indexCells(turned.cells).has(`${SANA}|188`)).toBe(false)
    // Turning it back is the identity.
    expect(transposeMatrix(turned)).toEqual(response({ limits: { rows: 12, columns: 6 } }))
  })

  it("drills a turned cell with the product as the key and the person as the narrowing", () => {
    const turned = transposeMatrix(response())
    const target = cellDrillTarget(turned, turned.rows[1], turned.columns[0])
    expect(target).toEqual({ dimension: "product", key: "187", label: "Toner · Ahmed", narrow: { userIds: [AHMED] } })
  })
})

describe("the figures behind a column", () => {
  it("carries every row's figure under its key, with a missing pair as zero", () => {
    const [paper, toner, diesel] = columnData(response())
    expect(paper).toMatchObject({ key: "186", label: "Paper", total: 10500, values: { [AHMED]: 7000, [SANA]: 3500 } })
    expect(toner.values).toEqual({ [AHMED]: 6000, [SANA]: 0 })
    expect(diesel.values).toEqual({ [AHMED]: 0, [SANA]: 5000 })
  })

  it("folds what the total holds beyond the rows on the axis into one remainder, never below zero", () => {
    // Every column's cells add up to its total, so there is nothing to fold.
    expect(columnData(response()).map((datum) => datum.other)).toEqual([0, 0, 0])

    // Paper's total is 12,000 but the two people shown account for 10,500:
    // the 1,500 is people beyond the cap, drawn as "other" so the column
    // still reaches its own total. A margin below its cells folds to zero.
    const capped = response({
      columns: [
        { key: "186", label: "Paper", total: 12000 },
        { key: "187", label: "Toner", total: 5000 },
        { key: "188", label: "Diesel", total: 5000 },
      ],
    })
    expect(columnData(capped).map((datum) => datum.other)).toEqual([1500, 0, 0])
  })

  it("names the remainder after the row entity", () => {
    expect(otherSegmentLabel("Requester")).toBe("Other requesters")
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

describe("the stacked columns", () => {
  it("keeps every requester in the legend and says a column is the product's total split into their shares", () => {
    render(<MatrixChart response={response()} onDrillDown={() => {}} stacked />)
    const legend = screen.getByRole("list")
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ahmed", "Sana"])
    expect(screen.getByText(/Each column is one product's procurement value in total; its segments are each requester's share of it\./)).toBeTruthy()
    expect(screen.queryByText(/never combined/)).toBeNull()
    expect(screen.getByText(/Select any segment to open the order lines/)).toBeTruthy()
    expect(screen.queryByText(/Other requesters/)).toBeNull()
  })

  it("adds the folded remainder to the legend and explains it, only when a total reaches past the rows shown", () => {
    const capped = response({
      columns: [
        { key: "186", label: "Paper", total: 12000 },
        { key: "187", label: "Toner", total: 6000 },
        { key: "188", label: "Diesel", total: 5000 },
      ],
    })
    render(<MatrixChart response={capped} stacked />)
    const legend = screen.getByRole("list")
    expect(within(legend).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Ahmed", "Sana", "Other requesters"])
    expect(screen.getByText(/Other requesters is the part from people beyond the 2 shown\./)).toBeTruthy()
  })
})

describe("the table's swatches", () => {
  const swatchesIn = (cells: HTMLElement[]) => cells.map((cell) => cell.querySelector("[aria-hidden]") !== null)

  it("sit on the rows for the grouped form and on the columns for the stacked one, so a person keeps one hue", () => {
    const { unmount } = render(<MatrixTable response={response()} />)
    let table = within(screen.getByRole("table"))
    expect(swatchesIn(table.getAllByRole("rowheader"))).toEqual([true, true, false])
    expect(swatchesIn(table.getAllByRole("columnheader"))).toEqual([false, false, false, false, false])
    unmount()

    render(<MatrixTable response={transposeMatrix(response())} seriesAxis="columns" />)
    table = within(screen.getByRole("table"))
    expect(table.getByRole("columnheader", { name: "Product" })).toBeTruthy()
    expect(table.getAllByRole("rowheader").map(text)).toEqual(["Paper", "Toner", "Diesel", "Total"])
    expect(swatchesIn(table.getAllByRole("rowheader"))).toEqual([false, false, false, false])
    // Product, Ahmed, Sana, Total: the two people carry the swatches.
    expect(swatchesIn(table.getAllByRole("columnheader"))).toEqual([false, true, true, false])
  })
})
