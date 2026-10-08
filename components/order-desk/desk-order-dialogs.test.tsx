import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DeskOrder } from "./desk-order-dialogs"

const swr = vi.hoisted(() => ({ catalogue: undefined as unknown, keys: [] as string[] }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) swr.keys.push(key)
    return { data: swr.catalogue, error: undefined, isLoading: swr.catalogue === undefined }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { CancelDeskOrderDialog, EditDeskOrderDialog, RefundDeskOrderDialog, ResubmitDeskOrderDialog } from "./desk-order-dialogs"

const order = (overrides: Partial<DeskOrder> = {}): DeskOrder => ({
  id: 41,
  tid: "TID-41",
  status: "PENDING",
  fulfillmentStatus: "NOT_STARTED",
  returnedForCorrectionAt: null,
  correctionRequestNote: null,
  rejectionReason: null,
  canEdit: true,
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
  poNumber: "PO-1",
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
  items: [
    { id: 9, organizationInventoryId: 3, productName: "Rice", quantity: 2, unit: "kg", priceCents: 75_000 },
    { id: 10, organizationInventoryId: 4, productName: "Boxes", quantity: 1, unit: "piece", priceCents: 1_000 },
  ],
  ...overrides,
})

const catalogueItem = (organizationInventoryId: number, name: string, priceCents = 1_000) => ({
  organizationInventoryId,
  name,
  productCode: `P-${organizationInventoryId}`,
  unit: "piece",
  allowDecimalQuantity: false,
  quantityStep: 1,
  stockQuantity: 100,
  priceCents,
})

const fetchMock = vi.fn()

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

function sentBody(call = 0) {
  return JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body))
}

beforeEach(() => {
  swr.catalogue = undefined
  swr.keys = []
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("editing a desk order", () => {
  it("loads the order's own branch catalogue and prefills what the order holds", () => {
    swr.catalogue = { items: [catalogueItem(3, "Rice", 75_000), catalogueItem(4, "Boxes")] }
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(swr.keys).toContain("/api/v1/order-desk/catalogue?organizationId=1&branchId=2")
    expect((screen.getByLabelText("Quantity for Rice") as HTMLInputElement).value).toBe("2")
    expect((screen.getByLabelText("Quantity for Boxes") as HTMLInputElement).value).toBe("1")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("does not call a line unavailable while the catalogue is still loading", () => {
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(screen.queryByText(/No longer available/)).toBeNull()
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("names a line the branch no longer offers and lets it be removed, so the edit can be saved", async () => {
    // Rice (3) was hidden at the branch after the order was placed.
    swr.catalogue = { items: [catalogueItem(4, "Boxes")] }
    const onSaved = vi.fn()
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)

    const notice = screen.getByRole("alert")
    expect(within(notice).getByText("Rice")).toBeTruthy()

    // Saving before removing it says why, and sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("A product in this order is no longer available for this branch")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Remove Rice" }))
    expect(screen.queryByText(/No longer available/)).toBeNull()

    respond(200, { message: "Order updated", totalCents: 1_000 })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/order-desk/orders/41")
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT")
    expect(sentBody()).toEqual({ items: [{ organizationInventoryId: 4, quantity: 1 }], notes: "", poNumber: "PO-1" })
  })

  it("clears the PO number when it is emptied, and shows the server's refusal", async () => {
    swr.catalogue = { items: [catalogueItem(3, "Rice", 75_000), catalogueItem(4, "Boxes")] }
    const onSaved = vi.fn()
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText("Customer PO number"), { target: { value: "  " } })

    respond(400, { error: "Insufficient stock for Rice. Available: 1, Requested: 2" })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Insufficient stock for Rice. Available: 1, Requested: 2")).toBeTruthy()
    expect(sentBody().poNumber).toBeNull()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("refuses to save an order with no lines left", async () => {
    swr.catalogue = { items: [catalogueItem(3, "Rice"), catalogueItem(4, "Boxes")] }
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Quantity for Rice"), { target: { value: "" } })
    fireEvent.change(screen.getByLabelText("Quantity for Boxes"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Add at least one product")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("cancelling a desk order", () => {
  it("requires a reason before sending anything", () => {
    render(<CancelDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }))
    expect(screen.getByText("A reason is required")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the trimmed reason once, even when clicked twice", async () => {
    let finish: (value: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
    const onSaved = vi.fn()
    render(<CancelDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "  Customer withdrew it  " } })
    const button = screen.getByRole("button", { name: "Cancel order" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/order-desk/orders/41/cancel")
    expect(sentBody()).toEqual({ reason: "Customer withdrew it" })

    finish(new Response(JSON.stringify({ message: "Order cancelled" }), { status: 200 }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it("keeps the dialog open with the server's reason when it is refused", async () => {
    respond(409, { error: "A delivered order cannot be cancelled; fulfil it and request a refund instead" })
    const onSaved = vi.fn()
    render(<CancelDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Too late" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }))
    expect(await screen.findByText(/A delivered order cannot be cancelled/)).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("says the connection failed rather than showing a raw error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    render(<CancelDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "x" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel order" }))
    expect(await screen.findByText(/Check the connection and try again/)).toBeTruthy()
  })
})

describe("resubmitting a returned desk order", () => {
  const returned = order({
    returnedForCorrectionAt: "2026-10-06T09:00:00.000Z",
    correctionRequestNote: "Customer wanted 3 kg",
    canResubmit: true,
  })

  it("shows what the executive asked for, and sends no note when none is typed", async () => {
    respond(200, { message: "Order resubmitted for approval" })
    const onSaved = vi.fn()
    render(<ResubmitDeskOrderDialog order={returned} onClose={vi.fn()} onSaved={onSaved} />)
    expect(screen.getByText("Customer wanted 3 kg")).toBeTruthy()
    fireEvent.change(screen.getByLabelText(/Note for the executive/), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: "Resubmit" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/order-desk/orders/41/resubmit")
    expect(sentBody()).toEqual({})
  })

  it("sends the trimmed note once, even when clicked twice", async () => {
    let finish: (value: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
    const onSaved = vi.fn()
    render(<ResubmitDeskOrderDialog order={returned} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText(/Note for the executive/), { target: { value: "  Quantities fixed  " } })
    const button = screen.getByRole("button", { name: "Resubmit" })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentBody()).toEqual({ note: "Quantities fixed" })
    finish(new Response(JSON.stringify({ message: "ok" }), { status: 200 }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it("keeps the dialog open with the server's reason when it is refused", async () => {
    respond(409, { error: "This order is not awaiting correction" })
    const onSaved = vi.fn()
    render(<ResubmitDeskOrderDialog order={returned} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: "Resubmit" }))
    expect(await screen.findByText("This order is not awaiting correction")).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe("requesting a refund on a desk order", () => {
  const fulfilled = order({ status: "FULFILLED", fulfillmentStatus: "DELIVERED", canEdit: false, canCancel: false, canRequestRefund: true })

  it("refuses more than was ordered, or no line at all, before sending", () => {
    render(<RefundDeskOrderDialog order={fulfilled} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Damaged" } })
    fireEvent.click(screen.getByRole("button", { name: "Request refund" }))
    expect(screen.getByText("Choose at least one item to refund")).toBeTruthy()

    fireEvent.change(screen.getByLabelText("Refund quantity for Rice"), { target: { value: "3" } })
    fireEvent.click(screen.getByRole("button", { name: "Request refund" }))
    expect(screen.getByText("You cannot refund more Rice than was ordered")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("asks the shared refund route for the chosen lines, for Super Admin to approve", async () => {
    respond(200, { message: "Refund request submitted" })
    const onSaved = vi.fn()
    render(<RefundDeskOrderDialog order={fulfilled} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText("Refund quantity for Rice"), { target: { value: "1" } })
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: " One bag torn " } })
    fireEvent.click(screen.getByRole("button", { name: "Request refund" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/orders/41/refunds")
    expect(sentBody()).toEqual({ items: [{ id: 9, quantity: 1 }], reason: "One bag torn" })
  })
})
