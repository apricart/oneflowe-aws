import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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

    expect(headers.slice(0, 2)).toEqual(["Order ID", "Transaction ID"])
    expect(cells[headers.indexOf("Order ID")]?.textContent).toContain("#47")
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

  it("shows organization names in the table for Super Admin", () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 48,
          tid: "ORD-0048",
          organizationName: "Acme Organization",
          status: "PENDING",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    const table = within(screen.getByRole("table"))
    expect(table.getByRole("columnheader", { name: "Organization" })).toBeTruthy()
    expect(table.getByText("Acme Organization")).toBeTruthy()
  })

  it("hides the organization column from non-Super-Admin roles", () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 49,
          tid: "ORD-0049",
          organizationName: "Hidden Organization",
          status: "PENDING",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          totalCents: 125000,
        }]}
        userRole="BRANCH_ADMIN"
        isSuperAdmin={false}
        isBranchAdmin
        onUpdate={vi.fn()}
      />,
    )

    const table = within(screen.getByRole("table"))
    expect(table.queryByRole("columnheader", { name: "Organization" })).toBeNull()
    expect(table.queryByText("Hidden Organization")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /Columns/ }))
    expect(screen.queryByText("Organization", { selector: "span" })).toBeNull()
  })

  it("renders Apricart Support as cross-tenant view only even if capabilities are mistakenly present", async () => {
    render(
      <OrdersDirectory
        orders={[{
          id: 52,
          tid: "ORD-SUPPORT",
          organizationName: "Acme Organization",
          status: "PENDING",
          branchId: 8,
          branchName: "North Branch",
          createdAt: "2026-07-28T10:00:00.000Z",
          totalCents: 125000,
          approvalToken: "MUST-NOT-RENDER",
        }]}
        userRole="APRICART_SUPPORT"
        isSuperAdmin={false}
        isBranchAdmin={false}
        readOnly
        showOrganization
        showInvoiceLink={false}
        canDecideOrders
        onUpdate={vi.fn()}
      />,
    )

    const table = within(screen.getByRole("table"))
    const headers = table.getAllByRole("columnheader").map((header) => header.textContent)
    expect(headers).toContain("Organization")
    expect(headers).not.toContain("Fulfillment Token")
    expect(headers).not.toContain("Action")
    expect(screen.queryByText("MUST-NOT-RENDER")).toBeNull()

    fireEvent.click(screen.getByText("ORD-SUPPORT"))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    expect(within(drawer).queryByRole("button", { name: "Approve" })).toBeNull()
    expect(within(drawer).queryByRole("button", { name: "Reject" })).toBeNull()
  })

  it.each(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER"])(
    "shows partial delivery to the %s role",
    (role) => {
      render(
        <OrdersDirectory
          orders={[
            {
              id: 50,
              tid: "ORD-PARTIAL",
              status: "FULFILLED",
              partialDelivery: true,
              branchId: 8,
              branchName: "North Branch",
              createdAt: "2026-07-28T10:00:00.000Z",
              totalCents: 125000,
            },
            {
              id: 51,
              tid: "ORD-COMPLETE",
              status: "FULFILLED",
              partialDelivery: false,
              branchId: 8,
              branchName: "North Branch",
              createdAt: "2026-07-29T10:00:00.000Z",
              totalCents: 125000,
            },
          ]}
          userRole={role}
          isSuperAdmin={role === "SUPER_ADMIN"}
          isBranchAdmin={role === "BRANCH_ADMIN"}
          isHeadOffice={role === "HEAD_OFFICE"}
          onUpdate={vi.fn()}
        />,
      )

      const table = within(screen.getByRole("table"))
      const headers = table.getAllByRole("columnheader").map((header) => header.textContent)
      const partialDeliveryIndex = headers.indexOf("Partial Delivery")
      const partialRow = table.getByText("ORD-PARTIAL").closest("tr")
      const completeRow = table.getByText("ORD-COMPLETE").closest("tr")

      expect(partialDeliveryIndex).toBeGreaterThanOrEqual(0)
      expect(within(partialRow!).getAllByRole("cell")[partialDeliveryIndex]?.textContent).toBe("Yes")
      expect(within(completeRow!).getAllByRole("cell")[partialDeliveryIndex]?.textContent).toBe("No")
    },
  )

  it("keeps a visible horizontal scrollbar on the table", () => {
    render(
      <OrdersDirectory
        orders={[]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByTestId("orders-table-scroll").className).toContain("orders-table-scrollbar")
  })

  it("bounds the table height so its horizontal scrollbar stays in view, with a sticky header", () => {
    render(
      <OrdersDirectory
        orders={[]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByTestId("orders-table-scroll").className).toMatch(/max-h-\[/)
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.className).toContain("sticky")
      expect(header.className).toContain("top-0")
    }
  })
})

describe("OrdersDirectory fulfilment columns", () => {
  const activeDelivered = {
    id: 50,
    tid: "ORD-0050",
    status: "APPROVED",
    fulfillmentStatus: "DELIVERED",
    branchId: 8,
    branchName: "North Branch",
    createdAt: "2026-07-28T10:00:00.000Z",
    totalCents: 125000,
    approvalToken: "TOKEN0050",
  }
  const fulfilled = {
    ...activeDelivered,
    id: 51,
    tid: "ORD-0051",
    status: "FULFILLED",
    approvalToken: null,
  }

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  function cellsFor(tid: string) {
    const table = screen.getByRole("table")
    const headers = within(table).getAllByRole("columnheader").map((header) => header.textContent)
    const cells = within(within(table).getByText(tid).closest("tr")!).getAllByRole("cell")
    return {
      token: cells[headers.indexOf("Fulfillment Token")],
      action: cells[headers.indexOf("Action")],
    }
  }

  it("hides fulfillment-token and fulfillment-action controls from Super Admin", async () => {
    render(
      <OrdersDirectory orders={[activeDelivered]} userRole="SUPER_ADMIN" isSuperAdmin isBranchAdmin={false} onUpdate={vi.fn()} />,
    )
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((header) => header.textContent)
    expect(headers).not.toContain("Fulfillment Token")
    expect(headers).not.toContain("Action")
    expect(screen.queryByText("TOKEN0050")).toBeNull()
    expect(screen.queryByRole("button", { name: /Fulfil order/ })).toBeNull()

    fireEvent.click(screen.getByText("ORD-0050"))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    expect(within(drawer).queryByText("Fulfillment Token")).toBeNull()
    expect(within(drawer).queryByRole("button", { name: "Fulfill Order" })).toBeNull()
  })

  it("shows operational roles the token columns outside the column picker", () => {
    render(
      <OrdersDirectory orders={[activeDelivered, fulfilled]} userRole="BRANCH_ADMIN" isSuperAdmin={false} isBranchAdmin canDecideOrders onUpdate={vi.fn()} />,
    )
    const headers = within(screen.getByRole("table")).getAllByRole("columnheader").map((header) => header.textContent)
    expect(headers.slice(-2)).toEqual(["Fulfillment Token", "Action"])
    expect(cellsFor("ORD-0050").token?.textContent).toContain("TOKEN0050")
    expect(screen.getAllByText("Delivered · Unfulfilled")).toHaveLength(1)

    const done = cellsFor("ORD-0051")
    expect(done.token?.textContent).toBe("—")
    expect(done.action?.textContent).toBe("—")

    fireEvent.click(screen.getByRole("button", { name: /Columns/ }))
    expect(screen.queryByText("Fulfillment Token", { selector: "span" })).toBeNull()
  })

  it("lets an approver who holds the token fulfil by emailing it", async () => {
    const onUpdate = vi.fn()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ fulfilled: true, message: "Token sent" }),
    }))
    vi.stubGlobal("fetch", fetchMock)
    render(
      <OrdersDirectory orders={[activeDelivered]} userRole="BRANCH_ADMIN" isSuperAdmin={false} isBranchAdmin canDecideOrders onUpdate={onUpdate} />,
    )
    expect(screen.queryByRole("button", { name: "Fulfil order ORD-0050" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Fulfil order ORD-0050 by emailing its token" }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/v1/orders/50/send-token-email", expect.objectContaining({ method: "POST" }))
    })
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(screen.queryByRole("dialog", { name: "Order details" })).toBeNull()
  })

  it("lets Head Office hand off a scoped token without order-decision authority", async () => {
    render(
      <OrdersDirectory
        orders={[activeDelivered]}
        userRole="HEAD_OFFICE"
        isSuperAdmin={false}
        isBranchAdmin={false}
        isHeadOffice
        canDecideOrders={false}
        onUpdate={vi.fn()}
      />,
    )

    expect(cellsFor("ORD-0050").token?.textContent).toContain("TOKEN0050")
    expect(screen.getByRole("button", { name: "Fulfil order ORD-0050 by emailing its token" })).toBeTruthy()

    fireEvent.click(screen.getByText("ORD-0050"))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    expect(within(drawer).getByText("Fulfillment Token")).toBeTruthy()
    expect(within(drawer).getByRole("button", { name: /Send Token to Admin/i })).toBeTruthy()
    expect(within(drawer).queryByRole("button", { name: /Approve|Reject/i })).toBeNull()
  })

  it("offers no action when the server withheld the token", () => {
    render(
      <OrdersDirectory
        orders={[{ ...activeDelivered, approvalToken: null }]}
        userRole="HEAD_OFFICE"
        isSuperAdmin={false}
        isBranchAdmin={false}
        isHeadOffice
        onUpdate={vi.fn()}
      />,
    )
    const row = cellsFor("ORD-0050")
    expect(row.token?.textContent).toBe("—")
    expect(row.action?.textContent).toBe("—")
  })
})

describe("OrdersDirectory column sorting", () => {
  afterEach(() => {
    cleanup()
  })

  const renderSorted = (onSort = vi.fn()) => {
    render(
      <OrdersDirectory
        orders={[]}
        userRole="SUPER_ADMIN"
        isSuperAdmin
        isBranchAdmin={false}
        sort={{ key: "orderDate", direction: "desc" }}
        onSort={onSort}
        onUpdate={vi.fn()}
      />,
    )
    return onSort
  }

  it("marks the sorted column for assistive technology and no other", () => {
    renderSorted()

    const sorted = screen.getAllByRole("columnheader").filter((header) => header.hasAttribute("aria-sort"))
    expect(sorted).toHaveLength(1)
    expect(sorted[0].textContent).toContain("Order Date")
    expect(sorted[0].getAttribute("aria-sort")).toBe("descending")
  })

  it("asks for text columns A→Z and number or date columns largest-first on the first click", () => {
    const onSort = renderSorted()

    fireEvent.click(screen.getByRole("button", { name: /^branch$/i }))
    fireEvent.click(screen.getByRole("button", { name: /^amount$/i }))

    expect(onSort).toHaveBeenNthCalledWith(1, "branch", "asc")
    expect(onSort).toHaveBeenNthCalledWith(2, "amount", "desc")
  })

  it("keeps plain labels when the page does not sort", () => {
    render(
      <OrdersDirectory orders={[]} userRole="SUPER_ADMIN" isSuperAdmin isBranchAdmin={false} onUpdate={vi.fn()} />,
    )
    expect(screen.queryByRole("button", { name: /^branch$/i })).toBeNull()
  })
})
