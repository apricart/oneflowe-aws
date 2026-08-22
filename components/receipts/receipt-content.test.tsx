import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const receiptResponse = {
    pricesHidden: false,
    receiptData: {
        invoiceNumber: "247/JUL/APR/2026",
        date: "07/27/2026",
        status: "Fulfilled",
        statusKey: "fulfilled",
        buyerName: "ASU-CPU Central Processing Unit",
        buyerAddress: "Ground Floor, Mai Kolachi Road, Karachi, Sindh",
        buyerPhone: "021-36184137",
        organizationName: "United Bank Limited",
        organizationNtn: "0801164-8",
        placedByName: "Rajesh Ramesh",
        placedByPhone: "0300-2185120",
        approvedByName: "Muhammad Faisal Siddiqui",
        items: [
            {
                mainCategoryName: "Stationery",
                subCategories: [
                    {
                        subCategoryName: "Paper",
                        items: [{ description: "A4 Paper Ream", quantity: 12, rate: 1250, total: 15000 }],
                    },
                ],
            },
        ],
        subtotal: 15000,
        tax: 2550,
        discount: 0,
        deliveryCharges: 0,
        refund: 0,
        refundedItems: [],
        totalAmount: 17550,
    },
}

let swrResponse: any = { data: receiptResponse, error: undefined, isLoading: false }

vi.mock("swr", () => ({
    default: () => swrResponse,
}))

vi.mock("@/hooks/use-toast", () => ({
    useToast: () => ({ toast: vi.fn() }),
}))

vi.mock("next/image", () => ({
    default: () => <span data-testid="invoice-logo" />,
}))

import { ReceiptContent } from "@/components/receipts/receipt-content"

function renderInvoice() {
    return render(<ReceiptContent orderId={42} />)
}

describe("invoice header", () => {
    afterEach(() => {
        cleanup()
        swrResponse = { data: receiptResponse, error: undefined, isLoading: false }
    })

    it("prints the issuer identity in the masthead", () => {
        renderInvoice()

        expect(screen.getByText("Apricart E-Stores Private Limited")).toBeTruthy()
        expect(screen.getByText("Plot No. A-504, Sector 6-A,")).toBeTruthy()
        expect(screen.getByText("NTN: A062189-8")).toBeTruthy()
        expect(screen.getByText("STRN: A062189-8")).toBeTruthy()
        expect(screen.getByText("INVOICE")).toBeTruthy()
    })

    it("prints the invoice references, and no purchase order when the buyer gave none", () => {
        const { container } = renderInvoice()
        const references = container.textContent || ""

        expect(references).toContain("Invoice#")
        expect(references).toContain("247/JUL/APR/2026")
        expect(references).toContain("Invoice Date")
        expect(references).toContain("27 Jul 2026")
        expect(references).toContain("P.O.#")
        // The invoice number is never reprinted as the purchase order: that
        // asserted a purchase order the buyer never raised.
        expect(references).not.toContain("247/JUL/APR/2026247/JUL/APR/2026")
    })

    it("prints the buyer's purchase order reference when the order carries one", () => {
        swrResponse = {
            data: {
                ...receiptResponse,
                receiptData: { ...receiptResponse.receiptData, poNumber: "PO-2026-0148" },
            },
            error: undefined,
            isLoading: false,
        }

        const { container } = renderInvoice()

        expect(container.textContent || "").toContain("PO-2026-0148")
    })

    it("keeps the order status, initiator and approver on the invoice", () => {
        const { container } = renderInvoice()
        const header = container.textContent || ""

        expect(header).toContain("Fulfilled")
        expect(header).toContain("Initiator:")
        expect(header).toContain("Rajesh Ramesh")
        expect(header).toContain("Approver:")
        expect(header).toContain("Muhammad Faisal Siddiqui")
    })

    it("lists the initiator and approver after the delivery address", () => {
        const { container } = renderInvoice()
        const header = container.textContent || ""

        expect(header.indexOf("Address:")).toBeLessThan(header.indexOf("Initiator:"))
        expect(header.indexOf("Phone:")).toBeLessThan(header.indexOf("Initiator:"))
        expect(header.indexOf("Initiator:")).toBeLessThan(header.indexOf("Approver:"))
    })

    it("bills the organization and delivers to the branch", () => {
        renderInvoice()

        expect(screen.getByText("Bill To")).toBeTruthy()
        expect(screen.getAllByText("United Bank Limited").length).toBe(2)
        expect(screen.getByText("NTN: 0801164-8")).toBeTruthy()

        expect(screen.getByText("Delivery To")).toBeTruthy()
        expect(screen.getByText("ASU-CPU Central Processing Unit")).toBeTruthy()
    })

    it("keeps the subtotal out of the header when prices are hidden for the role", () => {
        swrResponse = {
            data: { ...receiptResponse, pricesHidden: true },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        expect(container.textContent).not.toContain("Subtotal")
        expect(container.textContent).toContain("Total Items")
    })

    it("falls back to the branch name when an older invoice has no organization recorded", () => {
        const { organizationName, organizationNtn, ...withoutOrganization } = receiptResponse.receiptData
        swrResponse = {
            data: { ...receiptResponse, receiptData: withoutOrganization },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        const billTo = container.querySelector(".invoice-parties")
        expect(within(billTo as HTMLElement).getAllByText("ASU-CPU Central Processing Unit").length).toBe(2)
        expect(container.textContent).not.toContain("NTN: 0801164-8")
    })
})

/**
 * The invoice reproduces the issued paper format, so the column set and the
 * totals block are pinned here: they are the part of this page a reader
 * reconciles against, and a silent change to either is a defect.
 */
describe("invoice line items", () => {
    afterEach(() => {
        swrResponse = { data: receiptResponse, error: undefined, isLoading: false }
    })

    const withTaxedLine = {
        ...receiptResponse,
        receiptData: {
            ...receiptResponse.receiptData,
            subtotal: 14406.75,
            tax: 2593.22,
            totalAmount: 16999.97,
            items: [{
                mainCategoryName: "Pantry",
                subCategories: [{
                    subCategoryName: "Tea",
                    items: [{
                        description: "Tapal Danedar Teabags - 600pcs box",
                        quantity: 5,
                        unit: "pcs",
                        rate: 3400,
                        total: 17000,
                        netRate: 2881.35,
                        netAmount: 14406.75,
                        tax: 2593.22,
                        taxPercent: 18,
                    }],
                }],
            }],
        },
    }

    it("prints the columns of the issued invoice format", () => {
        const { container } = renderInvoice()
        const headers = [...container.querySelectorAll(".items-table thead th")]
            .map((cell) => cell.textContent?.trim())

        expect(headers).toEqual(["#", "Item & Description", "Qty", "Rate", "Tax %", "Tax", "Amount"])
    })

    it("prints tax-exclusive figures for a line, with its unit and rate", () => {
        swrResponse = { data: withTaxedLine, error: undefined, isLoading: false }
        const { container } = renderInvoice()
        const cells = [...container.querySelectorAll(".items-table tbody td")]
            .map((cell) => cell.textContent?.trim())

        expect(cells[0]).toBe("1")
        expect(cells[1]).toBe("Tapal Danedar Teabags - 600pcs box")
        expect(cells[2]).toBe("5.00pcs")
        expect(cells[3]).toBe("2,881.35")
        expect(cells[4]).toBe("18.00")
        expect(cells[5]).toBe("2,593.22")
        expect(cells[6]).toBe("14,406.75")
    })

    it("names the tax row after the rate charged and balances to the total", () => {
        swrResponse = { data: withTaxedLine, error: undefined, isLoading: false }
        const { container } = renderInvoice()
        const summary = container.querySelector(".summary-table")?.textContent ?? ""

        expect(summary).toContain("Sub Total")
        expect(summary).toContain("Standard Rate (18%)")
        expect(summary).toContain("Rounding")
        expect(summary).toContain("14,406.75")
        expect(summary).toContain("2,593.22")
        expect(summary).toContain("16,999.97")
    })

    it("prints one flat numbered list rather than category headings", () => {
        const { container } = renderInvoice()

        expect(container.querySelector(".cat-row")).toBeNull()
        expect(container.querySelector(".subcat-row")).toBeNull()
        expect(container.textContent).not.toContain("Stationery")
    })

    /**
     * An invoice issued before tax was recorded has no net fields. It must keep
     * printing the gross figures it was issued with.
     */
    it("keeps showing the stored figures for an invoice issued before tax existed", () => {
        const { container } = renderInvoice()
        const cells = [...container.querySelectorAll(".items-table tbody td")]
            .map((cell) => cell.textContent?.trim())

        expect(cells[3]).toBe("1,250.00")
        expect(cells[4]).toBe("—")
        expect(cells[6]).toBe("15,000.00")
    })

    it("omits every money column when prices are hidden for the role", () => {
        swrResponse = {
            data: { ...receiptResponse, pricesHidden: true },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()
        const headers = [...container.querySelectorAll(".items-table thead th")]
            .map((cell) => cell.textContent?.trim())

        expect(headers).toEqual(["#", "Item & Description", "Qty"])
        expect(container.querySelector(".summary-table")).toBeNull()
    })
})
