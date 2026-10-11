import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const receiptResponse = {
    pricesHidden: false,
    receiptData: {
        invoiceNumber: "247/JUL/APR/2026",
        orderId: 41288,
        orderTid: "TXN-01J8F4K2QW",
        paymentStatus: "UNPAID",
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
        fulfilledByName: "Sana Iqbal",
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

    it("prints the invoice references", () => {
        const { container } = renderInvoice()
        const references = container.textContent || ""

        expect(references).toContain("Invoice#")
        expect(references).toContain("247/JUL/APR/2026")
        expect(references).toContain("Invoice Date")
        expect(references).toContain("27 Jul 2026")
    })

    it("prints the order reference directly under the invoice date", () => {
        const { container } = renderInvoice()
        const references = container.textContent || ""

        expect(references).toContain("Order ID")
        expect(references).toContain("41288")
        expect(references).not.toContain("TXN-01J8F4K2QW")
        expect(references.indexOf("Invoice Date")).toBeLessThan(references.indexOf("Order ID"))
    })

    it("falls back to the requested order when the snapshot carries no reference", () => {
        const { orderId, ...withoutOrderReference } = receiptResponse.receiptData
        swrResponse = {
            data: { ...receiptResponse, receiptData: withoutOrderReference },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        expect(container.textContent).toContain("Order ID")
        expect(container.textContent).toContain("42")
    })

    /**
     * The purchase order reference is still recorded against the order; it is
     * simply no longer printed. An order that carries one must not leak it back
     * onto the invoice.
     */
    it("prints no purchase order reference, even when the order carries one", () => {
        swrResponse = {
            data: {
                ...receiptResponse,
                receiptData: { ...receiptResponse.receiptData, poNumber: "PO-2026-0148" },
            },
            error: undefined,
            isLoading: false,
        }

        const { container } = renderInvoice()
        const references = container.textContent || ""

        expect(references).not.toContain("P.O.#")
        expect(references).not.toContain("PO-2026-0148")
    })

    it("keeps the order status, initiator, approver and fulfiller on the invoice", () => {
        const { container } = renderInvoice()
        const header = container.textContent || ""

        expect(header).toContain("Fulfilled")
        expect(header).toContain("Initiator:")
        expect(header).toContain("Rajesh Ramesh")
        expect(header).toContain("Approver:")
        expect(header).toContain("Muhammad Faisal Siddiqui")
        expect(header).toContain("Fulfiller:")
        expect(header).toContain("Sana Iqbal")
    })

    it("reports no fulfiller rather than an empty field when the order was fulfilled without one", () => {
        const { fulfilledByName, ...withoutFulfiller } = receiptResponse.receiptData
        swrResponse = {
            data: { ...receiptResponse, receiptData: withoutFulfiller },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()
        const header = container.textContent || ""

        expect(header).toContain("Fulfiller:")
        expect(header).toContain("N/A")
    })

    it("lists the initiator, approver and fulfiller after the delivery address", () => {
        const { container } = renderInvoice()
        const header = container.textContent || ""

        expect(header.indexOf("Address:")).toBeLessThan(header.indexOf("Initiator:"))
        expect(header.indexOf("Phone:")).toBeLessThan(header.indexOf("Initiator:"))
        expect(header.indexOf("Initiator:")).toBeLessThan(header.indexOf("Approver:"))
        expect(header.indexOf("Approver:")).toBeLessThan(header.indexOf("Fulfiller:"))
    })

    it("bills the organization and delivers to the branch", () => {
        renderInvoice()

        expect(screen.getByText("Bill To")).toBeTruthy()
        expect(screen.getAllByText("United Bank Limited")).toHaveLength(2)
        expect(screen.getByText("NTN: 0801164-8")).toBeTruthy()

        expect(screen.getByText("Delivery To")).toBeTruthy()
        expect(screen.getByText("ASU-CPU Central Processing Unit")).toBeTruthy()
    })

    it("keeps the subtotal out of the header, whatever the role may see", () => {
        const priced = renderInvoice()

        expect(priced.container.textContent).not.toContain("Subtotal")
        expect(priced.container.textContent).toContain("Total Items")

        cleanup()
        swrResponse = {
            data: { ...receiptResponse, pricesHidden: true },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        expect(container.textContent).not.toContain("Subtotal")
        expect(container.textContent).toContain("Total Items")
    })

    it("stamps an invoice the order records as settled", () => {
        swrResponse = {
            data: {
                ...receiptResponse,
                receiptData: { ...receiptResponse.receiptData, paymentStatus: "PAID" },
            },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        expect(container.querySelector(".paid-stamp")?.textContent).toBe("PAID")
    })

    it("leaves an unpaid invoice unstamped", () => {
        const { container } = renderInvoice()

        expect(container.querySelector(".paid-stamp")).toBeNull()
    })

    it("treats an unrecognised payment status as unpaid", () => {
        swrResponse = {
            data: {
                ...receiptResponse,
                receiptData: { ...receiptResponse.receiptData, paymentStatus: "SOMETHING_ELSE" },
            },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()

        expect(container.querySelector(".paid-stamp")).toBeNull()
    })

    it("closes with the system-generated note instead of signature blocks", () => {
        const { container } = renderInvoice()
        const note = container.querySelector(".invoice-note")?.textContent || ""

        expect(note).toContain(
            "This is a system-generated invoice and does not require a signature or stamp."
        )
        expect(container.textContent).not.toContain("Authorized Sign")
        expect(container.textContent).not.toContain("Accountant")
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
        expect(within(billTo as HTMLElement).getAllByText("ASU-CPU Central Processing Unit")).toHaveLength(2)
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

    it("prints tax-exclusive figures for a line, without the confusing unit", () => {
        swrResponse = { data: withTaxedLine, error: undefined, isLoading: false }
        const { container } = renderInvoice()
        const cells = [...container.querySelectorAll(".items-table tbody td")]
            .map((cell) => cell.textContent?.trim())

        expect(cells[0]).toBe("1")
        expect(cells[1]).toBe("Tapal Danedar Teabags - 600pcs box")
        expect(cells[2]).toBe("5.00")
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

    /**
     * A long product name is printed in full: the cell wraps it rather than
     * cutting it short, and never widens the table past the money columns.
     */
    it("prints a long product name in full, in a cell that wraps it", () => {
        swrResponse = {
            data: {
                ...receiptResponse,
                receiptData: {
                    ...receiptResponse.receiptData,
                    items: [{
                        mainCategoryName: "Pantry",
                        subCategories: [{
                            subCategoryName: "Tea",
                            items: [{
                                description: "Tapal Danedar Teabags 600pcs Catering Box, Imported Ceylon Blend (PRD-LONG-NAME-0001)",
                                quantity: 1,
                                rate: 100,
                                total: 100,
                            }],
                        }],
                    }],
                },
            },
            error: undefined,
            isLoading: false,
        }
        const { container } = renderInvoice()
        const cell = container.querySelector(".items-table tbody .item-description")

        expect(cell?.textContent).toBe(
            "Tapal Danedar Teabags 600pcs Catering Box, Imported Ceylon Blend (PRD-LONG-NAME-0001)"
        )
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

describe("invoice status, title and customer STRN", () => {
    afterEach(() => {
        cleanup()
        swrResponse = { data: receiptResponse, error: undefined, isLoading: false }
    })

    const withReceipt = (extra: Record<string, unknown>) => {
        swrResponse = {
            data: { ...receiptResponse, receiptData: { ...receiptResponse.receiptData, ...extra } },
            error: undefined,
            isLoading: false,
        }
    }

    it("titles an issued invoice INVOICE and shows its status", () => {
        withReceipt({ invoiceStatus: "ISSUED" })
        renderInvoice()

        expect(screen.getByText("INVOICE")).toBeTruthy()
        expect(screen.getByText("Invoice Status")).toBeTruthy()
        expect(screen.getByText("Issued")).toBeTruthy()
    })

    it("titles an approved, undelivered order PROFORMA INVOICE", () => {
        withReceipt({ invoiceStatus: "PROFORMA_AVAILABLE" })
        renderInvoice()

        expect(screen.getByText("PROFORMA INVOICE")).toBeTruthy()
        expect(screen.queryByText("INVOICE")).toBeNull()
        expect(screen.getByText("Proforma available")).toBeTruthy()
    })

    it("shows no status line when the server sent none", () => {
        renderInvoice()

        expect(screen.queryByText("Invoice Status")).toBeNull()
    })

    it("prints the customer's STRN under Bill To when present", () => {
        withReceipt({ invoiceStatus: "PROFORMA_AVAILABLE", organizationStrn: "3277876123456" })
        renderInvoice()

        expect(screen.getByText("STRN: 3277876123456")).toBeTruthy()
    })
})
