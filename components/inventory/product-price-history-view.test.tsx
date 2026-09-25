import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { ProductPriceHistoryResponse } from "@/lib/product-price-history"

const swr = vi.hoisted(() => ({
  use: vi.fn(),
  response: null as ProductPriceHistoryResponse | null,
}))

vi.mock("swr", () => ({
  default: (key: string) => {
    swr.use(key)
    return { data: swr.response, error: null, isLoading: false, isValidating: false, mutate: vi.fn() }
  },
}))

import ProductPriceHistoryView from "@/components/inventory/product-price-history-view"

const fixture: ProductPriceHistoryResponse = {
  role: "SUPER_ADMIN",
  products: [{
    id: 7,
    productCode: "P-007",
    name: "Premium Paper",
    unit: "ream",
    status: "active",
    snapshotCount: 2,
    firstRecordedAt: "2026-08-01T08:00:00.000Z",
    lastRecordedAt: "2026-09-01T09:00:00.000Z",
  }],
  selectedProduct: {
    id: 7,
    productCode: "P-007",
    name: "Premium Paper",
    unit: "ream",
    status: "active",
    snapshotCount: 2,
    firstRecordedAt: "2026-08-01T08:00:00.000Z",
    lastRecordedAt: "2026-09-01T09:00:00.000Z",
  },
  options: {
    organizations: [{ id: 2, name: "Acme Foods" }],
    groups: [{ id: 3, name: "North", organizationId: 2, organizationName: "Acme Foods" }],
    branches: [{ id: 4, name: "Main Branch", organizationId: 2, organizationName: "Acme Foods", groupId: 3 }],
  },
  selection: { organizationId: null, groupId: null, branchId: null },
  range: { key: "1y", label: "Last 12 months", startAt: "2025-09-25T00:00:00.000Z" },
  points: [
    {
      orderItemId: 71,
      orderId: 81,
      orderReference: "ORD-081",
      orderedAt: "2026-08-01T08:00:00.000Z",
      chargedPriceCents: 20_000,
      quantity: 2,
      organizationId: 2,
      organizationName: "Acme Foods",
      groupId: 3,
      groupName: "North",
      branchId: 4,
      branchName: "Main Branch",
    },
    {
      orderItemId: 72,
      orderId: 82,
      orderReference: "ORD-082",
      orderedAt: "2026-09-01T09:00:00.000Z",
      chargedPriceCents: 23_000,
      quantity: 1,
      organizationId: 2,
      organizationName: "Acme Foods",
      groupId: 3,
      groupName: "North",
      branchId: 4,
      branchName: "Main Branch",
    },
  ],
  truncated: false,
  source: {
    description: "Exact unit price charged on each order line when the order was placed.",
    excludes: ["Cancelled orders", "Rejected orders"],
  },
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  swr.use.mockClear()
  swr.response = fixture
})

describe("Product Price History", () => {
  it("shows exact charged prices, all four filters, and no KPI or aggregate metrics", () => {
    swr.response = fixture
    render(<ProductPriceHistoryView role="SUPER_ADMIN" />)

    expect(screen.getByRole("heading", { name: "Product Price History" })).toBeTruthy()
    expect(screen.getByText(/exact unit price stored on an order line/i)).toBeTruthy()
    for (const label of ["Organization", "Group", "Branch", "Date range"]) {
      expect(screen.getByRole("combobox", { name: label })).toBeTruthy()
    }

    const table = within(screen.getByRole("table"))
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Ordered", "Charged price", "Organization", "Group", "Branch", "Quantity", "Order",
    ])
    expect(table.getAllByText(/(?:PKR|Rs)\s*200/).length).toBeGreaterThan(0)
    expect(table.getAllByText(/(?:PKR|Rs)\s*230/).length).toBeGreaterThan(0)
    expect(table.getByText("ORD-082")).toBeTruthy()

    expect(screen.queryByText(/weighted average/i)).toBeNull()
    expect(screen.queryByText(/lowest recorded/i)).toBeNull()
    expect(screen.queryByText(/highest recorded/i)).toBeNull()
    expect(screen.queryByText(/current global price/i)).toBeNull()
    expect(screen.queryByText(/period movement/i)).toBeNull()
  })

  it("keeps Head Office locked to the organization returned by the scoped API", () => {
    swr.response = {
      ...fixture,
      role: "HEAD_OFFICE",
      selection: { organizationId: 2, groupId: null, branchId: null },
    }
    render(<ProductPriceHistoryView role="HEAD_OFFICE" />)

    expect(screen.getByRole("combobox", { name: "Organization" })).toHaveProperty("disabled", true)
    expect(swr.use).toHaveBeenLastCalledWith("/api/v1/admin/product-price-history?range=1y")
  })

  it("requests the selected product without changing the exact-price filters", () => {
    swr.response = {
      ...fixture,
      products: [
        ...fixture.products,
        { ...fixture.products[0], id: 8, productCode: "P-008", name: "Standard Paper" },
      ],
    }
    render(<ProductPriceHistoryView role="SUPER_ADMIN" />)
    fireEvent.click(screen.getByRole("button", { name: /Standard Paper/i }))

    expect(swr.use).toHaveBeenLastCalledWith("/api/v1/admin/product-price-history?range=1y&productId=8")
  })

  it("explains a blank result without displaying a zero price", () => {
    swr.response = { ...fixture, products: [], selectedProduct: null, points: [] }
    render(<ProductPriceHistoryView role="SUPER_ADMIN" />)

    expect(screen.getByText("No recorded order prices in this range")).toBeTruthy()
    expect(screen.getByText(/broaden the organization, group, or branch filters/i)).toBeTruthy()
    expect(screen.queryByText(/(?:PKR|Rs)\s*0(?:\.00)?$/)).toBeNull()
  })
})
