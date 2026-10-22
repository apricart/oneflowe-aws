import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ExecutiveApprovalOrder } from "./executive-approvals"

const swr = vi.hoisted(() => ({ keys: [] as string[], page: null as unknown, mutateKeys: vi.fn() }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) swr.keys.push(key)
    return { data: swr.page, error: undefined, isLoading: false }
  },
  useSWRConfig: () => ({ mutate: swr.mutateKeys }),
}))
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }))

import { ExecutiveApprovals } from "./executive-approvals"

const order = (id: number, overrides: Partial<ExecutiveApprovalOrder> = {}): ExecutiveApprovalOrder => ({
  id,
  tid: `TID-${id}`,
  status: "PENDING",
  organizationName: "Meezan",
  branchName: "Clifton",
  branchCity: "Karachi",
  subtotalCents: 127_119,
  taxCents: 22_881,
  totalCents: 150_000,
  poNumber: null,
  notes: null,
  intakeChannel: "WHATSAPP",
  intakeReference: "Ali, 10:14",
  hasAttachment: true,
  enteredBy: "Sana Desk",
  createdAt: "2026-10-05T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.123Z",
  approvedAt: null,
  approvedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  returnedForCorrectionAt: null,
  correctionRequestNote: null,
  canApprove: true,
  canReject: true,
  canReturn: true,
  items: [{ id: 9, productName: "Rice", productCode: "P-1", quantity: 2, unit: "kg", priceCents: 75_000 }],
  ...overrides,
})

function page(items: ExecutiveApprovalOrder[], organizations = [{ id: 4, name: "Meezan" }]) {
  return {
    items,
    organizations,
    counts: { awaiting_approval: 3, returned: 1, approved: 8, rejected: 2, all: 14 },
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  swr.keys = []
  swr.mutateKeys.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("an executive's approvals", () => {
  it("opens on the orders awaiting approval, with every tab's count", () => {
    swr.page = page([order(1)])
    render(<ExecutiveApprovals />)
    const tabs = within(screen.getByRole("tablist", { name: "Approval status" })).getAllByRole("tab")
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Awaiting approval3",
      "With the desk1",
      "Approved8",
      "Rejected2",
      "All14",
    ])
    expect(swr.keys.some((key) => key.startsWith("/api/v1/executive/approvals?") && key.includes("status=awaiting_approval"))).toBe(true)
  })

  it("shows what is being approved: lines, amounts, where it came from, and the customer's message", () => {
    swr.page = page([order(1)])
    render(<ExecutiveApprovals />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("Rice")).toBeTruthy()
    expect(within(card).getByText("Sana Desk", { exact: false })).toBeTruthy()
    expect(within(card).getByText("Ali, 10:14")).toBeTruthy()
    expect(within(card).getByRole("link", { name: /Customer's message/ }).getAttribute("href"))
      .toBe("/api/v1/executive/approvals/1/attachment")
  })

  it("marks a line the Order Desk priced, beside the catalogue price it replaced", () => {
    swr.page = page([order(1, {
      items: [
        { id: 9, productName: "Rice", productCode: "P-1", quantity: 2, unit: "kg", priceCents: 70_000, priceEnteredManually: true, cataloguePriceCents: 75_000 },
        { id: 10, productName: "Tape", productCode: "P-2", quantity: 1, unit: "roll", priceCents: 900, priceEnteredManually: true, cataloguePriceCents: null, inBranchCatalogue: false },
      ],
    })])
    render(<ExecutiveApprovals />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("Custom prices")).toBeTruthy()
    expect(within(card).getAllByText(/Price set by Order Desk/)).toHaveLength(2)
    expect(within(card).getByText("Rs 750.00", { exact: false }).className).toContain("line-through")
    expect(within(card).getByText(/no catalogue price/)).toBeTruthy()
    // A product the branch does not carry is named as such, beside its line.
    const tape = within(card).getByText("Tape").closest("tr")!
    expect(within(tape).getByText("Not in branch catalogue")).toBeTruthy()
    expect(within(within(card).getByText("Rice").closest("tr")!).queryByText("Not in branch catalogue")).toBeNull()
  })

  it("marks nothing on an order charged at catalogue prices", () => {
    swr.page = page([order(1)])
    render(<ExecutiveApprovals />)
    expect(screen.queryByText("Custom prices")).toBeNull()
    expect(screen.queryByText(/Price set by Order Desk/)).toBeNull()
  })

  it("approves the version it showed, after a confirmation, and refreshes every approvals read", async () => {
    swr.page = page([order(1)])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Order approved" }), { status: 200 }))
    render(<ExecutiveApprovals />)
    fireEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Approve/ }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/v1/executive/approvals/1/approve")
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ expectedUpdatedAt: "2026-10-05T10:00:00.123Z" })
    await waitFor(() => expect(swr.mutateKeys).toHaveBeenCalledTimes(1))
    const matcher = swr.mutateKeys.mock.calls[0][0] as (key: unknown) => boolean
    expect(matcher("/api/v1/executive/approvals?status=awaiting_approval&limit=1")).toBe(true)
    expect(matcher("/api/v1/delivery-dashboard")).toBe(false)
  })

  it("requires a reason to reject, and sends it trimmed", async () => {
    swr.page = page([order(1)])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Order rejected" }), { status: 200 }))
    render(<ExecutiveApprovals />)
    fireEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Reject/ }))
    const dialog = screen.getByRole("dialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject order" }))
    expect(within(dialog).getByText("A reason is required")).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "  Duplicate  " } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject order" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/executive/approvals/1/reject")
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ reason: "Duplicate" })
  })

  it("sends an order back with a comment", async () => {
    swr.page = page([order(1)])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "ok" }), { status: 200 }))
    render(<ExecutiveApprovals />)
    fireEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Send back/ }))
    const dialog = screen.getByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText(/What should the desk correct/), { target: { value: "3 kg, not 2" } })
    fireEvent.click(within(dialog).getByRole("button", { name: "Send back" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/executive/approvals/1/return")
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ comment: "3 kg, not 2" })
  })

  it("offers only Reject on an order that is with the desk, and shows what was asked", () => {
    swr.page = page([order(2, {
      returnedForCorrectionAt: "2026-10-06T09:00:00.000Z",
      correctionRequestNote: "3 kg, not 2",
      canApprove: false,
      canReturn: false,
    })])
    render(<ExecutiveApprovals />)
    const card = screen.getByRole("article")
    expect(within(card).getByText("With the desk for correction")).toBeTruthy()
    expect(within(card).getByText(/3 kg, not 2/)).toBeTruthy()
    expect(within(card).queryByRole("button", { name: /Approve/ })).toBeNull()
    expect(within(card).queryByRole("button", { name: /Send back/ })).toBeNull()
    expect(within(card).getByRole("button", { name: /Reject/ })).toBeTruthy()
  })

  it("offers nothing on a decided order", () => {
    swr.page = page([order(3, {
      status: "APPROVED",
      approvedAt: "2026-10-06T09:00:00.000Z",
      approvedBy: "Ayesha",
      canApprove: false,
      canReject: false,
      canReturn: false,
    })])
    render(<ExecutiveApprovals />)
    const card = screen.getByRole("article")
    expect(within(card).getByText(/Approved .* by Ayesha/)).toBeTruthy()
    expect(within(card).queryAllByRole("button")).toHaveLength(0)
  })

  it("says plainly when no organization is assigned", () => {
    swr.page = page([], [])
    render(<ExecutiveApprovals />)
    expect(screen.getByText("No organizations are assigned to you for approvals.")).toBeTruthy()
    expect(screen.queryByRole("tablist")).toBeNull()
  })

  it("reloads when an approval is refused because the order changed", async () => {
    swr.page = page([order(1)])
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "The order was changed or decided since you opened it; reload and review it again" }), { status: 409 }))
    render(<ExecutiveApprovals />)
    fireEvent.click(within(screen.getByRole("article")).getByRole("button", { name: /Approve/ }))
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(swr.mutateKeys).toHaveBeenCalledTimes(1))
  })
})
