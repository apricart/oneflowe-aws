import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ApprovalsWorkspace } from "./approvals-workspace"

vi.mock("@/components/group-portal/approval-queue", () => ({
  ApprovalQueue: () => <div data-testid="group-order-queue">Group-order queue</div>,
}))
vi.mock("@/components/group-portal/approval-all-orders", () => ({
  ApprovalAllOrders: () => <div data-testid="all-orders">All assigned orders</div>,
}))
vi.mock("@/components/group-portal/approval-other-orders", () => ({
  ApprovalOtherOrders: () => <div data-testid="other-orders">Branch-raised orders</div>,
}))

describe("ApprovalsWorkspace", () => {
  afterEach(cleanup)

  it("opens on the group-order queue and explains the multi-branch decision scope", () => {
    render(<ApprovalsWorkspace />)

    expect(screen.getByRole("heading", { name: "Order Approvals" })).toBeTruthy()
    expect(screen.getByText(/every branch assigned to you/i)).toBeTruthy()
    expect(screen.getByRole("tab", { name: "By group order" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("group-order-queue")).toBeTruthy()
    expect(screen.queryByTestId("all-orders")).toBeNull()
  })

  it("keeps group submissions, all assigned orders, and branch-raised orders as distinct views", () => {
    render(<ApprovalsWorkspace />)

    fireEvent.mouseDown(screen.getByRole("tab", { name: "All branch orders" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByTestId("all-orders")).toBeTruthy()
    expect(screen.queryByTestId("group-order-queue")).toBeNull()

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Other orders" }), {
      button: 0,
      ctrlKey: false,
    })
    expect(screen.getByTestId("other-orders")).toBeTruthy()
    expect(screen.queryByTestId("all-orders")).toBeNull()
  })
})
