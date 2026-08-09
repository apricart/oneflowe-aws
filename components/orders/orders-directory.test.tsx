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

  it("shows approve and reject controls to a configured Head Office approver", async () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 43,
          tid: "ORD-0043",
          status: "PENDING",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="HEAD_OFFICE"
        isSuperAdmin={false}
        isBranchAdmin={false}
        isHeadOffice
        canDecideOrders
        onUpdate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("ORD-0043"))
    expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy()
  })

  it("hides decision controls from a role that is not the configured approver", async () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 44,
          tid: "ORD-0044",
          status: "PENDING",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="BRANCH_ADMIN"
        isSuperAdmin={false}
        isBranchAdmin
        canDecideOrders={false}
        onUpdate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("ORD-0044"))
    await screen.findByRole("dialog", { name: "Order details" })
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull()
  })
})
