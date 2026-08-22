import { describe, expect, it } from "vitest"
import { formatInvoiceDisplayDate, getInvoicePoNumber } from "@/lib/invoice-format"

describe("formatInvoiceDisplayDate", () => {
    it("renders a stored MM/DD/YYYY snapshot in invoice style", () => {
        expect(formatInvoiceDisplayDate("07/27/2026")).toBe("27 Jul 2026")
    })

    it("keeps the day and month in the right order for an ambiguous date", () => {
        expect(formatInvoiceDisplayDate("01/02/2026")).toBe("02 Jan 2026")
    })

    it("accepts an unpadded stored date", () => {
        expect(formatInvoiceDisplayDate("7/4/2026")).toBe("04 Jul 2026")
    })

    it("accepts an ISO date", () => {
        expect(formatInvoiceDisplayDate("2026-07-27T10:00:00.000Z")).toBe("27 Jul 2026")
    })

    it("returns an unrecognised legacy value untouched", () => {
        expect(formatInvoiceDisplayDate("27 July 2026")).toBe("27 July 2026")
    })

    it.each([[null], [undefined], [""], ["   "]])("returns an empty string for %s", (value) => {
        expect(formatInvoiceDisplayDate(value)).toBe("")
    })
})

describe("getInvoicePoNumber", () => {
    it("prints the buyer's purchase order reference", () => {
        expect(getInvoicePoNumber({ poNumber: "PO-99" })).toBe("PO-99")
        expect(getInvoicePoNumber({ poNumber: "  PO-99  " })).toBe("PO-99")
    })

    it("never falls back to the invoice number", () => {
        expect(getInvoicePoNumber({ invoiceNumber: "247/JUL/APR/2026" } as { poNumber?: unknown })).toBe("N/A")
        expect(getInvoicePoNumber({ poNumber: "   " })).toBe("N/A")
    })

    it("reports a missing reference instead of printing an empty field", () => {
        expect(getInvoicePoNumber(null)).toBe("N/A")
        expect(getInvoicePoNumber({})).toBe("N/A")
    })
})
