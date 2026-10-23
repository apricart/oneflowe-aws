import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"
import { UNPAID_INVOICE_ALERT_STORAGE_KEYS } from "@/lib/unpaid-invoice-alerts"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())

import { UnpaidInvoiceAlerts } from "./unpaid-invoice-alerts"

const URL_PATH = "/api/v1/payment-control/ordering-alerts"
const north = { branchId: 7, branchName: "North", unpaidInvoiceCount: 3, threshold: 4 }
const south = { branchId: 9, branchName: "South", unpaidInvoiceCount: 1, threshold: 2 }
const northBlocked = { ...north, unpaidInvoiceCount: 4 }
const empty = { blocked: [], lastOrder: [], otherBranchesCanOrder: false, otherBranchesUnaffected: false }

const render = () => renderWithApp(<UnpaidInvoiceAlerts />, { withAppContext: false })
const kinds = () => screen.queryAllByTestId("unpaid-invoice-alert").map((node) => node.getAttribute("data-kind"))

beforeEach(() => {
  sessionStorage.clear()
})

describe("UnpaidInvoiceAlerts", () => {
  it("shows an Order Initiator the last-order alert at the top of the page", async () => {
    resetUi({ role: "ORDER_PORTAL", id: "u-1", branchId: 7 })
    installFetch([[URL_PATH, { ...empty, lastOrder: [north] }]])
    render()

    expect(await screen.findByText("You can place only one more order.")).toBeTruthy()
    expect(screen.getByText(/Your branch has 3 unpaid invoices and ordering stops at 4\./)).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows a blocked Order Initiator the blocked alert instead", async () => {
    resetUi({ role: "ORDER_PORTAL", id: "u-1", branchId: 7 })
    installFetch([[URL_PATH, { ...empty, blocked: [northBlocked] }]])
    render()

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByText("Your ordering is blocked.")).toBeTruthy()
    expect(screen.getByText("You have 4 unpaid invoices. Clear your dues before creating a new order.")).toBeTruthy()
    expect(kinds()).toEqual(["blocked"])
  })

  it("shows a group role both alerts, blocked first, each naming its branches", async () => {
    resetUi({ role: "GROUP_ORDER_PORTAL", id: "u-2" })
    installFetch([[URL_PATH, { blocked: [northBlocked], lastOrder: [south], otherBranchesCanOrder: true, otherBranchesUnaffected: false }]])
    render()

    expect(await screen.findByText("Your ordering is blocked for North.")).toBeTruthy()
    expect(screen.getByText("You can place only one more order for South.")).toBeTruthy()
    expect(kinds()).toEqual(["blocked", "lastOrder"])
  })

  it("renders nothing when no branch needs an alert", async () => {
    resetUi({ role: "BRANCH_ADMIN", id: "u-3", branchId: 7 })
    installFetch([[URL_PATH, empty]])
    render()

    await waitFor(() => expect(callsTo(URL_PATH)).toHaveLength(1))
    expect(kinds()).toEqual([])
  })

  it("never asks for a role that is not alerted", async () => {
    resetUi({ role: "HEAD_OFFICE", id: "u-4", organizationId: 1 })
    installFetch([[URL_PATH, { ...empty, blocked: [northBlocked] }]])
    render()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(callsTo(URL_PATH)).toHaveLength(0)
    expect(kinds()).toEqual([])
  })

  it("closes one alert without the other, and it stays closed while nothing changes", async () => {
    resetUi({ role: "GROUP_USER", id: "u-5" })
    installFetch([[URL_PATH, { blocked: [northBlocked], lastOrder: [south], otherBranchesCanOrder: true, otherBranchesUnaffected: false }]])
    const first = render()

    await screen.findByText("Ordering is blocked for North.")
    const [closeBlocked] = screen.getAllByRole("button", { name: "Dismiss this alert" })
    fireEvent.click(closeBlocked)
    expect(kinds()).toEqual(["lastOrder"])
    expect(sessionStorage.getItem(UNPAID_INVOICE_ALERT_STORAGE_KEYS.blocked)).toBe("blocked|7:4:4")

    first.unmount()
    render()
    await screen.findByText("South can place only one more order.")
    expect(kinds()).toEqual(["lastOrder"])
  })

  it("comes back once the count changes", async () => {
    sessionStorage.setItem(UNPAID_INVOICE_ALERT_STORAGE_KEYS.blocked, "blocked|7:4:4")
    resetUi({ role: "BRANCH_ADMIN", id: "u-3", branchId: 7 })
    installFetch([[URL_PATH, { ...empty, blocked: [{ ...northBlocked, unpaidInvoiceCount: 5 }] }]])
    render()

    expect(await screen.findByText("Ordering is blocked for your branch.")).toBeTruthy()
  })
})
