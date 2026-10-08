import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())

import OrdersManagementPage from "./page"

/**
 * The Orders page with its real directory, filters and pager. The list is
 * paginated on the server, so every filter and the page number must be in the
 * request — filtering the page on screen would present one page as the whole
 * list.
 */
function order(id: number, status = "PENDING") {
  return {
    id,
    tid: `TID-${String(id).padStart(4, "0")}`,
    status,
    fulfillmentStatus: "NOT_STARTED",
    paymentStatus: "UNPAID",
    totalCents: 10_000,
    subtotalCents: 10_000,
    taxCents: 0,
    refundAmountCents: 0,
    createdAt: "2026-10-01T10:00:00.000Z",
    organizationId: 5,
    branchId: 11,
    branchName: "North",
    organizationName: "Acme",
    createdByName: "Ahmed",
    orderItems: [],
  }
}

function routes(total = 2) {
  installFetch([
    ["/api/v1/orders", (url: URL) => {
      const page = Number(url.searchParams.get("page") || 1)
      const items = page === 1 ? [order(1), order(2, "APPROVED")] : [order(3, "FULFILLED")]
      return {
        items,
        pagination: { page, limit: 25, total, totalPages: Math.ceil(total / 2) },
        summary: { all: total, pending: 1, approved: 1, fulfilled: 0, refunded: 0, rejected: 0, deliveredUnacknowledged: 0 },
        capabilities: { canApproveOrders: true, canRejectOrders: true },
      }
    }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North" }] }],
    ["/api/v1/groups", { items: [] }],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
  ])
}

const lastOrdersCall = () => callsTo("/api/v1/orders").at(-1)!.url

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Orders page", () => {
  it("lists the first page for the organization", async () => {
    routes()
    renderWithApp(<OrdersManagementPage />)
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))
    expect(screen.getAllByText("TID-0002").length).toBeGreaterThan(0)
    expect(lastOrdersCall()).toContain("organizationId=5")
    expect(lastOrdersCall()).toContain("page=1")
  })

  it("asks the server for a status, a delivery bucket and a search rather than filtering locally", async () => {
    routes()
    renderWithApp(<OrdersManagementPage />)
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByText("Pending Approval").find((node) => node.closest("button"))!)
    await waitFor(() => expect(lastOrdersCall()).toContain("status=pending"))

    fireEvent.click(screen.getByTitle("Active orders whose goods have been delivered but which are not yet fulfilled"))
    await waitFor(() => expect(lastOrdersCall()).toMatch(/status=approved.*delivery=|delivery=.*status=approved/))

    fireEvent.change(screen.getByPlaceholderText("Search by transaction ID, order ID, or cost center..."), { target: { value: "TID-0002" } })
    await waitFor(() => expect(lastOrdersCall()).toContain("q=TID-0002"), { timeout: 3000 })
  })

  it("pages through the list on the server", async () => {
    routes(3)
    renderWithApp(<OrdersManagementPage />)
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByLabelText("Go to next page"))
    await waitFor(() => expect(lastOrdersCall()).toContain("page=2"))
    await waitFor(() => expect(screen.getAllByText("TID-0003").length).toBeGreaterThan(0))

    fireEvent.click(screen.getByLabelText("Go to previous page"))
    await waitFor(() => expect(lastOrdersCall()).toContain("page=1"))
  })

  it("reloads on Refresh", async () => {
    routes()
    renderWithApp(<OrdersManagementPage />)
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))
    const before = callsTo("/api/v1/orders").length
    fireEvent.click(screen.getByText("Refresh"))
    await waitFor(() => expect(callsTo("/api/v1/orders").length).toBeGreaterThan(before))
  })
})
