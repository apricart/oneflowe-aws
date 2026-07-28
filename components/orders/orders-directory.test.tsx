import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-toast", () => ({
  toast: vi.fn(),
}))

vi.mock("@/components/receipts/receipt-icon-button", () => ({
  ReceiptIconButton: () => null,
}))

import { OrdersDirectory } from "@/components/orders/orders-directory"

describe("OrdersDirectory", () => {
  afterEach(() => {
    cleanup()
  })

  it("gives the order detail drawer an accessible name and description", async () => {
    render(
      <OrdersDirectory
        orders={[
          {
            id: 42,
            tid: "ORD-0042",
            status: "PENDING",
            branchId: 7,
            branchName: "Central Branch",
            createdAt: "2026-07-28T10:00:00.000Z",
            totalCents: 125000,
          },
        ]}
        userRole="BRANCH_ADMIN"
        isSuperAdmin={false}
        isBranchAdmin
        onUpdate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("ORD-0042"))

    const drawer = await screen.findByRole("dialog", {
      name: "Order details",
    })
    const descriptionId = drawer.getAttribute("aria-describedby")

    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toContain(
      "order ORD-0042",
    )
  })
})
