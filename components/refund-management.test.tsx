import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("swr", () => ({
    default: () => ({
        data: { refunds: [] },
        mutate: vi.fn(),
    }),
}))

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: vi.fn() }),
}))

import { RefundManagement } from "@/components/refund-management"

const baseProps = {
    orderId: 42,
    orderTotalCents: 100_000,
    orderStatus: "FULFILLED",
    orderFulfillmentStatus: "DELIVERED",
    createdAt: new Date().toISOString(),
}

describe("RefundManagement refund request visibility", () => {
    afterEach(() => {
        cleanup()
    })

    it("keeps refund history visible but hides the request action when requests are disabled", () => {
        render(<RefundManagement {...baseProps} allowRefundRequest={false} />)

        expect(screen.getByRole("heading", { name: "Refund History" })).toBeTruthy()
        expect(screen.queryByRole("button", { name: "Request Refund" })).toBeNull()
    })

    it("shows the request action for an eligible non-super-admin user", () => {
        render(<RefundManagement {...baseProps} allowRefundRequest requesterRole="ORDER_PORTAL" />)

        expect(screen.getByRole("button", { name: "Request Refund" })).toBeTruthy()
    })

    it("hides the request action from Order Portal until fulfillment and delivery", () => {
        const { rerender } = render(
            <RefundManagement
                {...baseProps}
                orderStatus="APPROVED"
                allowRefundRequest
                requesterRole="ORDER_PORTAL"
            />
        )

        expect(screen.queryByRole("button", { name: "Request Refund" })).toBeNull()
        expect(screen.getByText("Refund available after fulfillment and delivery")).toBeTruthy()

        rerender(
            <RefundManagement
                {...baseProps}
                orderFulfillmentStatus="OUT_FOR_DELIVERY"
                allowRefundRequest
                requesterRole="ORDER_PORTAL"
            />
        )

        expect(screen.queryByRole("button", { name: "Request Refund" })).toBeNull()
        expect(screen.getByText("Refund available after fulfillment and delivery")).toBeTruthy()
    })
})
