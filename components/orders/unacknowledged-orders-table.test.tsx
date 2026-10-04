import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UnacknowledgedOrdersTable, type UnacknowledgedOrderRow } from "./unacknowledged-orders-table"

afterEach(() => cleanup())

const row = (id: number, overrides: Partial<UnacknowledgedOrderRow> = {}): UnacknowledgedOrderRow => ({
  id,
  tid: `TID-${id}`,
  status: "APPROVED",
  fulfillmentStatus: "DELIVERED",
  deliveredAt: "2026-09-20T10:00:00.000Z",
  createdAt: "2026-09-18T10:00:00.000Z",
  approvalToken: `TOKEN${id}ABCDEF`,
  itemNames: "Paper, Toner",
  ...overrides,
})

function renderTable(props: Partial<Parameters<typeof UnacknowledgedOrdersTable>[0]> = {}) {
  const handlers = { onSendToken: vi.fn(), onCopyToken: vi.fn(), onViewDetails: vi.fn() }
  render(
    <UnacknowledgedOrdersTable
      orders={[row(1)]}
      loading={false}
      sendingOrderId={null}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

describe("UnacknowledgedOrdersTable", () => {
  it("shows the full fulfilment token and an action column", () => {
    renderTable()
    const table = screen.getByRole("table", { name: "Delivered orders awaiting acknowledgement" })
    const headers = within(table).getAllByRole("columnheader").map((cell) => cell.textContent)
    expect(headers).toEqual(["Order", "Items", "Delivered", "Fulfillment Token", "Action"])
    expect(within(table).getByText("TOKEN1ABCDEF")).toBeTruthy()
    expect(within(table).getByText("TID-1")).toBeTruthy()
    expect(within(table).getByText("Paper, Toner")).toBeTruthy()
  })

  it("fulfils an order by emailing its token", () => {
    const { onSendToken } = renderTable()
    fireEvent.click(screen.getByRole("button", { name: "Fulfil order TID-1 by emailing its token" }))
    expect(onSendToken).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
  })

  it("copies the token", () => {
    const { onCopyToken } = renderTable()
    fireEvent.click(screen.getByRole("button", { name: "Copy fulfillment token for order TID-1" }))
    expect(onCopyToken).toHaveBeenCalledWith("TOKEN1ABCDEF")
  })

  it("opens the order", () => {
    const { onViewDetails } = renderTable()
    fireEvent.click(screen.getByRole("button", { name: "View order TID-1" }))
    expect(onViewDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }))
  })

  it("offers no send for an order whose token the viewer was not given", () => {
    renderTable({ orders: [row(2, { approvalToken: null, placedByGroupPortal: true })] })
    expect(screen.queryByRole("button", { name: /Fulfil order TID-2/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /Copy fulfillment token/ })).toBeNull()
    expect(screen.getByText("The fulfillment token is not available for this order.")).toBeTruthy()
    expect(screen.getByText("Group Order")).toBeTruthy()
  })

  it("disables every send while one token is on its way", () => {
    renderTable({ orders: [row(1), row(2)], sendingOrderId: 1 })
    const first = screen.getByRole("button", { name: "Fulfil order TID-1 by emailing its token" }) as HTMLButtonElement
    const second = screen.getByRole("button", { name: "Fulfil order TID-2 by emailing its token" }) as HTMLButtonElement
    expect(first.disabled).toBe(true)
    expect(first.textContent).toContain("Sending...")
    expect(second.disabled).toBe(true)
  })

  it("shows a token that has already been emailed as sent, and offers no second send", () => {
    const { onSendToken } = renderTable({
      orders: [row(3, { tokenHandoffAt: "2026-09-21T10:00:00.000Z" }), row(4)],
    })
    expect(screen.queryByRole("button", { name: "Fulfil order TID-3 by emailing its token" })).toBeNull()
    const sent = screen.getByRole("button", { name: "Token for order TID-3 has already been emailed" }) as HTMLButtonElement
    expect(sent.disabled).toBe(true)
    expect(sent.textContent).toContain("Token sent")
    fireEvent.click(sent)
    expect(onSendToken).not.toHaveBeenCalled()
    // The token itself is still there to copy, and the other row is unaffected.
    expect(screen.getByText("TOKEN3ABCDEF")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Fulfil order TID-4 by emailing its token" })).toBeTruthy()
  })

  it("says so when nothing is awaiting acknowledgement", () => {
    renderTable({ orders: [] })
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.getByText("No delivered orders awaiting acknowledgement")).toBeTruthy()
  })

  it("shows a loading state instead of an empty one", () => {
    renderTable({ orders: [], loading: true })
    expect(screen.getByLabelText("Loading unacknowledged orders")).toBeTruthy()
    expect(screen.queryByText("No delivered orders awaiting acknowledgement")).toBeNull()
  })
})
