import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UnacknowledgedDeliveriesDialog } from "./unacknowledged-deliveries-dialog"

afterEach(() => cleanup())

const MESSAGE = "Your branch has 2 delivered orders awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order."

describe("UnacknowledgedDeliveriesDialog", () => {
  it("is closed when there is nothing to say", () => {
    render(<UnacknowledgedDeliveriesDialog notice={null} onClose={vi.fn()} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("tells the user how many deliveries await acknowledgement and what to do", () => {
    render(<UnacknowledgedDeliveriesDialog notice={{ message: MESSAGE, branches: [] }} onClose={vi.fn()} />)
    const dialog = screen.getByRole("alertdialog", { name: "Delivered orders awaiting acknowledgement" })
    expect(within(dialog).getByText(MESSAGE)).toBeTruthy()
    expect(within(dialog).queryByRole("list")).toBeNull()
  })

  it("offers no way to continue with the order", () => {
    render(<UnacknowledgedDeliveriesDialog notice={{ message: "m", branches: [] }} onClose={vi.fn()} />)
    const buttons = within(screen.getByRole("alertdialog")).getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual(["OK"])
  })

  it("lists each blocked location with its count", () => {
    render(
      <UnacknowledgedDeliveriesDialog
        notice={{
          message: "No order was placed for the locations below.",
          branches: [
            { branchId: 2, branchName: "South", unacknowledgedCount: 2 },
            { branchId: 4, branchName: "West", unacknowledgedCount: 1 },
          ],
        }}
        onClose={vi.fn()}
      />,
    )
    const list = screen.getByRole("list", { name: "Locations with delivered orders awaiting acknowledgement" })
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent)
    expect(rows).toEqual([
      "South2 delivered orders awaiting acknowledgement",
      "West1 delivered order awaiting acknowledgement",
    ])
  })

  it("takes the user to the orders awaiting acknowledgement when the page lists them", () => {
    const onClose = vi.fn()
    const onReview = vi.fn()
    render(<UnacknowledgedDeliveriesDialog notice={{ message: "m", branches: [] }} onClose={onClose} onReview={onReview} />)
    const buttons = within(screen.getByRole("alertdialog")).getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual(["OK", "View unacknowledged orders"])

    fireEvent.click(screen.getByRole("button", { name: "View unacknowledged orders" }))
    expect(onReview).toHaveBeenCalled()
  })

  it("closes on OK", () => {
    const onClose = vi.fn()
    render(<UnacknowledgedDeliveriesDialog notice={{ message: "m", branches: [] }} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "OK" }))
    expect(onClose).toHaveBeenCalled()
  })
})
