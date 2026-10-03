import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { UnpaidInvoicesDialog } from "./unpaid-invoices-dialog"

afterEach(() => cleanup())

describe("UnpaidInvoicesDialog", () => {
  it("is closed when there is nothing to say", () => {
    render(<UnpaidInvoicesDialog notice={null} onClose={vi.fn()} />)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("tells the user how many invoices are unpaid and to pay their dues", () => {
    render(
      <UnpaidInvoicesDialog
        notice={{ message: "You have 2 unpaid invoices. Please pay your dues before placing a new order.", branches: [] }}
        onClose={vi.fn()}
      />,
    )
    const dialog = screen.getByRole("alertdialog", { name: "Unpaid invoices" })
    expect(within(dialog).getByText("You have 2 unpaid invoices. Please pay your dues before placing a new order.")).toBeTruthy()
    expect(within(dialog).queryByRole("list")).toBeNull()
  })

  it("offers no way to continue with the order", () => {
    render(<UnpaidInvoicesDialog notice={{ message: "m", branches: [] }} onClose={vi.fn()} />)
    const buttons = within(screen.getByRole("alertdialog")).getAllByRole("button")
    expect(buttons.map((button) => button.textContent)).toEqual(["OK"])
  })

  it("lists each blocked location with its count", () => {
    render(
      <UnpaidInvoicesDialog
        notice={{
          message: "No order was placed for the locations below.",
          branches: [
            { branchId: 2, branchName: "South", unpaidInvoiceCount: 2 },
            { branchId: 4, branchName: "West", unpaidInvoiceCount: 1 },
          ],
        }}
        onClose={vi.fn()}
      />,
    )
    const list = screen.getByRole("list", { name: "Locations with unpaid invoices" })
    const rows = within(list).getAllByRole("listitem").map((row) => row.textContent)
    expect(rows).toEqual(["South2 unpaid invoices", "West1 unpaid invoice"])
  })

  it("closes on OK", () => {
    const onClose = vi.fn()
    render(<UnpaidInvoicesDialog notice={{ message: "m", branches: [] }} onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: "OK" }))
    expect(onClose).toHaveBeenCalled()
  })
})
