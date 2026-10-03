import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

import { OrderReportRowDetails, type OrderReportDetail } from "./order-report-row-details"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const detail = (overrides: Partial<OrderReportDetail> = {}): OrderReportDetail => ({
  id: 7,
  tid: "TID-7",
  createdAt: "2026-10-02T10:00:00.000Z",
  approvedAt: "2026-10-02T11:00:00.000Z",
  deliveredAt: null,
  fulfilledAt: null,
  subtotalCents: 50_000,
  taxCents: 0,
  totalCents: 50_000,
  refundAmountCents: 10_000,
  branchName: "North Branch",
  creatorName: "Order Person",
  creatorEmployeeId: "EMP-1",
  pricesHidden: false,
  orderItems: [
    { id: 1, productName: "Paper A4", productCode: "P-1", quantity: 2, quantityRefunded: 1, priceCents: 10_000, unit: "ream" },
    { id: 2, productName: "Toner", productCode: null, quantity: 1, quantityRefunded: 0, priceCents: 30_000, unit: null },
  ],
  ...overrides,
})

function stubFetch(response: { ok: boolean; status?: number; body: unknown }) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: async () => response.body,
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function renderDetails(onCollapse = vi.fn()) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <table>
        <tbody>
          <OrderReportRowDetails orderId={7} tid="TID-7" columnCount={12} onCollapse={onCollapse} />
        </tbody>
      </table>
    </SWRConfig>,
  )
  return onCollapse
}

describe("OrderReportRowDetails", () => {
  it("loads the order from the scoped order endpoint and lists every item", async () => {
    const fetchMock = stubFetch({ ok: true, body: { item: detail() } })
    renderDetails()

    const items = await screen.findByRole("table", { name: "Items in order TID-7" })
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/orders/7")
    const headers = within(items).getAllByRole("columnheader").map((cell) => cell.textContent)
    expect(headers).toEqual(["#", "Product", "Code", "Unit", "Qty", "Qty Refunded", "Unit Price", "Line Total"])

    const rows = within(items).getAllByRole("row")
    // header, two lines, footer
    expect(rows).toHaveLength(4)
    expect(within(rows[1]).getByText("Paper A4")).toBeTruthy()
    expect(within(rows[1]).getByText("ream")).toBeTruthy()
    expect(within(rows[2]).getByText("Toner")).toBeTruthy()
    expect(within(rows[3]).getByText("Total")).toBeTruthy()
    expect(within(rows[3]).getByText("3")).toBeTruthy()

    expect(screen.getByText("Order Person · #EMP-1")).toBeTruthy()
    expect(screen.getByText("North Branch")).toBeTruthy()
  })

  it("draws no price column or money field when the endpoint hid prices", async () => {
    stubFetch({
      ok: true,
      body: {
        item: detail({
          pricesHidden: true,
          subtotalCents: null,
          taxCents: null,
          totalCents: null,
          refundAmountCents: null,
          orderItems: [{ id: 1, productName: "Paper A4", quantity: 2, priceCents: null }],
        }),
      },
    })
    renderDetails()

    const items = await screen.findByRole("table", { name: "Items in order TID-7" })
    const headers = within(items).getAllByRole("columnheader").map((cell) => cell.textContent)
    expect(headers).not.toContain("Unit Price")
    expect(headers).not.toContain("Line Total")
    expect(screen.queryByText("Subtotal")).toBeNull()
    expect(screen.queryByText("Net Value")).toBeNull()
  })

  it("says so when the order has no lines", async () => {
    stubFetch({ ok: true, body: { item: detail({ orderItems: [] }) } })
    renderDetails()

    expect(await screen.findByText("No product lines are available for this order.")).toBeTruthy()
    expect(screen.queryByRole("table", { name: "Items in order TID-7" })).toBeNull()
  })

  it("shows the server's safe message and retries on request", async () => {
    const fetchMock = stubFetch({ ok: false, status: 403, body: { error: "Forbidden: You do not have access to this order" } })
    renderDetails()

    const alert = await screen.findByRole("alert")
    expect(within(alert).getByText("Forbidden: You do not have access to this order")).toBeTruthy()

    fireEvent.click(within(alert).getByRole("button", { name: "Try Again" }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it("collapses from its own button", async () => {
    stubFetch({ ok: true, body: { item: detail() } })
    const onCollapse = renderDetails()

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }))
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })
})
