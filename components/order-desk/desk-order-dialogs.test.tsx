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
    // Rice: carried by the branch, charged its catalogue price.
    { id: 9, organizationInventoryId: 3, globalProductId: 30, productName: "Rice", productCode: "P-30", allowDecimalQuantity: false, quantityStep: 1, quantity: 2, unit: "kg", priceCents: 75_000, priceEnteredManually: false, cataloguePriceCents: null },
    // Tape: an Apricart product the branch does not carry, priced by the desk.
    { id: 10, organizationInventoryId: null, globalProductId: 40, productName: "Tape", productCode: "P-40", allowDecimalQuantity: false, quantityStep: 1, quantity: 1, unit: "roll", priceCents: 1_250, priceEnteredManually: true, cataloguePriceCents: null },
  ],
  ...overrides,
})

/** One row of the desk's product picker, as the catalogue route returns it. */
const catalogueItem = (globalProductId: number, name: string, assigned: { organizationInventoryId: number; cataloguePriceCents: number } | null = null) => ({
  globalProductId,
  organizationInventoryId: assigned?.organizationInventoryId ?? null,
  name,
  productCode: `P-${globalProductId}`,
  unit: "piece",
  allowDecimalQuantity: false,
  quantityStep: 1,
  stockQuantity: 100,
  assignedToBranch: assigned !== null,
  cataloguePriceCents: assigned?.cataloguePriceCents ?? null,
})

const cataloguePage = (items: ReturnType<typeof catalogueItem>[]) => ({
  items,
  pagination: { page: 1, limit: 25, total: items.length, totalPages: 1 },
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
  const priceBox = (name: string, unit: string) => screen.getByLabelText(`Price per ${unit} of ${name}, in rupees including tax`) as HTMLInputElement

  it("opens on the order's own lines, each with the price it is charged now, without loading the catalogue", () => {
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    expect(priceBox("Rice", "kg").value).toBe("750.00")
    expect(priceBox("Tape", "roll").value).toBe("12.50")
    expect((screen.getByLabelText("Quantity of Rice") as HTMLInputElement).value).toBe("2")
    expect(screen.getByRole("button", { name: "Selected (2)" }).getAttribute("aria-pressed")).toBe("true")
    // A product the branch does not carry says so; one it carries shows its price there.
    const tape = screen.getByText("Tape").closest("li")!
    expect(within(tape).getByText("Not in branch catalogue")).toBeTruthy()
    expect(within(screen.getByText("Rice").closest("li")!).getByText("Branch price Rs 750.00", { exact: false })).toBeTruthy()
    // The whole catalogue is only fetched when the desk asks for it.
    expect(swr.keys).toEqual([])
  })

  it("saves unchanged lines by global product, each at the price it is charged", async () => {
    const onSaved = vi.fn()
    respond(200, { message: "Order updated", totalCents: 151_250 })
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/order-desk/orders/41")
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PUT")
    expect(sentBody()).toEqual({
      items: [
        { globalProductId: 30, quantity: 2, unitPriceCents: 75_000 },
        { globalProductId: 40, quantity: 1, unitPriceCents: 1_250 },
      ],
      notes: "",
      poNumber: "PO-1",
    })
  })

  it("refuses a cleared price, and says which product needs one, without sending anything", async () => {
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(priceBox("Rice", "kg"), { target: { value: "" } })
    expect(priceBox("Rice", "kg").getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText("Price required")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Enter the price for Rice, including tax")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refuses a zero price", async () => {
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(priceBox("Tape", "roll"), { target: { value: "0" } })
    expect(screen.getByText("The price for Tape must be more than zero")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findAllByText("The price for Tape must be more than zero")).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("adds any Apricart product from the whole catalogue, with an empty price box that must be filled", async () => {
    swr.catalogue = cataloguePage([catalogueItem(50, "Gloves"), catalogueItem(30, "Rice", { organizationInventoryId: 3, cataloguePriceCents: 75_000 })])
    const onSaved = vi.fn()
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={onSaved} />)
    fireEvent.click(screen.getByRole("button", { name: "All products" }))
    expect(swr.keys).toContain("/api/v1/order-desk/catalogue?organizationId=1&branchId=2")

    // The catalogue's row for a product already on the order shows the order's own line.
    expect(priceBox("Rice", "kg").value).toBe("750.00")
    const gloves = priceBox("Gloves", "piece")
    expect(gloves.value).toBe("")
    expect(gloves.placeholder).toBe("Price incl. tax")

    fireEvent.click(screen.getByRole("button", { name: "Increase Quantity of Gloves" }))
    expect(screen.getByText("Price required")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(await screen.findByText("Enter the price for Gloves, including tax")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(gloves, { target: { value: "45.5" } })
    expect(screen.getByRole("button", { name: "Selected (3)" })).toBeTruthy()
    respond(200, { message: "Order updated", totalCents: 155_800 })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sentBody().items).toContainEqual({ globalProductId: 50, quantity: 1, unitPriceCents: 4_550 })
  })

  it("clears the PO number when it is emptied, and shows the server's refusal", async () => {
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
    render(<EditDeskOrderDialog order={order()} onClose={vi.fn()} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Quantity of Rice"), { target: { value: "0" } })
    fireEvent.blur(screen.getByLabelText("Quantity of Rice"))
    fireEvent.click(screen.getByRole("button", { name: "Decrease Quantity of Tape" }))
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
