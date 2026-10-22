import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The warehouse's queue screen. The server fences every row to the user's
 * branches (tests/integration/warehouse-*.test.ts); this pins what the screen
 * does with what it is given: which query it asks for, what it exports, and
 * that it never strands the user on an empty page or a short dispatch list.
 */

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  /** What the list endpoint answers, by requested page. */
  respond: (_url: string): unknown => undefined,
  keys: [] as string[],
  mutate: vi.fn(),
}))

vi.mock("swr", () => ({
  default: (key: string) => {
    state.keys.push(key)
    return { data: state.respond(key), error: undefined, isLoading: false, isValidating: false, mutate: state.mutate }
  },
}))
const fetcher = vi.hoisted(() => vi.fn())
vi.mock("@/lib/fetcher", () => ({ fetcher }))
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ toast }))
const xlsx = vi.hoisted(() => ({ rows: [] as unknown[][], fileName: "", writes: 0 }))
vi.mock("xlsx", () => ({
  utils: {
    aoa_to_sheet: (rows: unknown[][]) => { xlsx.rows = rows; return { rows } },
    book_new: () => ({}),
    book_append_sheet: () => undefined,
  },
  writeFile: (_book: unknown, fileName: string) => { xlsx.fileName = fileName; xlsx.writes += 1 },
}))
vi.mock("@/components/warehouse/warehouse-order-sheet", () => ({
  WarehouseOrderSheet: ({ orderId }: { orderId: number | null }) => (orderId === null ? null : <div data-testid="sheet">sheet {orderId}</div>),
}))

import { WarehouseOrders } from "./warehouse-orders"

const reach = {
  organizations: [{ id: 1, name: "Meezan" }],
  branches: [{ id: 11, name: "North", organizationId: 1 }],
}
const counts = { NOT_STARTED: 3, IN_PROCESS: 1, OUT_FOR_DELIVERY: 2, DELIVERED_RECENT: 9 }

function row(id: number, overrides: Row = {}): Row {
  return {
    id,
    tid: `T-${id}`,
    invoiceNumber: `INV-${id}`,
    organizationName: "Meezan",
    branchName: "North",
    destination: "Lahore",
    stage: "NOT_STARTED",
    stageLabel: "Not Started",
    health: "ON_TRACK",
    healthLabel: "On Track",
    paymentStatus: "UNPAID",
    totalCents: 12_345,
    notes: null,
    approvedAt: "2026-10-01T05:00:00.000Z",
    deliveredAt: null,
    itemCount: 1,
    hasChallan: false,
    ...overrides,
  }
}

function page(items: Row[], total: number, pageNumber = 1, limit = 25) {
  return { items, total, page: pageNumber, limit, counts, reach }
}

const lastKey = () => new URL(state.keys[state.keys.length - 1], "http://localhost")

/** Would a spreadsheet read this cell as a formula? Leading whitespace and control characters are skipped, as Excel does. */
function looksLikeFormula(cell: string): boolean {
  let index = 0
  while (index < cell.length && cell.charCodeAt(index) <= 0x20) index += 1
  return index < cell.length && "=+-@".includes(cell[index])
}

beforeEach(() => {
  state.keys = []
  state.mutate.mockReset()
  state.respond = () => page([row(1)], 1)
  fetcher.mockReset()
  toast.mockReset()
  xlsx.rows = []
  xlsx.fileName = ""
  xlsx.writes = 0
})
afterEach(() => cleanup())

describe("the warehouse queue", () => {
  it("asks for open orders first, and each tab asks for its own view and stage", () => {
    render(<WarehouseOrders />)
    expect(Object.fromEntries(lastKey().searchParams)).toEqual({ view: "open", page: "1" })

    fireEvent.click(screen.getByRole("tab", { name: /Out for delivery/ }))
    expect(Object.fromEntries(lastKey().searchParams)).toEqual({ view: "open", stage: "OUT_FOR_DELIVERY", page: "1" })

    fireEvent.click(screen.getByRole("tab", { name: /Delivered/ }))
    expect(Object.fromEntries(lastKey().searchParams)).toEqual({ view: "delivered", page: "1" })
    expect(screen.getByRole("tab", { name: /Delivered/ }).getAttribute("aria-selected")).toBe("true")
  })

  it("shows each tab's count from the server", () => {
    render(<WarehouseOrders />)
    expect(within(screen.getByRole("tab", { name: /Not started/ })).getByText("3")).toBeTruthy()
    expect(within(screen.getByRole("tab", { name: /Delivered/ })).getByText("9")).toBeTruthy()
  })

  it("sends the search trimmed, and goes back to the first page when it changes", () => {
    state.respond = (url) => page([row(Number(new URL(url, "http://x").searchParams.get("page")))], 60)
    render(<WarehouseOrders />)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(lastKey().searchParams.get("page")).toBe("2")

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "  INV-7  " } })
    expect(lastKey().searchParams.get("q")).toBe("INV-7")
    expect(lastKey().searchParams.get("page")).toBe("1")
  })

  it("shows the numeric order ID and sends it through the server-backed search", () => {
    state.respond = () => page([row(742)], 1)
    render(<WarehouseOrders />)

    expect(screen.getByRole("columnheader", { name: "Order ID" })).toBeTruthy()
    expect(screen.getByText("742")).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "742" } })
    expect(lastKey().searchParams.get("q")).toBe("742")
  })

  it("renders hostile text as text, never as markup", () => {
    state.respond = () => page([row(1, { notes: null, destination: '<img src=x onerror="alert(1)">', branchName: "<script>alert(1)</script>" })], 1)
    const { container } = render(<WarehouseOrders />)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy()
  })

  it("opens the picking sheet for the row chosen", () => {
    state.respond = () => page([row(1), row(2)], 2)
    render(<WarehouseOrders />)
    fireEvent.click(screen.getByRole("button", { name: "T-2" }))
    expect(screen.getByTestId("sheet").textContent).toBe("sheet 2")
  })

  it("tells a user with no branches to ask Super Admin, rather than showing an empty list", () => {
    state.respond = () => ({ ...page([], 0), reach: { organizations: [], branches: [] } })
    render(<WarehouseOrders />)
    expect(screen.getByText(/No branches are assigned to you yet/)).toBeTruthy()
    expect((screen.getByRole("button", { name: /Excel/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("does not strand the user on a page that emptied while they were on it", async () => {
    // Page 2 of 2, then the auto-refresh finds the orders on it were delivered.
    let total = 30
    state.respond = (url) => {
      const pageNumber = Number(new URL(url, "http://x").searchParams.get("page"))
      return pageNumber === 1 ? page([row(1)], total, 1) : page(total > 25 ? [row(26)] : [], total, pageNumber)
    }
    const view = render(<WarehouseOrders />)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(lastKey().searchParams.get("page")).toBe("2")

    total = 20
    view.rerender(<WarehouseOrders />)
    await waitFor(() => expect(lastKey().searchParams.get("page")).toBe("1"))
    expect(screen.queryByText("No orders here.")).toBeNull()
  })
})

describe("the picking list export", () => {
  it("reads every page of the current filter with lines, and writes one file", async () => {
    state.respond = () => page([row(1)], 150)
    fetcher.mockImplementation(async (url: string) => {
      const params = new URL(url, "http://x").searchParams
      const current = Number(params.get("page"))
      const items = Array.from({ length: current === 1 ? 100 : 50 }, (_, index) => row(current * 1000 + index, {
        lines: [{ productCode: "P", productName: "Rice", unit: "kg", quantity: 1, priceCents: 100 }],
      }))
      return page(items, 150, current, 100)
    })
    render(<WarehouseOrders />)
    const excel = screen.getByRole("button", { name: /Excel/ })
    fireEvent.click(excel)
    fireEvent.click(excel)

    await waitFor(() => expect(xlsx.writes).toBe(1))
    expect(fetcher).toHaveBeenCalledTimes(2)
    for (const [url] of fetcher.mock.calls) {
      const params = new URL(url as string, "http://x").searchParams
      expect(params.get("lines")).toBe("1")
      expect(params.get("limit")).toBe("100")
      expect(params.get("view")).toBe("open")
    }
    // Header plus one row per line.
    expect(xlsx.rows).toHaveLength(1 + 150)
    expect(xlsx.fileName).toMatch(/^picking-list-\d{4}-\d{2}-\d{2}-\d{4}\.xlsx$/)
    expect(toast).not.toHaveBeenCalled()
  })

  it("neutralises formula-like text typed by tenant staff before it reaches the file", async () => {
    state.respond = () => page([row(1)], 1)
    fetcher.mockResolvedValue(page([row(1, {
      notes: '=HYPERLINK("http://evil.example","x")',
      branchName: "+cmd",
      lines: [{ productCode: "@SUM(1)", productName: "-2+3", unit: "kg", quantity: 1, priceCents: 100 }],
    })], 1, 1, 100))
    render(<WarehouseOrders />)
    fireEvent.click(screen.getByRole("button", { name: /CSV/ }))
    await waitFor(() => expect(xlsx.writes).toBe(1))
    expect(xlsx.fileName).toMatch(/\.csv$/)
    for (const cell of xlsx.rows.slice(1).flat()) {
      if (typeof cell === "string") expect(looksLikeFormula(cell), cell).toBe(false)
    }
  })

  it("says so when the filter holds more orders than one export carries", async () => {
    state.respond = () => page([row(1)], 2_500)
    fetcher.mockImplementation(async (url: string) => {
      const current = Number(new URL(url, "http://x").searchParams.get("page"))
      return page(Array.from({ length: 100 }, (_, index) => row(current * 1000 + index)), 2_500, current, 100)
    })
    render(<WarehouseOrders />)
    fireEvent.click(screen.getByRole("button", { name: /Excel/ }))
    await waitFor(() => expect(xlsx.writes).toBe(1))
    expect(fetcher).toHaveBeenCalledTimes(10)
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringMatching(/1,000 of 2,500/),
    }))
  })

  it("writes nothing and says so when a page fails", async () => {
    state.respond = () => page([row(1)], 150)
    fetcher.mockResolvedValueOnce(page([row(1)], 150, 1, 100)).mockRejectedValueOnce(new Error("network"))
    render(<WarehouseOrders />)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Excel/ })) })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Export failed" })))
    expect(xlsx.writes).toBe(0)
    // The buttons come back for another try.
    await waitFor(() => expect((screen.getByRole("button", { name: /Excel/ }) as HTMLButtonElement).disabled).toBe(false))
  })
})
