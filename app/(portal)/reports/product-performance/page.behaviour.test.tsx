import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const files = vi.hoisted(() => ({ written: [] as string[] }))
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return { ...actual, writeFile: vi.fn((_book: unknown, name: string) => files.written.push(name)) }
})

import ProductPerformancePage from "./page"

/**
 * The Product Performance report with real tables, filters and charts. Two
 * products — the page must rank them by revenue, total them, filter them by
 * name, and show the order-line ledger on the Reports tab.
 */
const PERFORMANCE = {
  pricesHidden: false,
  data: [
    { productId: 1, productName: "Toner", productCode: "TN-1", qtyOrdered: 3, qtyFulfilled: 3, qtyRefunded: 0, qtyDelivered: 3, revenueGeneratedCents: 900_000 },
    { productId: 2, productName: "Paper", productCode: "PP-1", qtyOrdered: 30, qtyFulfilled: 28, qtyRefunded: 2, qtyDelivered: 28, revenueGeneratedCents: 1_550_000 },
  ],
  trend: [{ date: "2026-08", revenue: 24_500, qtyOrdered: 33, qtyFulfilled: 31, qtyRefunded: 2 }],
}
const LEDGER = {
  pricesHidden: false,
  data: [
    {
      tid: "TID-0001", orderCreatedAt: "2026-08-01T10:00:00.000Z", itemCode: "PP-1", itemDetails: "Paper",
      organizationName: "Acme", branchName: "North", userName: "Ahmed Khan", userEmail: "ahmed@example.test",
      employeeId: "E-77", userId: "u-1", quantity: 10, unit: "Ream", priceCents: 50_000, totalCents: 500_000,
    },
    {
      tid: "TID-0002", orderCreatedAt: "2026-08-03T10:00:00.000Z", itemCode: "TN-1", itemDetails: "Toner",
      organizationName: "Acme", branchName: "South", userName: "Sana Ali", userEmail: "sana@example.test",
      employeeId: "E-88", userId: "u-2", quantity: 1, unit: "Piece", priceCents: 300_000, totalCents: 300_000,
    },
  ],
  pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
}

function routes() {
  installFetch([
    ["/api/v1/analytics/products/performance", PERFORMANCE],
    ["/api/v1/analytics/orders/itemized", LEDGER],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
    ["/api/v1/groups", { items: [] }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North" }] }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
    ["/api/v1/analytics/products/list", { items: [] }],
  ])
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  files.written.length = 0
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Product Performance report", () => {
  it("ranks products by revenue and filters them by name", async () => {
    routes()
    renderWithApp(<ProductPerformancePage />)

    await waitFor(() => expect(screen.getAllByText("Paper").length).toBeGreaterThan(0))
    const productTable = screen.getAllByText("Paper").map((node) => node.closest("table")).find(Boolean) as HTMLElement
    const rows = Array.from(productTable.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "")
    expect(rows.findIndex((row) => row.includes("Paper"))).toBeLessThan(rows.findIndex((row) => row.includes("Toner")))

    fireEvent.change(screen.getByPlaceholderText("Search products, employee #, or name..."), { target: { value: "ton" } })
    await waitFor(() => {
      const visible = Array.from(productTable.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "")
      expect(visible.some((row) => row.includes("Paper"))).toBe(false)
    })

    fireEvent.change(screen.getByPlaceholderText("Search products, employee #, or name..."), { target: { value: "zzz" } })
    expect(await screen.findByText("No products found.")).toBeTruthy()
  })

  it("scopes every request to the caller's organization", async () => {
    routes()
    renderWithApp(<ProductPerformancePage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/products/performance").length).toBeGreaterThan(0))
    expect(callsTo("/api/v1/analytics/products/performance").some((call) => /organizationIds?=5/.test(call.url))).toBe(true)
  })

  it("shows the order-line ledger on the reports tab and searches it by person, code or TID", async () => {
    ui.searchParams = new URLSearchParams("tab=reports")
    routes()
    renderWithApp(<ProductPerformancePage />)

    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))
    expect(screen.getAllByText("TID-0002").length).toBeGreaterThan(0)

    const search = screen.getByPlaceholderText("Search by employee #, code, product, user...")
    fireEvent.change(search, { target: { value: "e-88" } })
    await waitFor(() => expect(screen.queryAllByText("TID-0001")).toHaveLength(0))
    expect(screen.getAllByText("TID-0002").length).toBeGreaterThan(0)

    fireEvent.change(search, { target: { value: "tid-0001" } })
    await waitFor(() => expect(screen.queryAllByText("TID-0002")).toHaveLength(0))
  })

  it("renders with no data at all", async () => {
    installFetch([
      ["/api/v1/analytics/products/performance", { data: [], trend: [], pricesHidden: false }],
      ["/api/v1/analytics/orders/itemized", { data: [], pricesHidden: false }],
    ])
    renderWithApp(<ProductPerformancePage />)
    expect(await screen.findByText("No products found.")).toBeTruthy()
  })
})
