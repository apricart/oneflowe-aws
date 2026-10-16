import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The warehouse's Global Products view. The server admits only GET
 * (lib/warehouse-access.test.ts, tests/integration/warehouse-*.test.ts); this
 * pins what the screen does with what it is given: the base price, as Super
 * Admin's Global Products shows it (plans/OF-WAREHOUSE-full-read-only-catalog.md,
 * which reversed the earlier no-price rule), no control that creates, edits or
 * deletes, and the query it asks for.
 */

const state = vi.hoisted(() => ({
  respond: (_url: string): unknown => undefined,
  error: undefined as unknown,
  keys: [] as string[],
}))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) state.keys.push(key)
    return { data: key ? state.respond(key) : undefined, error: state.error, isLoading: false, mutate: vi.fn() }
  },
}))
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }))

import { WarehouseCatalog } from "@/components/warehouse/warehouse-catalog"

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  productCode: "PRD-1",
  name: "Green Tea 80gm",
  unit: "80 gm",
  status: "active",
  basePriceCents: 35_500,
  stockQuantity: 120,
  low: false,
  imageUrl: null,
  category: "Beverages",
  subcategory: "Tea",
  ...overrides,
})

const page = (items: unknown[], total = items.length) => ({ items, total, page: 1, limit: 50, lowStockThreshold: 10 })

const categories = {
  categories: [{ id: 1, name: "Beverages", subcategories: [{ id: 12, name: "Tea" }] }],
}

function answer(catalog: unknown) {
  state.respond = (url) => (url.startsWith("/api/v1/warehouse/catalog/categories") ? categories : catalog)
}

beforeEach(() => {
  state.keys = []
  state.error = undefined
})
afterEach(() => cleanup())

describe("the Product Catalog tab", () => {
  it("lists products with their category, unit, base price, status and stock", () => {
    answer(page([
      item(),
      item({ id: 2, productCode: "PRD-2", name: "A4 Paper", unit: "Ream", status: "inactive", stockQuantity: 0, low: true, category: null, subcategory: null }),
    ]))
    render(<WarehouseCatalog />)

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent)
    expect(headers).toEqual(["Product", "Category", "Subcategory", "Unit", "Base price", "Status", "In stock"])

    const rows = screen.getAllByRole("row").slice(1)
    expect(within(rows[0]).getByText("Green Tea 80gm")).toBeTruthy()
    expect(within(rows[0]).getByText("PRD-1")).toBeTruthy()
    expect(within(rows[0]).getByText("Beverages")).toBeTruthy()
    expect(within(rows[0]).getByText("Tea")).toBeTruthy()
    expect(within(rows[0]).getByText(/355/)).toBeTruthy()
    expect(within(rows[1]).getByText("Uncategorized")).toBeTruthy()
    expect(within(rows[1]).getByText("Low")).toBeTruthy()
    expect(screen.getByText("Showing 1–2 of 2 products")).toBeTruthy()
  })

  it("offers nothing to create, edit or delete", () => {
    answer(page([item()]))
    render(<WarehouseCatalog />)
    // The only buttons are the filter pickers; with one page there is no pager.
    const buttons = screen.queryAllByRole("button").map((button) => button.textContent ?? "")
    expect(buttons.join(" ")).not.toMatch(/create|add|edit|delete|remove|save|assign|update/i)
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("asks for active products first and sends the search it is given", () => {
    answer(page([item()]))
    render(<WarehouseCatalog />)
    expect(state.keys).toContain("/api/v1/warehouse/catalog/categories")
    expect(state.keys).toContain("/api/v1/warehouse/catalog?page=1&status=active")
    // Typing moves the pager back to the first page; the debounce sends it later.
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "tea" } })
    expect(state.keys.every((key) => !key.includes("price"))).toBe(true)
  })

  it("pages through a long catalogue", () => {
    answer(page([item()], 120))
    render(<WarehouseCatalog />)
    expect(screen.getByText("Page 1 of 3")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(state.keys).toContain("/api/v1/warehouse/catalog?page=2&status=active")
  })

  it("says so when nothing matches, and when the read fails", () => {
    answer(page([]))
    render(<WarehouseCatalog />)
    expect(screen.getByText("The catalogue has no products yet.")).toBeTruthy()
    cleanup()

    state.error = new Error("boom")
    answer(undefined)
    render(<WarehouseCatalog />)
    expect(screen.getByRole("alert").textContent).toBe("The product catalogue could not be loaded.")
  })

  it("shows a stored picture, and a placeholder otherwise", () => {
    answer(page([item({ imageUrl: "/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.webp" }), item({ id: 2 })]))
    const { container } = render(<WarehouseCatalog />)
    const images = container.querySelectorAll("img")
    expect(images).toHaveLength(1)
    expect(images[0].getAttribute("src")).toBe("/api/v1/images/products/0f8fad5b-d9cb-469f-a165-70867728950e.webp")
  })
})
