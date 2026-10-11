import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ sheet: undefined as unknown, mutate: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === null) return { data: undefined, error: undefined, isLoading: false, mutate: swr.mutate }
    if (key.endsWith("/timeline")) {
      return { data: { events: [{ key: "approved", label: "Approved", at: "2026-10-01T05:00:00.000Z", by: "Head Office" }] }, error: undefined, isLoading: false, mutate: swr.mutate }
    }
    return { data: swr.sheet, error: undefined, isLoading: false, mutate: swr.mutate }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { WarehouseOrderSheet, type WarehouseOrderSheetData } from "./warehouse-order-sheet"

function sheet(overrides: Partial<WarehouseOrderSheetData["order"]> = {}, challans: WarehouseOrderSheetData["challans"] = []): WarehouseOrderSheetData {
  return {
    order: {
      id: 7,
      tid: "T-777",
      organizationName: "Meezan",
      branchName: "North",
      status: "APPROVED",
      notes: "Call before arriving",
      poNumber: "PO-1",
      approvedAt: "2026-10-01T05:00:00.000Z",
      deliveredAt: null,
      stage: "NOT_STARTED",
      stageLabel: "Not Started",
      nextStage: "IN_PROCESS",
      health: "ON_TRACK",
      healthLabel: "On Track",
      promisedAt: "2026-10-04T05:00:00.000Z",
      ...overrides,
    },
    destination: {
      label: null,
      address: "Plot 4, Main Road",
      city: "Lahore",
      province: "Punjab",
      contactPerson: null,
      contactPhone: null,
      isBranchAddress: true,
    },
    invoice: {
      invoiceNumber: "INV-0042",
      invoiceDate: "01/10/2026",
      subtotalCents: 70_000,
      taxCents: 1_000,
      discountCents: 0,
      deliveryChargesCents: 0,
      totalCents: 71_000,
      refundAmountCents: 0,
      paymentStatus: "UNPAID",
      paidAt: null,
    },
    lines: [{ id: 1, productCode: "RICE-5", productName: "Basmati rice", unit: "kg", quantity: 2, priceCents: 35_500, taxCents: 500, amountCents: 71_000 }],
    challans,
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the warehouse picking sheet", () => {
  it("shows the picking lines, the destination, the notes and the invoice figures", () => {
    swr.sheet = sheet()
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.getByText("RICE-5")).toBeTruthy()
    expect(screen.getByText("Basmati rice")).toBeTruthy()
    expect(screen.getByText(/Plot 4, Main Road, Lahore, Punjab/)).toBeTruthy()
    expect(screen.getByText(/Call before arriving/)).toBeTruthy()
    expect(screen.getByText("INV-0042")).toBeTruthy()
    // On the badge and on the invoice's payment line.
    expect(screen.getAllByText("UNPAID")).toHaveLength(2)
    expect(screen.getByText("Approved")).toBeTruthy()
  })

  it("moves the order one stage forward, once, and refreshes", async () => {
    swr.sheet = sheet()
    const onChanged = vi.fn()
    let finish: (value: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve }))
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={onChanged} />)
    const start = screen.getByRole("button", { name: "Start processing" })
    fireEvent.click(start)
    fireEvent.click(start)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/warehouse/orders/7/progress")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ fulfillmentStatus: "IN_PROCESS" })

    finish(new Response(JSON.stringify({ message: "ok" }), { status: 200 }))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it("delivers without a challan when none is chosen", async () => {
    swr.sheet = sheet({ stage: "OUT_FOR_DELIVERY", stageLabel: "Out for Delivery", nextStage: "DELIVERED" })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "ok" }), { status: 200 }))
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered" }))

    const dialog = screen.getByRole("dialog", { name: "Mark order delivered" })
    // With no file chosen, the one action delivers without a challan.
    expect(within(dialog).queryByRole("button", { name: "Upload and mark delivered" })).toBeNull()
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark delivered without challan" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/warehouse/orders/7/progress")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ fulfillmentStatus: "DELIVERED" })
  })

  it("switches the action to uploading once a file is chosen, and back when it is removed", () => {
    swr.sheet = sheet({ stage: "OUT_FOR_DELIVERY", stageLabel: "Out for Delivery", nextStage: "DELIVERED" })
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered" }))
    const dialog = screen.getByRole("dialog", { name: "Mark order delivered" })
    const input = dialog.querySelector("input[type=file]") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["x"], "dc-77.pdf", { type: "application/pdf" })] } })

    expect(within(dialog).getByText("dc-77.pdf")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "Upload and mark delivered" })).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: "Mark delivered without challan" })).toBeNull()

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove the chosen file" }))
    expect(within(dialog).getByRole("button", { name: "Mark delivered without challan" })).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("downloads the invoice through the warehouse's own route", async () => {
    swr.sheet = sheet()
    const createObjectURL = vi.fn(() => "blob:invoice")
    const revokeObjectURL = vi.fn()
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    // A string body, not a Blob: Node 20's fetch Response cannot stream jsdom's Blob.
    fetchMock.mockResolvedValueOnce(new Response("%PDF-1.7", {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="invoice-INV-0042.pdf"' },
    }))
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Download invoice" }))

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/warehouse/orders/7/invoice")
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:invoice")
    click.mockRestore()
  })

  it("says plainly that the order was not delivered when the challan upload fails", async () => {
    swr.sheet = sheet({ stage: "OUT_FOR_DELIVERY", stageLabel: "Out for Delivery", nextStage: "DELIVERED" })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "File storage is not configured" }), { status: 503 }))
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Mark delivered" }))
    const dialog = screen.getByRole("dialog", { name: "Mark order delivered" })
    const input = dialog.querySelector("input[type=file]") as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(["%PDF-1.7"], "dc.pdf", { type: "application/pdf" })] } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and mark delivered" }))

    expect(await within(dialog).findByText(/File storage is not configured\. The order has NOT been marked delivered/)).toBeTruthy()
    // Only the upload was attempted; no delivery was sent.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/upload/image")
  })

  it("offers to add a challan to a delivered order that has none", () => {
    swr.sheet = sheet({ stage: "DELIVERED", stageLabel: "Delivered", nextStage: null, deliveredAt: "2026-10-02T05:00:00.000Z" })
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.getByRole("button", { name: "Add delivery challan" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Mark delivered" })).toBeNull()
  })

  it("links an attached challan through the warehouse's own route", () => {
    swr.sheet = sheet(
      { stage: "DELIVERED", stageLabel: "Delivered", nextStage: null },
      [{ id: 3, fileName: "dc.pdf", contentType: "application/pdf", uploadedAt: "2026-10-02T05:00:00.000Z", uploadedByRole: "WAREHOUSE" }],
    )
    render(<WarehouseOrderSheet orderId={7} onClose={() => {}} onChanged={() => {}} />)
    expect(screen.getByRole("link", { name: /dc\.pdf/ }).getAttribute("href")).toBe("/api/v1/warehouse/orders/7/delivery-challan/3/file")
    expect(screen.queryByRole("button", { name: "Add delivery challan" })).toBeNull()
  })
})
