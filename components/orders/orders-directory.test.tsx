import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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
    localStorage.clear()
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

  it("shows the approval and delivery dates for an active delivered order", async () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 45,
          tid: "ORD-0045",
          status: "APPROVED",
          fulfillmentStatus: "DELIVERED",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          approvedAt: "2026-07-29T10:00:00.000Z",
          deliveredAt: "2026-07-30T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("ORD-0045"))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    const drawerQueries = within(drawer)

    expect(drawerQueries.getByText("Approval Date")).toBeTruthy()
    expect(drawerQueries.getByText(/29 Jul 2026/)).toBeTruthy()
    expect(drawerQueries.getByText("Delivery Date")).toBeTruthy()
    expect(drawerQueries.getByText(/30 Jul 2026/)).toBeTruthy()
    expect(drawerQueries.queryByText("Fulfilled Date")).toBeNull()
  })

  it("shows fulfillment and delivery dates for a fulfilled delivered order", async () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 46,
          tid: "ORD-0046",
          status: "FULFILLED",
          fulfillmentStatus: "DELIVERED",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          fulfilledAt: "2026-07-31T10:00:00.000Z",
          deliveredAt: "2026-07-30T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByText("ORD-0046"))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    const drawerQueries = within(drawer)

    expect(drawerQueries.getByText("Fulfilled Date")).toBeTruthy()
    expect(drawerQueries.getByText(/31 Jul 2026/)).toBeTruthy()
    expect(drawerQueries.getByText("Delivery Date")).toBeTruthy()
    expect(drawerQueries.getByText(/30 Jul 2026/)).toBeTruthy()
    expect(drawerQueries.queryByText("Approval Date")).toBeNull()
  })

  it("splits status types and lifecycle dates into selectable table columns", () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 47,
          tid: "ORD-0047",
          status: "FULFILLED",
          fulfillmentStatus: "DELIVERED",
          paymentStatus: "PAID",
          refundAmountCents: 2500,
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          approvedAt: "2026-07-29T10:00:00.000Z",
          deliveredAt: "2026-07-30T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    const table = screen.getByRole("table")
    const tableQueries = within(table)
    const headers = tableQueries.getAllByRole("columnheader").map((header) => header.textContent)
    const orderRow = tableQueries.getByText("ORD-0047").closest("tr")
    const cells = within(orderRow!).getAllByRole("cell")

    expect(cells[headers.indexOf("Order Status")]?.textContent).toContain("Fulfilled")
    expect(cells[headers.indexOf("Progress")]?.textContent).toContain("Delivered")
    expect(cells[headers.indexOf("Payment")]?.textContent).toContain("Paid")
    expect(cells[headers.indexOf("Refund")]?.textContent).toContain("Partial Refund")
    expect(cells[headers.indexOf("Order Date")]?.textContent).toContain("28 Jul 2026")
    expect(cells[headers.indexOf("Approval Date")]?.textContent).toContain("29 Jul 2026")
    expect(cells[headers.indexOf("Delivery Date")]?.textContent).toContain("30 Jul 2026")

    fireEvent.click(screen.getByRole("button", { name: /Columns/ }))
    fireEvent.click(screen.getByText("Approval Date", { selector: "span" }))

    expect(tableQueries.queryByRole("columnheader", { name: "Approval Date" })).toBeNull()
  })
})
