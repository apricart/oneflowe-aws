// @vitest-environment node
import { describe, expect, it } from "vitest"

import {
  buildConsolidatedInvoiceRows,
  consolidatedInvoiceStatement,
  consolidatedInvoiceTitle,
  consolidatedInvoiceTotals,
  type ConsolidatedInvoiceSource,
} from "@/lib/consolidated-invoice"
import { renderConsolidatedInvoicePdf } from "@/lib/server/consolidated-invoice-pdf"

/**
 * The consolidated PDF is asserted on its own bytes, as the invoice PDF is:
 * jsPDF writes its content streams uncompressed, so every printed string can be
 * found in them.
 */
const source = (index: number): ConsolidatedInvoiceSource => ({
  orderId: 1777 + index,
  invoiceNumber: `UBL-APR-${String(29 + index).padStart(6, "0")}`,
  date: "2026-08-24",
  orderStatus: "FULFILLED",
  refundAmountCents: null,
  invoiceStatus: "ISSUED",
  paymentStatus: "UNPAID",
  department: "Facility Management",
  approver: "Syed Amir Ali Waris",
  costCenterId: "CC-77",
  quantity: 53,
  creditedQuantity: 0,
  taxRatesBp: [1_800],
  netCents: 3_458_900,
  taxCents: 622_600,
  totalCents: 4_081_500,
  creditedNetCents: 0,
  creditedTaxCents: 0,
  creditedTotalCents: 0,
})

function render(count: number, mode: "invoices" | "proformas" = "invoices", footnote: string | null = null, filterNote: string | null = null) {
  const rows = buildConsolidatedInvoiceRows(mode, Array.from({ length: count }, (_, index) => source(index + 1)), null)
  const pdf = renderConsolidatedInvoicePdf({
    title: consolidatedInvoiceTitle(mode),
    statement: consolidatedInvoiceStatement(mode),
    footnote,
    filterNote,
    billTo: { name: "UBL", ntn: "0801164-8", strn: "3277876123456" },
    periodLabel: "24 Aug 2026 – 02 Sep 2026",
    rows,
    totals: consolidatedInvoiceTotals(rows),
    generatedAt: new Date("2026-10-11T07:00:00Z"),
  })
  return Buffer.from(pdf).toString("latin1")
}

describe("the consolidated invoice PDF", () => {
  it("prints the template's header cards and bands", () => {
    const text = render(3)
    expect(text).toContain("CONSOLIDATED INVOICE")
    expect(text).toContain("BILL TO")
    expect(text).toContain("NTN: 0801164-8")
    expect(text).toContain("STRN: 3277876123456")
    expect(text).toContain("24 Aug 2026")
    expect(text).toContain("PKR 122,445.00")
    expect(text).toContain("Apricart Details")
    expect(text).toContain("UBL Details")
    // A long column title wraps inside its cell, so its first line is matched.
    expect(text).toContain("Value Excl. Sales")
    expect(text).toContain("Total Amount")
  })

  it("prints every invoice number, its figures and the totals row", () => {
    const text = render(3)
    for (const number of ["UBL-APR-000030", "UBL-APR-000031", "UBL-APR-000032"]) expect(text).toContain(number)
    expect(text).toContain("40,815.00")
    expect(text).toContain("18%")
    expect(text).toContain("(Total)")
    expect(text).toContain("103,767.00")
  })

  it("numbers its pages and says what it is on each", () => {
    const text = render(3)
    expect(text).toContain("Page 1 of 1")
    expect(text).toContain("Not a separate tax invoice")
    expect(text).toContain("Generated on 11 Oct 2026")
  })

  it("runs onto further pages, repeating the header and printing the totals once", () => {
    const text = render(60)
    expect(text).toMatch(/Page 3 of 3|Page 4 of 4|Page 2 of 2/)
    const pages = Number(/Page \d+ of (\d+)/.exec(text)?.[1])
    expect(pages).toBeGreaterThan(1)
    expect(text.split("Apricart Details").length - 1).toBe(pages)
    expect(text.split("(Total)").length - 1).toBe(1)
  })

  it("titles a proforma report as one, and prints its own statement", () => {
    const text = render(2, "proformas")
    expect(text).toContain("CONSOLIDATED PROFORMA")
    expect(text).toContain("no tax invoice has been issued")
    // jsPDF escapes parentheses in text: "(when processed)" is written \(when processed\).
    expect(text).toContain("\\(when processed\\)")
  })

  it("prints the legacy-date footnote only when given one", () => {
    expect(render(1, "invoices", "Invoices dated before 11 Oct 2026 carry their order date")).toContain("carry their order date")
    expect(render(1)).not.toContain("carry their order date")
  })

  it("says beside the period when a payment-status filter narrowed it", () => {
    expect(render(1, "invoices", null, "Unpaid invoices only")).toContain("Unpaid invoices only")
    expect(render(1)).not.toContain("invoices only")
  })
})
