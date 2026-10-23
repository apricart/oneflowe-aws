import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())

import { OrderingBlocksWorkspace } from "./ordering-blocks-workspace"

/**
 * Head Office's Ordering Blocks page
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md): what it
 * shows comes from the list endpoint, and a grant goes through the existing
 * payment-control panel to the existing grant route.
 */

const LIST = "/api/v1/payment-control/branches"
const STATUS = "/api/v1/payment-control"
const GRANT = "/api/v1/payment-control/exceptions"

const north = {
  branchId: 7,
  branchName: "North",
  branchCode: "N-1",
  unpaidInvoiceCount: 3,
  standing: "BLOCKED",
  orderingAllowed: false,
  exception: null,
}
const south = {
  branchId: 9,
  branchName: "South",
  branchCode: null,
  unpaidInvoiceCount: 4,
  standing: "EXCEPTION_ACTIVE",
  orderingAllowed: true,
  exception: { id: 3, startAt: "2026-10-20T09:00:00.000Z", expiresAt: "2026-11-20T09:00:00.000Z", revokedAt: null, active: true, grantedByName: "Head Office", reason: null },
}

const enabledList = (items: unknown[]) => ({
  enabled: true,
  threshold: 3,
  summary: { branches: 12, blocked: 1, exceptionActive: 1, lastOrder: 2 },
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
})

const statusView = (overrides: Record<string, unknown> = {}) => ({
  branch: { id: 7, name: "North" },
  state: "BLOCKED",
  orderingAllowed: false,
  reason: "THRESHOLD_REACHED",
  configured: true,
  overdueCount: 3,
  threshold: 3,
  limitReached: true,
  overdueItems: [],
  blockedSince: null,
  exception: null,
  exceptionActive: false,
  timeline: [],
  evaluatedAt: "2026-10-23T09:00:00.000Z",
  canManageExceptions: true,
  ...overrides,
})

const render = () => renderWithApp(<OrderingBlocksWorkspace />, { withAppContext: false })

beforeEach(() => {
  resetUi({ role: "HEAD_OFFICE", id: "u-ho", organizationId: 10 })
})

describe("OrderingBlocksWorkspace", () => {
  it("says there is nothing to manage when the organization does not block on unpaid invoices", async () => {
    installFetch([[LIST, { enabled: false }]])
    render()

    expect(await screen.findByTestId("ordering-blocks-disabled")).toBeTruthy()
    expect(screen.getByText("Ordering is not blocked on unpaid invoices")).toBeTruthy()
    expect(screen.queryAllByTestId("ordering-block-row")).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Blocked" })).toBeNull()
  })

  it("opens on the branches that need attention, with the organization's figures and limit", async () => {
    installFetch([[LIST, enabledList([north, south])]])
    render()

    const rows = await screen.findAllByTestId("ordering-block-row")
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText("Ordering blocked")).toBeTruthy()
    expect(within(rows[0]).getByText("3 of 3 unpaid invoices")).toBeTruthy()
    expect(within(rows[0]).getByRole("button", { name: "Manage ordering for North" }).textContent).toBe("Allow ordering")
    expect(within(rows[1]).getByText("Ordering on exception")).toBeTruthy()
    expect(within(rows[1]).getByText(/Exception: Until/)).toBeTruthy()
    expect(screen.getByText("Active branches").nextSibling?.textContent).toBe("12")
    expect(screen.getByText(/A branch stops ordering at 3 unpaid invoices\./)).toBeTruthy()
    expect(callsTo(LIST)[0].url).toContain("filter=attention")
  })

  it("asks the server for the chosen filter, from page 1", async () => {
    installFetch([[LIST, enabledList([north])]])
    render()
    await screen.findAllByTestId("ordering-block-row")

    fireEvent.click(screen.getByRole("button", { name: "All branches" }))
    await waitFor(() => expect(ui.calls.some((call) => call.url.includes("filter=all") && call.url.includes("page=1"))).toBe(true))
  })

  it("lets Head Office grant the exception for a blocked branch through the existing grant route", async () => {
    installFetch([
      [LIST, enabledList([north])],
      [GRANT, statusView({
        orderingAllowed: true,
        exceptionActive: true,
        reason: "EXCEPTION_ACTIVE",
        exception: { id: 5, startAt: "2026-10-23T09:00:00.000Z", expiresAt: "2026-11-23T09:00:00.000Z", revokedAt: null, active: true, grantedBy: { userId: "u-ho", name: "Head Office" }, reason: "Cheque in transit", revokeReason: null },
      })],
      [STATUS, statusView()],
    ])
    render()

    fireEvent.click(await screen.findByRole("button", { name: "Manage ordering for North" }))
    const panel = await screen.findByTestId("payment-control-panel")
    expect(callsTo(STATUS)[0].url).toBe("/api/v1/payment-control?branchId=7")

    fireEvent.click(within(panel).getByRole("button", { name: /Grant exception/ }))
    fireEvent.change(await screen.findByLabelText("Reason (optional)"), { target: { value: "Cheque in transit" } })
    const confirm = screen.getAllByRole("button", { name: /Grant exception/ }).at(-1)!
    fireEvent.click(confirm)

    await waitFor(() => expect(callsTo(GRANT, "POST")).toHaveLength(1))
    expect(callsTo(GRANT, "POST")[0].body).toEqual({ branchId: 7, reason: "Cheque in transit" })
    // The list is read again so the row reflects the grant.
    await waitFor(() => expect(callsTo(LIST).length).toBeGreaterThan(1))
  })

  it("offers no grant inside the panel once an exception is in force", async () => {
    installFetch([
      [LIST, enabledList([south])],
      [STATUS, statusView({ branch: { id: 9, name: "South" }, orderingAllowed: true, exceptionActive: true, exception: { ...south.exception, grantedBy: null, revokeReason: null } })],
    ])
    render()

    fireEvent.click(await screen.findByRole("button", { name: "Manage ordering for South" }))
    const panel = await screen.findByTestId("payment-control-panel")
    expect(within(panel).queryByRole("button", { name: /Grant exception/ })).toBeNull()
    expect(within(panel).getByRole("button", { name: /Revoke exception/ })).toBeTruthy()
  })

  it("shows the error and a retry when the list cannot be read", async () => {
    installFetch([[LIST, { status: 500, body: { error: "An unexpected error occurred. Please try again later." } }]])
    render()

    expect(await screen.findByText("Ordering blocks could not be loaded")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy()
  })
})
