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
    // Fulfilled an hour ago: well inside the seven-day requester window.
    fulfilledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
}

const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()

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

    it("holds Head Office and Branch Admin to fulfilment and delivery as well", () => {
        for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN"]) {
            render(
                <RefundManagement
                    {...baseProps}
                    orderStatus="APPROVED"
                    orderFulfillmentStatus="OUT_FOR_DELIVERY"
                    fulfilledAt={null}
                    allowRefundRequest
                    requesterRole={role}
                />
            )
            expect(screen.queryByRole("button", { name: "Request Refund" }), role).toBeNull()
            expect(screen.getByText("Refund available after fulfillment and delivery")).toBeTruthy()
            cleanup()
        }
    })

    it("shows when the seven-day window closes while it is open", () => {
        render(<RefundManagement {...baseProps} allowRefundRequest requesterRole="ORDER_PORTAL" />)

        expect(screen.getByRole("button", { name: "Request Refund" })).toBeTruthy()
        expect(screen.getByText(/Refund can be requested until/)).toBeTruthy()
    })

    it.each(["ORDER_PORTAL", "GROUP_ORDER_PORTAL", "HEAD_OFFICE", "BRANCH_ADMIN"])(
        "closes the request for %s more than seven days after fulfilment",
        (role) => {
            render(<RefundManagement {...baseProps} fulfilledAt={EIGHT_DAYS_AGO} allowRefundRequest requesterRole={role} />)

            expect(screen.queryByRole("button", { name: "Request Refund" })).toBeNull()
            expect(screen.getByText("Refund period ended")).toBeTruthy()
            expect(screen.getByText("Refunds can be requested within 7 days of the order being fulfilled.")).toBeTruthy()
        },
    )

    it("puts no time limit on Super Admin", () => {
        render(<RefundManagement {...baseProps} fulfilledAt={EIGHT_DAYS_AGO} allowRefundRequest requesterRole="SUPER_ADMIN" />)

        expect(screen.getByRole("button", { name: "Request Refund" })).toBeTruthy()
        expect(screen.queryByText("Refund period ended")).toBeNull()
        expect(screen.queryByText(/Refund can be requested until/)).toBeNull()
    })
})
