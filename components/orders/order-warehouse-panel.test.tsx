import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { installDomPolyfills } from "@/tests/support/ui-mocks"

const swr = vi.hoisted(() => ({ data: undefined as unknown, mutate: vi.fn() }))
vi.mock("swr", () => ({
  default: (key: string) => {
    if (key !== "/api/v1/orders/7/fulfillment-warehouse") throw new Error(`unexpected key ${key}`)
    return { data: swr.data, error: undefined, isLoading: false, mutate: swr.mutate }
  },
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { OrderWarehousePanel, type OrderWarehousePanelData } from "./order-warehouse-panel"

const base: OrderWarehousePanelData = {
  order: { id: 7, tid: "TID-7", status: "APPROVED", fulfillmentStatus: "NOT_STARTED", branchId: 3, branchName: "Clifton" },
  currentWarehouse: null,
  branchDefaultWarehouse: { id: 1, code: "KHI", name: "Karachi", city: "Karachi" },
  workedBy: [{ id: "u1", name: "Kamran Store" }],
  branchServingAccountCount: 1,
  refusal: null,
  targets: [
    { id: 1, code: "KHI", name: "Karachi", city: "Karachi", operatorCount: 1 },
    { id: 2, code: "LHE", name: "Lahore", city: "Lahore", operatorCount: 2 },
    { id: 3, code: "EMP", name: "Empty", city: null, operatorCount: 0 },
  ],
  history: [],
}

const fetchMock = vi.fn()

beforeAll(() => installDomPolyfills())

beforeEach(() => {
  fetchMock.mockReset()
  swr.mutate.mockReset()
  swr.data = base
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("the order's fulfilment warehouse", () => {
  it("shows an untransferred order as served by its branch's accounts, with the default for information", () => {
    render(<OrderWarehousePanel orderId={7} />)
    expect(screen.getByText("Served by the branch's warehouse accounts")).toBeTruthy()
    expect(screen.getByText("Not transferred")).toBeTruthy()
    expect(screen.getByText(/Branch default warehouse: KHI — Karachi/)).toBeTruthy()
    expect(screen.getByText("Worked now by: Kamran Store")).toBeTruthy()
  })

  it("offers no transfer once the order has left the warehouse, and says why", () => {
    swr.data = { ...base, refusal: "out-for-delivery" }
    render(<OrderWarehousePanel orderId={7} />)
    expect((screen.getByRole("button", { name: /Transfer to another warehouse/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/can no longer move to another one/)).toBeTruthy()
  })

  it("sends the chosen warehouse, the one it saw, and the reason — then refreshes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ item: {} }), { status: 200 }))
    render(<OrderWarehousePanel orderId={7} />)
    fireEvent.click(screen.getByRole("button", { name: /Transfer to another warehouse/ }))

    const dialog = screen.getByRole("dialog")
    const submit = within(dialog).getByRole("button", { name: /Transfer order/ }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "Move to" }), { key: "ArrowDown" })
    expect((screen.getByRole("option", { name: /EMP — Empty — no active operator/ })).getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(screen.getByRole("option", { name: /LHE — Lahore/ }))
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "Out of stock in Karachi" } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(swr.mutate).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/orders/7/fulfillment-warehouse")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      targetWarehouseId: 2,
      expectedWarehouseId: null,
      reason: "Out of stock in Karachi",
    })
  })

  it("lists the transfer history of a transferred order", () => {
    swr.data = {
      ...base,
      currentWarehouse: { id: 2, code: "LHE", name: "Lahore", city: "Lahore", status: "ACTIVE" },
      history: [{
        id: 1,
        from: null,
        to: { id: 2, code: "LHE", name: "Lahore", city: "Lahore" },
        reason: "Out of stock in Karachi",
        transferredBy: "Asma Admin",
        createdAt: "2026-10-23T08:00:00.000Z",
      }],
    }
    render(<OrderWarehousePanel orderId={7} />)
    expect(screen.getByText("Transferred")).toBeTruthy()
    expect(screen.getByText("Branch's warehouse accounts → LHE — Lahore (Lahore)")).toBeTruthy()
    expect(screen.getByText("Out of stock in Karachi")).toBeTruthy()
  })
})
