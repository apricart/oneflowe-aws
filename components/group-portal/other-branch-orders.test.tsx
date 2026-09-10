import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}))

const listResponse = {
  items: [
    {
      id: 1919,
      tid: "mtv4btk0531073d73267a18a",
      branchId: 7,
      branchName: "Demo North Branch",
      status: "PENDING",
      fulfillmentStatus: "NOT_STARTED",
      // 950 rupees, as the order was placed.
      totalCents: 95_000,
      itemCount: 1,
      createdAt: "2026-09-10T06:00:19.000Z",
      approvedAt: null,
      rejectionReason: null,
    },
  ],
  pricesHidden: false,
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1, hasMore: false },
}

// Only the orders list is served. Every other request the drawer makes — the
// order detail, the refund history — stays pending, so the panel paints from
// the row and nothing here depends on a second fixture.
vi.mock("swr", () => ({
  default: (key: unknown) => {
    const url = typeof key === "string" ? key : ""
    if (url.startsWith("/api/v1/orders?")) {
      return { data: listResponse, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() }
    }
    return { data: undefined, error: undefined, isLoading: true, isValidating: false, mutate: vi.fn() }
  },
}))

vi.mock("@/components/group-portal/branch-order-edit-sheet", () => ({
  BranchOrderEditSheet: ({ order }: { order: { tid: string } | null }) => (
    order ? <div data-testid="edit-sheet">Editing {order.tid}</div> : null
  ),
}))

import { OtherBranchOrders } from "@/components/group-portal/other-branch-orders"

// `Intl` separates the currency symbol with a non-breaking space.
const plainText = (node: { textContent: string | null }) =>
  (node.textContent ?? "").replace(/\s+/g, " ")

describe("OtherBranchOrders", () => {
  afterEach(cleanup)

  // Both the row and the drawer read `totalCents`, and `formatPKR` takes
  // rupees. Passing the cents straight through overstated every branch order by
  // a factor of one hundred — a 950-rupee order read as 95,000.
  it("shows a 950-rupee order as 950, not as its cent value", () => {
    render(<OtherBranchOrders />)

    const text = plainText(document.body)
    expect(text).toContain("Rs 950")
    expect(text).not.toContain("95,000")
  })

  it("opens the shared order detail panel, which reports the same total", () => {
    render(<OtherBranchOrders />)

    fireEvent.click(screen.getByRole("button", { name: /mtv4btk0531073d73267a18a/ }))

    const text = plainText(screen.getByRole("dialog"))
    expect(text).toContain("Rs 950")
    expect(text).not.toContain("95,000")
  })

  // The branch owns its orders, so a group requester may amend a pending one
  // raised by that branch's own staff. Deciding it is still somebody else's job.
  it("offers to edit a pending branch order, but never to decide it", () => {
    render(<OtherBranchOrders />)
    fireEvent.click(screen.getByRole("button", { name: /mtv4btk0531073d73267a18a/ }))

    expect(screen.getByRole("button", { name: /edit order/i })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /approve|reject/i })).toBeNull()
  })

  it("opens the editor for the order that was chosen", () => {
    render(<OtherBranchOrders />)
    fireEvent.click(screen.getByRole("button", { name: /mtv4btk0531073d73267a18a/ }))
    fireEvent.click(screen.getByRole("button", { name: /edit order/i }))

    expect(screen.getByTestId("edit-sheet").textContent)
      .toContain("mtv4btk0531073d73267a18a")
  })
})
