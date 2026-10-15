import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The warehouse's read-only catalogue views
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md). The server decides what may
 * be read; these pin what each screen shows, what it asks for, and that none
 * of them offers anything that writes.
 */

const state = vi.hoisted(() => ({
  respond: (_url: string): unknown => undefined,
  keys: [] as string[],
}))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) state.keys.push(key)
    return { data: key ? state.respond(key) : undefined, error: undefined, isLoading: false, mutate: vi.fn() }
  },
}))
vi.mock("@/lib/fetcher", () => ({ fetcher: vi.fn() }))

import { WarehouseGroupProducts } from "@/components/warehouse/catalog/warehouse-group-products"
import { WarehouseOrganizationProducts } from "@/components/warehouse/catalog/warehouse-organization-products"
import { WarehouseProductRequests } from "@/components/warehouse/catalog/warehouse-product-requests"
import { WarehouseTaxonomy } from "@/components/warehouse/catalog/warehouse-taxonomy"

const organizations = { organizations: [{ id: 7, name: "KE" }, { id: 9, name: "UBL" }] }

function respond(routes: Record<string, unknown>) {
  state.respond = (url) => {
    const path = url.split("?")[0]
    return routes[path]
  }
}

/** No button whose words would write: nothing to add, edit, delete, assign, approve or save. */
function expectNoWriteControl() {
  const words = screen.queryAllByRole("button").map((button) => button.textContent ?? "")
  for (const word of words) expect(word).not.toMatch(/\b(add|create|new|edit|delete|remove|assign|approve|reject|save|update|activate)\b/i)
  expect(document.querySelector("form")).toBeNull()
}

beforeEach(() => {
  state.keys.length = 0
})
afterEach(() => cleanup())

describe("Organization Products", () => {
  it("lists the first organization's products with base and custom prices, read-only", () => {
    respond({
      "/api/v1/warehouse/catalog/organizations": organizations,
      "/api/v1/warehouse/catalog/organization-products": {
        items: [
          { id: 1, productCode: "PRD-1", name: "Green Tea", imageUrl: null, unit: "80 gm", category: "Beverages", subcategory: "Tea", basePriceCents: 35_500, customPriceCents: 33_000, effectivePriceCents: 33_000, active: true, assignedAt: "2026-10-01T00:00:00.000Z" },
          { id: 2, productCode: "PRD-2", name: "Paper", imageUrl: null, unit: "Ream", category: null, subcategory: null, basePriceCents: 120_000, customPriceCents: null, effectivePriceCents: 120_000, active: false, assignedAt: null },
        ],
        total: 2,
        page: 1,
        limit: 50,
      },
    })
    render(<WarehouseOrganizationProducts />)
    expect(state.keys).toContain("/api/v1/warehouse/catalog/organization-products?organizationId=7&status=all&page=1")
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(
      ["Product", "Category", "Base price", "Custom price", "Status", "Assigned on"],
    )
    const rows = screen.getAllByRole("row").slice(1)
    expect(within(rows[0]).getByText(/330/)).toBeTruthy()
    expect(within(rows[1]).getByText("Base")).toBeTruthy()
    expect(within(rows[1]).getByText("inactive")).toBeTruthy()
    expect(screen.getByText("View only")).toBeTruthy()
    expectNoWriteControl()
  })

  it("says so when no organization is in reach, and asks for no products", () => {
    respond({ "/api/v1/warehouse/catalog/organizations": { organizations: [] } })
    render(<WarehouseOrganizationProducts />)
    expect(screen.getByText(/No organization is in your reach yet/)).toBeTruthy()
    expect(state.keys.some((key) => key.includes("organization-products"))).toBe(false)
  })
})

describe("Group Products", () => {
  it("lists the organization's groups first and asks to choose one before any product", () => {
    const groups = [{ id: 3, name: "Distribution", branches: ["Clifton", "Gulberg"] }]
    respond({
      "/api/v1/warehouse/catalog/organizations": organizations,
      "/api/v1/warehouse/catalog/group-products": { groups, group: null, items: [], total: 0, page: 1, limit: 50 },
    })
    render(<WarehouseGroupProducts />)
    expect(state.keys).toContain("/api/v1/warehouse/catalog/group-products?organizationId=7&page=1")
    expect(screen.getByText("Choose a group to see its products.")).toBeTruthy()

    expectNoWriteControl()
  })
})

describe("Product Requests", () => {
  const request = {
    id: 11,
    status: "APPROVED",
    productName: "Oat Milk",
    brand: "Oatly",
    description: "1 litre cartons",
    category: "Beverages",
    subcategory: "Milk",
    unit: "carton",
    packSize: "12",
    barcode: "123",
    expectedPriceCents: 89_900,
    estimatedMonthlyQuantity: 40,
    preferredSupplier: "Metro",
    referenceUrl: "javascript:alert(1)",
    notes: null,
    imageUrl: null,
    reviewNote: "Listed from November",
    estimatedAvailableOn: "2026-11-01",
    organizationName: "KE",
    createdAt: "2026-10-01T00:00:00.000Z",
    reviewedAt: "2026-10-05T00:00:00.000Z",
  }

  beforeEach(() => {
    respond({
      "/api/v1/warehouse/catalog/organizations": organizations,
      "/api/v1/warehouse/catalog/product-requests": { items: [request], total: 1, counts: { APPROVED: 1, PENDING: 2 }, page: 1, limit: 50 },
    })
  })

  it("lists requests with their status counts and expected price, and names no person", () => {
    render(<WarehouseProductRequests />)
    expect(state.keys).toContain("/api/v1/warehouse/catalog/product-requests?page=1")
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).not.toContain("Requested by")
    expect(screen.getByRole("button", { name: /All\s*3/ })).toBeTruthy()
    expect(screen.getByText("Oat Milk")).toBeTruthy()
    expect(screen.getByText(/899/)).toBeTruthy()
  })

  it("filters by status through the query string", () => {
    render(<WarehouseProductRequests />)
    fireEvent.click(screen.getByRole("button", { name: /Pending/ }))
    expect(state.keys.at(-1)).toContain("status=PENDING")
  })

  it("opens a request's details as plain text, never as a link", () => {
    render(<WarehouseProductRequests />)
    fireEvent.click(screen.getByRole("button", { name: "Show details" }))
    expect(screen.getByText("Listed from November")).toBeTruthy()
    expect(screen.getByText("javascript:alert(1)").closest("a")).toBeNull()
    expect(document.querySelector("a[href^='javascript']")).toBeNull()
    expectNoWriteControl()
  })
})

describe("Categories and Subcategories", () => {
  it("lists categories with their counts", () => {
    respond({
      "/api/v1/warehouse/catalog/taxonomy/categories": {
        items: [{ id: 1, name: "Beverages", parentId: null, parentName: null, subcategoriesCount: 4, productsCount: 31, createdAt: "2026-09-01T00:00:00.000Z" }],
        total: 1,
        truncated: false,
      },
    })
    render(<WarehouseTaxonomy level="category" />)
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Subcategories", "Products", "Created"])
    expect(screen.getByText("31")).toBeTruthy()
    expectNoWriteControl()
  })

  it("lists subcategories with their parent, and offers the categories as a filter", () => {
    respond({
      "/api/v1/warehouse/catalog/taxonomy/categories": { items: [{ id: 1, name: "Beverages", parentId: null, parentName: null, subcategoriesCount: 1, productsCount: 3, createdAt: null }], total: 1, truncated: false },
      "/api/v1/warehouse/catalog/taxonomy/subcategories": {
        items: [{ id: 12, name: "Tea", parentId: 1, parentName: "Beverages", subcategoriesCount: 0, productsCount: 3, createdAt: null }],
        total: 1,
        truncated: false,
      },
    })
    render(<WarehouseTaxonomy level="subcategory" />)
    expect(state.keys).toContain("/api/v1/warehouse/catalog/taxonomy/subcategories")
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Category", "Products", "Created"])
    expect(within(screen.getAllByRole("row")[1]).getByText("Beverages")).toBeTruthy()
    expectNoWriteControl()
  })
})
