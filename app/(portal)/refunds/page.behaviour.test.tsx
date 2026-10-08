import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import RefundsPage from "./page"

/**
 * The Super Admin refund desk: find an order, choose lines and quantities,
 * confirm — and the pending-request queue that opens an order with the
 * requested quantities already chosen. The amount sent is never priced by the
 * page (the server prices it); what the page computes is the preview, which
 * must match what the lines and quantities chosen are worth.
 *
 *   Paper  4 x 500.00, 1 already refunded  -> 3 refundable
 *   Toner  1 x 3,000.00, fully refunded    -> not selectable
 *   Ink    2 x 250.00, 2 requested          -> pre-selected when reviewing
 */
const ORDER = {
  id: 41,
  tid: "TID-0041",
  organizationId: 5,
  organizationName: "Acme",
  branchId: 11,
  branchName: "North",
  status: "FULFILLED",
  subtotalCents: 550_000,
  taxCents: 0,
  totalCents: 550_000,
  createdAt: "2026-10-02T10:00:00.000Z",
  statusAtRefund: null,
  refundedAt: null,
  refundAmountCents: 350_000,
  createdByUserName: "Ahmed",
  items: [
    { id: 1, productName: "Paper", productCode: "PP", quantity: 4, priceCents: 50_000, unit: "Ream", refundedQuantity: 1, remainingQuantity: 3 },
    { id: 2, productName: "Toner", productCode: "TN", quantity: 1, priceCents: 300_000, unit: "Piece", refundedQuantity: 1, remainingQuantity: 0 },
    { id: 3, productName: "Ink", productCode: "IK", quantity: 2, priceCents: 25_000, unit: "Piece", refundedQuantity: 0, requestedQuantity: 2, remainingQuantity: 2 },
  ],
}
const PENDING = {
  id: 9,
  refundNumber: "Refund-000009",
  amountCents: 50_000,
  reason: "Damaged ink",
  status: "PENDING",
  createdAt: "2026-10-03T10:00:00.000Z",
  orderId: 41,
  tid: "TID-0041",
  totalCents: 550_000,
  organizationName: "Acme",
  branchName: "North",
  requestedByName: "Ahmed",
}

function routes(post: unknown = { success: true }) {
  installFetch([
    [/^\/api\/v1\/admin\/refunds\?status=pending/, { refunds: [PENDING] }],
    [/^\/api\/v1\/admin\/refunds\?q=TID-0041/, { order: ORDER }],
    [/^\/api\/v1\/admin\/refunds\?q=TID-0042/, {
      order: { ...ORDER, id: 42, tid: "TID-0042", items: ORDER.items.map((item) => ({ ...item, requestedQuantity: 0 })) },
    }],
    [/^\/api\/v1\/admin\/refunds\?q=/, { status: 404, body: { error: "Order not found" } }],
    ["/api/v1/admin/refunds", post],
    ["/api/v1/admin/refunds/9", { success: true }],
  ])
}

async function search(tid: string) {
  fireEvent.change(screen.getByPlaceholderText("Enter Transaction ID (e.g., ORD-ABC123)"), { target: { value: tid } })
  fireEvent.click(screen.getByText("Search"))
}

function itemRow(name: string) {
  return screen.getAllByText(name).map((node) => node.closest("tr")).find(Boolean) as HTMLElement
}

beforeEach(() => {
  resetUi({ id: "sa-1", role: "SUPER_ADMIN" })
  toast.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Refund desk", () => {
  it("lists pending requests", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    expect(await screen.findByText("Refund-000009")).toBeTruthy()
  })

  it("shows the server's message for an unknown order", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    await search("NOPE")
    expect(await screen.findByText("Order not found")).toBeTruthy()
  })

  it("offers no refund until a line is chosen, then previews exactly what the chosen lines are worth", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    await search("TID-0042")
    await screen.findByText("Paper")
    expect(screen.queryByText("Process Refund")).toBeNull()

    fireEvent.click(within(itemRow("Paper")).getByRole("checkbox"))
    // Selecting a line takes everything still refundable on it: 3 x 500.00.
    expect(await screen.findByText("Process Refund")).toBeTruthy()
    expect(screen.getAllByText("PKR 1500.00").length).toBeGreaterThan(0)
  })

  it("selects only refundable lines with Select All, labels the toggle accordingly, and posts what was chosen", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    await search("TID-0041")
    await screen.findByText("Paper")

    fireEvent.click(screen.getByText("Select All"))
    // Toner is fully refunded: "all" means Paper and Ink, and the toggle now offers to undo that.
    expect(screen.getByText("Deselect All")).toBeTruthy()
    const toner = within(itemRow("Toner")).getByRole("checkbox")
    expect(toner.getAttribute("data-state")).not.toBe("checked")

    fireEvent.click(screen.getByText("Process Refund"))
    fireEvent.change(await screen.findByPlaceholderText("Enter reason for refund..."), { target: { value: "Wrong item" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm Refund" }))

    await waitFor(() => expect(callsTo("/api/v1/admin/refunds", "POST")).toHaveLength(1))
    expect(callsTo("/api/v1/admin/refunds", "POST")[0].body).toEqual({
      orderId: 41,
      items: [{ itemId: 1, quantity: 3 }, { itemId: 3, quantity: 2 }],
      reason: "Wrong item",
    })
    // 3 x 500.00 + 2 x 250.00 = 2,000.00
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "✅ Refund Processed Successfully",
      description: "Refunded PKR 2000.00 for 2 item(s)",
    })))
  })

  it("deselects everything with the same toggle", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    await search("TID-0041")
    await screen.findByText("Paper")
    fireEvent.click(screen.getByText("Select All"))
    fireEvent.click(screen.getByText("Deselect All"))
    expect(screen.getByText("Select All")).toBeTruthy()
  })

  it("opens a pending request with its requested quantities chosen and links the request on submit", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    fireEvent.click(await screen.findByText("Review"))
    await screen.findByText("Paper")

    const ink = within(itemRow("Ink")).getByRole("checkbox")
    expect(ink.getAttribute("data-state")).toBe("checked")

    fireEvent.click(screen.getByText("Process Refund"))
    const reason = await screen.findByPlaceholderText("Enter reason for refund...") as HTMLTextAreaElement
    expect(reason.value).toBe("Damaged ink")
    fireEvent.click(screen.getByRole("button", { name: "Confirm Refund" }))

    await waitFor(() => expect(callsTo("/api/v1/admin/refunds", "POST")).toHaveLength(1))
    expect(callsTo("/api/v1/admin/refunds", "POST")[0].body).toMatchObject({
      orderId: 41,
      items: [{ itemId: 3, quantity: 2 }],
      refundRequestId: 9,
    })
    expect(callsTo(/^\/api\/v1\/admin\/refunds\?q=TID-0041&refundRequestId=9/).length).toBe(1)
  })

  it("reports the server's refusal of a refund", async () => {
    routes({ status: 400, body: { error: "Order in REJECTED state is not eligible for a refund." } })
    renderWithApp(<RefundsPage />)
    await search("TID-0041")
    await screen.findByText("Paper")
    fireEvent.click(screen.getByText("Select All"))
    fireEvent.click(screen.getByText("Process Refund"))
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Refund" }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Refund Failed",
      description: "Order in REJECTED state is not eligible for a refund.",
    })))
  })

  it("cancels a pending request", async () => {
    routes()
    renderWithApp(<RefundsPage />)
    await screen.findByText("Refund-000009")
    fireEvent.click(screen.getByText("Cancel"))
    fireEvent.click(await screen.findByText("Cancel Request"))
    await waitFor(() => expect(callsTo("/api/v1/admin/refunds/9", "PATCH")).toHaveLength(1))
    expect(callsTo("/api/v1/admin/refunds/9", "PATCH")[0].body).toEqual({ action: "cancel" })
  })

  it("searches straight away when opened with a TID in the address", async () => {
    ui.searchParams = new URLSearchParams("tid=TID-0041")
    routes()
    renderWithApp(<RefundsPage />)
    expect(await screen.findByText("Paper")).toBeTruthy()
  })
})
