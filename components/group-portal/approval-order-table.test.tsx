import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
  toast: vi.fn(),
}))

// The drawer reads the order through SWR; the fetch itself is not under test,
// so it stays pending and the panel renders from the queue row.
vi.mock("swr", () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: true }),
}))

import { ApprovalOrderTable } from "@/components/group-portal/approval-order-table"
import type { ApprovalOrder } from "@/components/group-portal/approval-types"

const pendingOrder: ApprovalOrder = {
  id: 42,
  tid: "ORD-0042",
  branchId: 7,
  branchName: "Airport Branch",
  branchCostCenterId: "0001",
  status: "PENDING",
  fulfillmentStatus: "NOT_STARTED",
  totalCents: 71000,
  itemCount: 3,
  createdAt: "2026-08-19T15:10:00.000Z",
  approvedAt: null,
  rejectionReason: null,
  approvalToken: null,
}

function renderTable(overrides: Partial<Parameters<typeof ApprovalOrderTable>[0]> = {}) {
  const onDecide = vi.fn()
  const onToggleSelection = vi.fn()

  render(
    <ApprovalOrderTable
      orders={[pendingOrder]}
      selectedIds={new Set()}
      onToggleSelection={onToggleSelection}
      onDecide={onDecide}
      busy={false}
      {...overrides}
    />,
  )

  return { onDecide, onToggleSelection }
}

describe("ApprovalOrderTable", () => {
  afterEach(cleanup)

  it("opens the shared order detail drawer for the order that was clicked", async () => {
    renderTable()

    fireEvent.click(screen.getByRole("button", { name: "ORD-0042" }))

    const drawer = await screen.findByRole("dialog", { name: "Order details" })
    const descriptionId = drawer.getAttribute("aria-describedby")

    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toContain("order ORD-0042")
  })

  it("keeps the row's own controls from opening the drawer behind them", () => {
    const { onDecide } = renderTable()

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }))

    expect(onDecide).toHaveBeenCalledWith([42], "approve")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("offers a decision inside the drawer only while the order is pending", async () => {
    renderTable({ orders: [{ ...pendingOrder, status: "APPROVED", approvedAt: "2026-08-19T16:00:00.000Z" }] })

    fireEvent.click(screen.getByRole("button", { name: "ORD-0042" }))
    const drawer = await screen.findByRole("dialog", { name: "Order details" })

    expect(drawer.textContent).toContain("Airport Branch")
    expect(within(drawer).queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(within(drawer).queryByRole("button", { name: /Reject/ })).toBeNull()
  })
})
