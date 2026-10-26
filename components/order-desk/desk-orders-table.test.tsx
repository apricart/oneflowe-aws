import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DeskOrder } from "./desk-order-dialogs"

const swr = vi.hoisted(() => ({ keys: [] as string[], page: null as unknown }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) swr.keys.push(key)
    if (key === "/api/v1/order-desk/targets") return { data: { items: [] }, error: undefined, isLoading: false, mutate: vi.fn() }
    return { data: swr.page, error: undefined, isLoading: false, mutate: vi.fn() }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { DeskOrdersTable } from "./desk-orders-table"

const order = (id: number, overrides: Partial<DeskOrder> = {}): DeskOrder => ({
  id,
  tid: `TID-${id}`,
  status: "APPROVED",
  fulfillmentStatus: "NOT_STARTED",
  returnedForCorrectionAt: null,
  correctionRequestNote: null,
  rejectionReason: null,
  canEdit: false,
  canCancel: true,
  canResubmit: false,
  canFulfil: false,
  canRequestRefund: false,
  organizationId: 1,
  organizationName: "Meezan",
  branchId: 2,
  branchName: "Clifton",
  totalCents: 150_000,
  refundedCents: 0,
  pendingRefundCents: 0,
  poNumber: null,
  notes: null,
  intakeChannel: "WHATSAPP",
  intakeReference: "Ali, 10:14",
  hasAttachment: false,
  enteredBy: "Sana",
  createdAt: "2026-10-05T10:00:00.000Z",
  deliveredAt: null,
  fulfilledAt: null,
  cancelledAt: null,
  cancellationReason: null,
  items: [{ id: 9, organizationInventoryId: 3, globalProductId: 30, productName: "Rice", productCode: "P-30", allowDecimalQuantity: false, quantityStep: 1, quantity: 2, unit: "kg", priceCents: 75_000 }],
  ...overrides,
})

function page(items: DeskOrder[], readyToFulfil = 0) {
  return {
    items,
    counts: {
      awaiting_approval: 5,
      awaiting_delivery: 4,
      ready_to_fulfil: readyToFulfil,
      fulfilled: 7,
      rejected: 2,
      cancelled: 1,
      all: 19 + readyToFulfil,
    },
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
  }
}

beforeEach(() => {
  swr.keys = []
})
afterEach(() => cleanup())

describe("the desk's orders", () => {
  it("shows every tab with its count, starting on Awaiting approval", () => {
    swr.page = page([order(1)], 2)
    render(<DeskOrdersTable />)
    const tabs = within(screen.getByRole("tablist", { name: "Order status" })).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Awaiting approval5",
      "Awaiting delivery4",
      "Ready to fulfil2",
      "Fulfilled7",
      "Rejected2",
      "Cancelled1",
      "All orders21",
    ])
    expect(tabs[0].getAttribute("aria-selected")).toBe("true")
    expect(swr.keys.some((key) => key.includes("status=awaiting_approval"))).toBe(true)
  })

  it("offers edit and cancel while an order awaits an executive's approval, and says who it is waiting on", () => {
    swr.page = page([order(7, { status: "PENDING", canEdit: true, canCancel: true })])
    render(<DeskOrdersTable />)
    const card = screen.getByRole("article")
    expect(within(card).getAllByText("Awaiting approval").length).toBeGreaterThan(0)
    expect(within(card).getByText("Waiting for an Apricart Executive to approve")).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Edit" })).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Cancel order" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: /Resubmit/ })).toBeNull()
    expect(screen.queryByLabelText(/Delivery progress/)).toBeNull()
  })

  it("shows what the executive asked for on a returned order, and offers Resubmit", () => {
    swr.page = page([order(8, {
      status: "PENDING",
      returnedForCorrectionAt: "2026-10-06T09:00:00.000Z",
      correctionRequestNote: "Customer wanted 3 kg, not 2",
      canEdit: true,
      canCancel: true,
      canResubmit: true,
    })])
    render(<DeskOrdersTable />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("Returned for correction")).toBeTruthy()
    expect(within(card).getByText(/Customer wanted 3 kg, not 2/)).toBeTruthy()
    expect(within(card).queryByText("Waiting for an Apricart Executive to approve")).toBeNull()
    expect(within(card).getByRole("button", { name: "Resubmit for approval" })).toBeTruthy()
    expect(within(card).getByRole("button", { name: "Edit" })).toBeTruthy()
  })

  it("shows why an executive rejected an order, and no actions", () => {
    swr.page = page([order(9, { status: "REJECTED", canCancel: false, rejectionReason: "Duplicate of TID-7" })])
    render(<DeskOrdersTable initialTab="rejected" />)
    const card = screen.getByRole("article")
    expect(within(card).getAllByText("Rejected").length).toBeGreaterThan(0)
    expect(within(card).getByText(/Duplicate of TID-7/)).toBeTruthy()
    expect(within(card).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Show 1 item"])
    expect(swr.keys.some((key) => key.includes("status=rejected"))).toBe(true)
  })

  it("points the desk at orders ready to fulfil, and goes there in one click", () => {
    swr.page = page([order(1)], 3)
    render(<DeskOrdersTable />)
    expect(screen.getByText("3 orders have been delivered and are ready for you to fulfil.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Review/ }))
    expect(swr.keys.some((key) => key.includes("status=ready_to_fulfil"))).toBe(true)
  })

  it("offers only cancel once approved and awaiting delivery, and says who it is waiting on", () => {
    swr.page = page([order(1)])
    render(<DeskOrdersTable initialTab="awaiting_delivery" />)
    const card = screen.getByRole("article")
    expect(within(card).getAllByText("Awaiting delivery").length).toBeGreaterThan(0)
    expect(within(card).getByText("Waiting for Super Admin to record delivery")).toBeTruthy()
    // An approved order's lines are fixed: an edit would change what was approved.
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull()
    expect(within(card).getByRole("button", { name: "Cancel order" })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: /Fulfil/ })).toBeNull()
  })

  it("offers only Fulfil once delivered", () => {
    swr.page = page([order(2, { fulfillmentStatus: "DELIVERED", canEdit: false, canCancel: false, canFulfil: true })], 1)
    render(<DeskOrdersTable />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("Ready to fulfil")).toBeTruthy()
    expect(within(card).getByRole("button", { name: /Fulfil/ })).toBeTruthy()
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull()
    expect(within(card).queryByRole("button", { name: "Cancel order" })).toBeNull()
    expect(screen.getByLabelText("Delivery progress: Delivered")).toBeTruthy()
  })

  it("offers a refund request on a fulfilled order and shows a pending one", () => {
    swr.page = page([order(3, {
      status: "FULFILLED",
      fulfillmentStatus: "DELIVERED",
      canEdit: false,
      canCancel: false,
      canRequestRefund: true,
      pendingRefundCents: 75_000,
    })])
    render(<DeskOrdersTable />)
    const card = screen.getByRole("article")
    expect(within(card).getByRole("button", { name: "Request refund" })).toBeTruthy()
    expect(within(card).getByText(/Refund awaiting approval/)).toBeTruthy()
    expect(screen.getByLabelText("Delivery progress: Fulfilled")).toBeTruthy()
  })

  it("keeps a fully refunded order on the Fulfilled stage, says so, and offers nothing more", () => {
    swr.page = page([order(6, {
      status: "REFUNDED",
      fulfillmentStatus: "DELIVERED",
      canEdit: false,
      canCancel: false,
      refundedCents: 150_000,
    })])
    render(<DeskOrdersTable initialTab="fulfilled" />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("Fully refunded")).toBeTruthy()
    expect(within(card).getAllByText("Fulfilled").length).toBeGreaterThan(0)
    expect(within(card).getByText(/^Refunded/)).toBeTruthy()
    expect(within(card).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Show 1 item"])
    expect(swr.keys.some((key) => key.includes("status=fulfilled"))).toBe(true)
  })

  it("shows why a cancelled order was cancelled, and no actions", () => {
    swr.page = page([order(4, {
      status: "CANCELLED",
      canEdit: false,
      canCancel: false,
      cancelledAt: "2026-10-05T12:00:00.000Z",
      cancellationReason: "Customer withdrew it",
    })])
    render(<DeskOrdersTable />)
    const card = screen.getByRole("article")
    expect(within(card).getByText(/Customer withdrew it/)).toBeTruthy()
    expect(within(card).queryAllByRole("button").map((button) => button.textContent)).toEqual(["Show 1 item"])
  })

  it("links the screenshot through the desk's own route, and lists the items on request", () => {
    swr.page = page([order(5, { hasAttachment: true })])
    render(<DeskOrdersTable />)
    expect(screen.getByRole("link", { name: /Screenshot/ }).getAttribute("href")).toBe("/api/v1/order-desk/orders/5/attachment")
    fireEvent.click(screen.getByRole("button", { name: "Show 1 item" }))
    expect(screen.getByText("Rice")).toBeTruthy()
  })

  it("says plainly when a tab is empty", () => {
    swr.page = page([])
    render(<DeskOrdersTable />)
    expect(screen.getByText("No orders are waiting for approval.")).toBeTruthy()
  })
})
