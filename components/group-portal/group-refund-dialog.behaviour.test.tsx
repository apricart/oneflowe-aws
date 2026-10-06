import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import { GroupRefundDialog } from "./group-refund-dialog"

/**
 * The group refund dialog against the workspace the server returns (the same
 * shape `tests/integration/group-refunds-api.test.ts` checks on the server).
 * The dialog may only ever ask: the payload it sends is order ids, line ids
 * and quantities — never a price — and quantities never exceed what is left.
 */
const WORKSPACE = {
  item: {
    groupOrder: { id: 50, reference: "GRP-50", groupName: "Distribution", createdAt: "2026-10-01T10:00:00.000Z" },
    refundable: [{
      orderId: 1, tid: "TID-N", branchId: 11, branchName: "North", status: "FULFILLED", fulfillmentStatus: "DELIVERED",
      totalCents: 10_000, remainingRefundableCents: 10_000, createdAt: "2026-10-01T10:00:00.000Z",
      lines: [{ orderItemId: 11, productName: "Paper", productCode: "PP", unit: "Ream", globalProductId: 7, priceCents: 1_000, quantityOrdered: 4, quantityRemaining: 4, allowDecimalQuantity: false, quantityStep: null }],
    }],
    ineligible: [{ orderId: 2, tid: "TID-S", branchId: 12, branchName: "South", status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY", reason: "A refund can be requested once this order has been fulfilled and delivered." }],
  },
}

function routes(post: unknown = { item: { reference: "GRP-50", requestedOrderCount: 1, skippedOrderCount: 0, totalAmountCents: 2_000, results: [] } }) {
  installFetch([
    ["/api/v1/group-portal/refunds/50", WORKSPACE],
    ["/api/v1/group-portal/refunds", post],
  ])
}

async function chooseTwoReams() {
  fireEvent.click(await screen.findByText("By branch"))
  const north = (await screen.findAllByText("North")).map((node) => node.closest("button")).find(Boolean)
  if (north) fireEvent.click(north)
  const quantity = await screen.findByLabelText(/Refund quantity for/)
  fireEvent.change(quantity, { target: { value: "9" } })
  expect((quantity as HTMLInputElement).value).toBe("4")
  fireEvent.change(quantity, { target: { value: "2" } })
}

beforeEach(() => {
  resetUi({ id: "gop", role: "GROUP_ORDER_PORTAL", organizationId: 5 })
  toast.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Group refund dialog", () => {
  it("explains why a branch order cannot be refunded", async () => {
    routes()
    renderWithApp(<GroupRefundDialog groupOrderId={50} reference="GRP-50" open onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText("By branch"))
    expect(await screen.findByText(/fulfilled and delivered/)).toBeTruthy()
  })

  it("sends order, line and quantity only, after a reason is given", async () => {
    routes()
    const onSubmitted = vi.fn()
    renderWithApp(<GroupRefundDialog groupOrderId={50} reference="GRP-50" open onClose={vi.fn()} onSubmitted={onSubmitted} />)
    await chooseTwoReams()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(await screen.findByPlaceholderText("Add any detail the administrator will need…"), { target: { value: "Damaged in transit" } })
    const submit = await screen.findByRole("button", { name: /Submit refund request|Continue/ })
    fireEvent.click(submit)
    const finalSubmit = screen.queryByRole("button", { name: "Submit refund request" })
    if (finalSubmit) fireEvent.click(finalSubmit)

    await waitFor(() => expect(callsTo("/api/v1/group-portal/refunds", "POST")).toHaveLength(1))
    const body = callsTo("/api/v1/group-portal/refunds", "POST")[0].body as any
    expect(body.groupOrderId).toBe(50)
    expect(body.orders).toEqual([{ orderId: 1, items: [{ id: 11, quantity: 2 }] }])
    expect(body.reason).toContain("Damaged in transit")
    expect(JSON.stringify(body)).not.toMatch(/price|cents/i)
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled())
  })

  it("shows the server's refusal", async () => {
    routes({ status: 400, body: { error: "Only 1 of Paper is still refundable." } })
    renderWithApp(<GroupRefundDialog groupOrderId={50} reference="GRP-50" open onClose={vi.fn()} />)
    await chooseTwoReams()
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(await screen.findByPlaceholderText("Add any detail the administrator will need…"), { target: { value: "x" } })
    for (let i = 0; i < 2; i += 1) {
      const next = screen.queryByRole("button", { name: "Submit refund request" }) ?? screen.queryByRole("button", { name: "Continue" })
      if (next && !(next as HTMLButtonElement).disabled) fireEvent.click(next)
    }
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Refund request not submitted",
      description: "Only 1 of Paper is still refundable.",
    })))
  })

  it("loads nothing while closed", () => {
    routes()
    renderWithApp(<GroupRefundDialog groupOrderId={50} reference="GRP-50" open={false} onClose={vi.fn()} />)
    expect(callsTo("/api/v1/group-portal/refunds/50")).toHaveLength(0)
  })
})
