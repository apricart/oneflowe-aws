import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"

import {
  buildConsolidatedInvoiceRows,
  consolidatedInvoiceStatement,
  consolidatedInvoiceTitle,
  consolidatedInvoiceTotals,
  type ConsolidatedInvoiceMode,
  type ConsolidatedInvoiceSource,
} from "@/lib/consolidated-invoice"
import {
  centsToDecimalString,
  consolidatedInvoiceSpreadsheetColumns,
  renderConsolidatedInvoiceCsv,
  renderConsolidatedInvoiceXlsx,
  type ConsolidatedInvoiceSpreadsheetInput,
} from "@/lib/server/consolidated-invoice-spreadsheet"

/**
 * The Excel and CSV downloads are read back and compared with the rows and
 * totals the PDF prints, so the three formats cannot drift apart.
 */
const source = (index: number, overrides: Partial<ConsolidatedInvoiceSource> = {}): ConsolidatedInvoiceSource => ({
  orderId: 1777 + index,
  invoiceNumber: `UBL-APR-${String(29 + index).padStart(6, "0")}`,
  date: "2026-08-24",
  orderStatus: "FULFILLED",
  refundAmountCents: null,
  invoiceStatus: "ISSUED",
  paymentStatus: index === 1 ? "PAID" : "UNPAID",
  department: "Facility Management",
  approver: "Syed Amir Ali Waris",
  approvalLevel: index === 1 ? 1 : null,
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
  ...overrides,
})

function input(
  sources: ConsolidatedInvoiceSource[],
  mode: ConsolidatedInvoiceMode = "invoices",
  filterNote: string | null = null,
): ConsolidatedInvoiceSpreadsheetInput {
  const rows = buildConsolidatedInvoiceRows(mode, sources, null)
  return {
    mode,
    title: consolidatedInvoiceTitle(mode),
    statement: consolidatedInvoiceStatement(mode),
    footnote: null,
    filterNote,
    billTo: { name: "UBL", ntn: "0801164-8", strn: "3277876123456" },
    periodLabel: "24 Aug 2026 – 02 Sep 2026",
    rows,
    totals: consolidatedInvoiceTotals(rows),
    generatedAt: new Date("2026-10-11T07:00:00Z"),
  }
}

function parseCsv(text: string): string[][] {
  return text.replace(/^\uFEFF/, "").trimEnd().split("\r\n").map((line) =>
    [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replace(/""/g, '"')),
  )
}

function readSheet(bytes: Uint8Array): unknown[][] {
  const workbook = XLSX.read(bytes, { type: "array" })
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: true, defval: "" })
}

describe("centsToDecimalString", () => {
  it("writes integer cents exactly, without grouping", () => {
    expect(centsToDecimalString(4_081_500)).toBe("40815.00")
    expect(centsToDecimalString(5)).toBe("0.05")
    expect(centsToDecimalString(0)).toBe("0.00")
    expect(centsToDecimalString(-1_234)).toBe("-12.34")
    expect(centsToDecimalString(Number.NaN)).toBe("0.00")
  })
})

describe("the columns", () => {
  it("puts the approver level right after the approver", () => {
    const columns = consolidatedInvoiceSpreadsheetColumns("invoices")
    expect(columns[columns.indexOf("Approver") + 1]).toBe("Approver Level")
  })

  it("carries payment and invoice status for invoices, not for proformas", () => {
    expect(consolidatedInvoiceSpreadsheetColumns("invoices")).toEqual(expect.arrayContaining(["Payment Status", "Invoice Status"]))
    expect(consolidatedInvoiceSpreadsheetColumns("proformas")).not.toContain("Payment Status")
    expect(consolidatedInvoiceSpreadsheetColumns("proformas")).not.toContain("Invoice Status")
  })
})

describe("the CSV", () => {
  it("is one header, one line per invoice and the Total line, with plain decimal money", () => {
    const csv = renderConsolidatedInvoiceCsv(input([source(1), source(2)]))
    expect(csv.startsWith("\uFEFF")).toBe(true)
    const [header, first, second, total, ...rest] = parseCsv(csv)
    expect(rest).toEqual([])
    expect(header).toEqual(consolidatedInvoiceSpreadsheetColumns("invoices"))
    const at = (row: string[], title: string) => row[header.indexOf(title)]
    expect(at(first, "Invoice No")).toBe("UBL-APR-000030")
    expect(at(first, "Approver")).toBe("Syed Amir Ali Waris")
    expect(at(first, "Approver Level")).toBe("Level 1")
    expect(at(second, "Approver Level")).toBe("")
    expect(at(first, "Payment Status")).toBe("Paid")
    expect(at(second, "Payment Status")).toBe("Unpaid")
    expect(at(first, "Invoice Status")).toBe("Issued")
    expect(at(first, "Total Amount")).toBe("40815.00")
    expect(at(total, "S. No")).toBe("Total")
    expect(at(total, "Total Amount")).toBe("81630.00")
    expect(at(total, "Value Excl. Sales Tax")).toBe("69178.00")
    expect(at(total, "Items (Qty)")).toBe("106")
  })

  it("neutralises formula-like text a tenant typed", () => {
    const csv = renderConsolidatedInvoiceCsv(input([source(1, { department: "=HYPERLINK(\"http://x\")", approver: "@SUM(1)" })]))
    const [header, row] = parseCsv(csv)
    expect(row[header.indexOf("Department")]).toBe("'=HYPERLINK(\"http://x\")")
    expect(row[header.indexOf("Approver")]).toBe("'@SUM(1)")
  })

  it("prints only the header and a zero Total for an empty report", () => {
    const [header, total, ...rest] = parseCsv(renderConsolidatedInvoiceCsv(input([])))
    expect(header[0]).toBe("S. No")
    expect(total[0]).toBe("Total")
    expect(total[header.indexOf("Total Amount")]).toBe("0.00")
    expect(rest).toEqual([])
  })
})

describe("the workbook", () => {
  it("heads the sheet as the PDF does, then lists the rows and totals as numbers", () => {
    const sheet = readSheet(renderConsolidatedInvoiceXlsx(input([source(1), source(2)], "invoices", "Unpaid invoices only")))
    expect(sheet[0][0]).toBe("CONSOLIDATED INVOICE")
    const label = (name: string) => sheet.find((row) => row[0] === name)?.[1]
    expect(label("Bill To")).toBe("UBL")
    expect(label("NTN")).toBe("0801164-8")
    expect(label("STRN")).toBe("3277876123456")
    expect(label("Invoice Period")).toBe("24 Aug 2026 – 02 Sep 2026")
    expect(label("Filter")).toBe("Unpaid invoices only")
    expect(label("Total Orders")).toBe(2)
    expect(label("Grand Total (PKR)")).toBe(81_630)

    const headerIndex = sheet.findIndex((row) => row[0] === "S. No")
    const header = sheet[headerIndex] as string[]
    expect(header).toEqual(consolidatedInvoiceSpreadsheetColumns("invoices"))
    const at = (row: unknown[], title: string) => row[header.indexOf(title)]
    const [first, second, total] = sheet.slice(headerIndex + 1, headerIndex + 4)
    expect(at(first, "Approver Level")).toBe("Level 1")
    expect(at(second, "Approver Level")).toBe("")
    expect(at(first, "Total Amount")).toBe(40_815)
    expect(at(first, "Sales Tax Amount")).toBe(6_226)
    expect(at(total, "S. No")).toBe("Total")
    expect(at(total, "Total Amount")).toBe(81_630)
    expect(sheet.some((row) => String(row[0]).includes("Not a separate tax invoice"))).toBe(true)
  })

  it("formats money to two places", () => {
    const workbook = XLSX.read(renderConsolidatedInvoiceXlsx(input([source(1)])), { type: "array", cellNF: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true, defval: "" })
    const headerIndex = rows.findIndex((row) => row[0] === "S. No")
    const column = (rows[headerIndex] as string[]).indexOf("Total Amount")
    expect(sheet[XLSX.utils.encode_cell({ r: headerIndex + 1, c: column })]?.z).toBe("#,##0.00")
  })

  it("names a proforma sheet as one and leaves out the status columns", () => {
    const bytes = renderConsolidatedInvoiceXlsx(input([source(1)], "proformas"))
    expect(XLSX.read(bytes, { type: "array" }).SheetNames).toEqual(["Consolidated Proforma"])
    const sheet = readSheet(bytes)
    expect(sheet[0][0]).toBe("CONSOLIDATED PROFORMA")
    expect(sheet.find((row) => row[0] === "S. No")).not.toContain("Payment Status")
  })

  it("neutralises formula-like text a tenant typed", () => {
    const sheet = readSheet(renderConsolidatedInvoiceXlsx(input([source(1, { costCenterId: "+CMD" })])))
    const headerIndex = sheet.findIndex((row) => row[0] === "S. No")
    const header = sheet[headerIndex] as string[]
    expect(sheet[headerIndex + 1][header.indexOf("CRC")]).toBe("'+CMD")
  })
})
