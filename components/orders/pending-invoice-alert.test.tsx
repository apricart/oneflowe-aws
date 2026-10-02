import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PendingInvoiceAlert } from "./pending-invoice-alert"

afterEach(cleanup)

describe("PendingInvoiceAlert", () => {
  it("names the pending invoice and requires an explicit choice", () => {
    const onCancel = vi.fn()
    const onContinue = vi.fn()

    render(
      <PendingInvoiceAlert
        invoice={{ orderId: 3, invoiceNumber: "INV-000003", orderReference: "TID-3" }}
        continuing={false}
        onCancel={onCancel}
        onContinue={onContinue}
      />,
    )

    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(screen.getByText("Pending invoice")).toBeTruthy()
    expect(screen.getByText("INV-000003")).toBeTruthy()
    expect(screen.getByText(/arrange payment for the pending invoice/i)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Continue with order" }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it("lets the user cancel without continuing", () => {
    const onCancel = vi.fn()
    const onContinue = vi.fn()

    render(
      <PendingInvoiceAlert
        invoice={{ orderId: 3, invoiceNumber: "INV-000003", orderReference: "TID-3" }}
        continuing={false}
        onCancel={onCancel}
        onContinue={onContinue}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onContinue).not.toHaveBeenCalled()
  })
})
