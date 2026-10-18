import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { PaymentStatusBadge } from "@/components/orders/payment-status-badge"

describe("PaymentStatusBadge", () => {
  afterEach(cleanup)

  it.each([
    ["FULFILLED", "PAID", "Paid"],
    ["FULFILLED", "UNPAID", "Unpaid"],
    ["APPROVED", "PAID", "Paid"],
    ["PENDING", null, "Unpaid"],
    ["REFUNDED", "PAID", "Paid"],
  ])("labels a %s order whose payment is %s as %s", (status, paymentStatus, label) => {
    render(<PaymentStatusBadge order={{ status, paymentStatus }} />)
    expect(screen.getByText(label)).toBeTruthy()
  })

  it.each(["REJECTED", "cancelled"])("shows the fallback, not a payment, for a %s order", (status) => {
    render(<PaymentStatusBadge order={{ status, paymentStatus: "UNPAID" }} fallback="—" />)
    expect(screen.getByText("—")).toBeTruthy()
    expect(screen.queryByText("Unpaid")).toBeNull()
  })
})
