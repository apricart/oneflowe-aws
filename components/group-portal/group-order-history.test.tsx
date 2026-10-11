import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}))

const historyResponse = {
  items: [
    {
      id: 41,
      reference: "GRP-DEMO-0041",
      createdAt: "2026-10-05T13:35:00.000Z",
      notes: null,
      groupId: 3,
      groupName: "Demo Group A",
      requestedBranchCount: 2,
      createdOrderCount: 2,
      failures: [],
      // 290 + 1,250 rupees.
      totalCents: 154_000,
      statusCounts: { PENDING: 1, APPROVED: 1, CANCELLED: 1 },
      orders: [
        {
          id: 1968,
          tid: "muval5ru5059728d29c9c67b",
          branchId: 7,
          branchName: "Demo North Branch",
          status: "PENDING",
          statusAtRefund: null,
          fulfillmentStatus: "NOT_STARTED",
          totalCents: 29_000,
          itemCount: 1,
          createdAt: "2026-10-05T13:35:00.000Z",
          approvedAt: null,
          rejectionReason: null,
          approvalToken: null,
        },
        {
          id: 1969,
          tid: "approved-group-branch-order",
          branchId: 8,
          branchName: "Demo South Branch",
          status: "APPROVED",
          statusAtRefund: null,
          fulfillmentStatus: "DELIVERED",
          totalCents: 125_000,
          itemCount: 2,
          createdAt: "2026-10-05T13:35:00.000Z",
          approvedAt: "2026-10-05T14:00:00.000Z",
          rejectionReason: null,
          approvalToken: "GROUPTOKEN5678",
        },
        {
          id: 1970,
          tid: "cancelled-group-branch-order",
          branchId: 9,
          branchName: "Demo East Branch",
          status: "CANCELLED",
          statusAtRefund: null,
          fulfillmentStatus: "NOT_STARTED",
          totalCents: 30_000,
          itemCount: 1,
          createdAt: "2026-10-05T13:35:00.000Z",
          approvedAt: null,
          rejectionReason: null,
          cancelledAt: "2026-10-06T09:00:00.000Z",
          cancellationReason: "Ordered by mistake",
          approvalToken: null,
        },
      ],
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
}

// Only the history list is served. Every other request the drawer makes — the
// order detail, the refund history — stays pending, so the panel paints from
// the row and nothing here depends on a second fixture.
vi.mock("swr", () => ({
  default: (key: unknown) => {
    const url = typeof key === "string" ? key : ""
    if (url.startsWith("/api/v1/group-portal/orders?")) {
      return { data: historyResponse, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
    }
    return { data: undefined, error: undefined, isLoading: true, isValidating: false, mutate: vi.fn() }
  },
}))

vi.mock("@/components/group-portal/branch-order-edit-sheet", () => ({
  BranchOrderEditSheet: ({ order }: { order: { tid: string } | null }) => (
    order ? <div data-testid="edit-sheet">Editing {order.tid}</div> : null
  ),
}))

vi.mock("@/components/receipts/receipt-icon-button", () => ({
  ReceiptIconButton: () => null,
}))

import { GroupOrderHistory } from "@/components/group-portal/group-order-history"

// `Intl` separates the currency symbol with a non-breaking space.
const plainText = (node: { textContent: string | null }) =>
  (node.textContent ?? "").replace(/\s+/g, " ")

function expandSubmission() {
  fireEvent.click(screen.getByRole("button", { name: /GRP-DEMO-0041/ }))
}

describe("GroupOrderHistory", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "1 pending order cancelled" }), { status: 200 }))

  beforeEach(() => {
    fetchMock.mockClear()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("opens a branch order in the same side panel Other orders uses", () => {
    render(<GroupOrderHistory />)
    expandSubmission()

    fireEvent.click(screen.getByRole("button", { name: "Open order muval5ru5059728d29c9c67b" }))

    const dialog = screen.getByRole("dialog")
    const text = plainText(dialog)
    expect(text).toContain("muval5ru5059728d29c9c67b")
    expect(text).toContain("Rs 290")
    expect(text).not.toContain("29,000")
  })

  it("opens the panel when any part of the row is clicked, not only the order ID", () => {
    render(<GroupOrderHistory />)
    expandSubmission()

    fireEvent.click(screen.getByText("Demo North Branch"))

    expect(plainText(screen.getByRole("dialog"))).toContain("muval5ru5059728d29c9c67b")
  })

  it("offers to edit a pending order from the panel, but never to decide it", () => {
    render(<GroupOrderHistory />)
    expandSubmission()
    fireEvent.click(screen.getByRole("button", { name: "Open order muval5ru5059728d29c9c67b" }))

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("button", { name: /edit order/i })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /^(approve|reject)$/i })).toBeNull()

    fireEvent.click(within(dialog).getByRole("button", { name: /edit order/i }))
    expect(screen.getByTestId("edit-sheet").textContent).toContain("muval5ru5059728d29c9c67b")
  })

  it("shows an approved order's fulfilment token in the panel", () => {
    render(<GroupOrderHistory />)
    expandSubmission()
    fireEvent.click(screen.getByRole("button", { name: "Open order approved-group-branch-order" }))

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getAllByText("GROUPTOKEN5678").length).toBeGreaterThan(0)
  })

  it("offers to cancel a pending order from its panel, and cancels it with the reason given", async () => {
    render(<GroupOrderHistory />)
    expandSubmission()
    fireEvent.click(screen.getByRole("button", { name: "Open order muval5ru5059728d29c9c67b" }))
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /cancel order/i }))

    const dialog = screen.getByRole("dialog", { name: "Cancel order" })
    const confirm = within(dialog).getByRole("button", { name: "Cancel order" }) as HTMLButtonElement
    // No reason, no cancel.
    expect(confirm.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText("Reason for cancelling"), { target: { value: "  Ordered by mistake  " } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/v1/group-portal/branch-orders/1968/cancel")
    expect(init.method).toBe("POST")
    expect(JSON.parse(String(init.body))).toEqual({ reason: "Ordered by mistake" })
  })

  it("never offers to cancel an order once it has been approved", () => {
    render(<GroupOrderHistory />)
    expandSubmission()
    fireEvent.click(screen.getByRole("button", { name: "Open order approved-group-branch-order" }))

    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /cancel order/i })).toBeNull()
  })

  it("never offers to cancel an order that is already cancelled", () => {
    render(<GroupOrderHistory />)
    expandSubmission()
    fireEvent.click(screen.getByRole("button", { name: "Open order cancelled-group-branch-order" }))

    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /cancel order/i })).toBeNull()
  })

  it("cancels every pending order of a submission at once, counting only the pending ones", async () => {
    render(<GroupOrderHistory />)

    // One pending, one approved, one already cancelled.
    fireEvent.click(screen.getByRole("button", { name: "Cancel pending orders (1)" }))
    const dialog = screen.getByRole("dialog", { name: "Cancel pending orders" })
    expect(plainText(dialog)).toContain("Orders already approved are not affected")

    fireEvent.change(within(dialog).getByLabelText("Reason for cancelling"), { target: { value: "Site closed" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel pending orders" }))

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/api/v1/group-portal/orders/41/cancel")
    expect(JSON.parse(String(init.body))).toEqual({ reason: "Site closed" })
  })

  it("shows why a cancelled order was cancelled", () => {
    render(<GroupOrderHistory />)
    expandSubmission()

    expect(screen.getByText("Cancelled: Ordered by mistake")).toBeTruthy()
  })
})
