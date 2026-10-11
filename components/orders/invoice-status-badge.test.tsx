import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { InvoiceStatusBadge } from "@/components/orders/invoice-status-badge"
import { INVOICE_STATUSES, INVOICE_STATUS_LABELS } from "@/lib/invoice-status"

describe("InvoiceStatusBadge", () => {
  afterEach(cleanup)

  it.each(INVOICE_STATUSES)("labels %s", (status) => {
    render(<InvoiceStatusBadge status={status} />)
    expect(screen.getByText(INVOICE_STATUS_LABELS[status])).toBeTruthy()
  })

  it("shows a dash rather than guessing at an unknown value", () => {
    render(<InvoiceStatusBadge status="PAID" />)
    expect(screen.getByText("—")).toBeTruthy()
    expect(screen.queryByText("PAID")).toBeNull()
  })
})
