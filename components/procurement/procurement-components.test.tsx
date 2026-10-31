import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { installDomPolyfills } from "@/tests/support/ui-mocks"

const swr = vi.hoisted(() => ({ data: {} as Record<string, unknown>, mutate: vi.fn() }))
vi.mock("swr", () => ({
  default: (key: string | null) => ({ data: key ? swr.data[key] : undefined, error: undefined, isLoading: false, mutate: swr.mutate }),
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { CustomerReturnList } from "./customer-returns"
import { sendJson } from "./procurement-shared"
import { ReceiveGoodsDialog } from "./receive-goods-dialog"

const fetchMock = vi.fn()

beforeAll(() => installDomPolyfills())

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  swr.data = {}
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("receiving goods", () => {
  const lines = [
    { id: 1, productName: "Rice", unit: "kg", quantity: 10, receivedQuantity: 6, allowDecimalQuantity: false },
    { id: 2, productName: "Oil", unit: "ltr", quantity: 5, receivedQuantity: 6, allowDecimalQuantity: false },
  ]

  it("shows what each line may still take under the allowance, and sends only the lines entered", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ reference: "GRN-000001" }) })
    const onDone = vi.fn()
    render(<ReceiveGoodsDialog open reference="PO-000001" lines={lines} toleranceBps={2000} endpoint="/receive" onClose={vi.fn()} onDone={onDone} />)

    expect(screen.getByText(/Up to 20% more than ordered/)).toBeTruthy()
    // Rice: 12 allowed, 6 received → 6 more. Oil: 6 allowed, 6 received → none, so its box is disabled.
    expect((screen.getByLabelText("Quantity of Oil arrived") as HTMLInputElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText("Quantity of Rice arrived"), { target: { value: "4" } })
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.lines).toEqual([{ purchaseOrderLineId: 1, quantity: 4 }])
  })

  it("shows the server's refusal instead of closing", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Rice: at most 6 more can be received" }) })
    const onDone = vi.fn()
    render(<ReceiveGoodsDialog open reference="PO-000001" lines={lines} toleranceBps={2000} endpoint="/receive" onClose={vi.fn()} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText("Quantity of Rice arrived"), { target: { value: "9" } })
    fireEvent.click(screen.getByRole("button", { name: "Record receipt" }))
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByRole("alert").textContent).toContain("at most 6 more")
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe("customer returns", () => {
  const row = {
    id: 3,
    reference: "CR-000003",
    warehouse: { id: 1, code: "KHI", name: "Karachi" },
    orderTid: null,
    status: "PENDING",
    reason: "Wrong item",
    recordedBy: "Kamran",
    decidedBy: null,
    decisionReason: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    lines: [{ globalProductId: 9, productName: "Rice", unit: "kg", quantity: 2, condition: "RESALEABLE" }],
  }

  it("offers decisions only where the caller may decide", () => {
    swr.data = { "/list": { items: [row] } }
    const { unmount } = render(<CustomerReturnList listEndpoint="/list" />)
    expect(screen.getByText("CR-000003")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    unmount()

    render(<CustomerReturnList listEndpoint="/list" decideEndpoint={(id) => `/decide/${id}`} />)
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy()
  })
})

describe("sending a document", () => {
  it("refuses a body the production firewall would block, before sending it", async () => {
    await expect(sendJson("/x", "POST", { text: "x".repeat(9000) })).rejects.toThrow(/too large/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
