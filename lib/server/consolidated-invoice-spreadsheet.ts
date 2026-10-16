/**
 * The consolidated invoice report as a spreadsheet — Excel (.xlsx) or CSV
 * (plans/OF-INVOICE-consolidated-invoices.md, "Spreadsheet downloads").
 *
 * Built from the very rows and totals the PDF prints (`lib/consolidated-invoice`),
 * so the three downloads cannot disagree. Two columns the PDF folds into the
 * Order Status cell on screen — Payment Status and Invoice Status — get their
 * own columns here, because a spreadsheet is filtered by column. Every text
 * cell passes through `neutralizeSpreadsheetFormula`: department, approver and
 * CRC are typed by tenants.
 */
import * as XLSX from "xlsx"

import {
  type ConsolidatedInvoiceMode,
  type ConsolidatedInvoiceRow,
  type ConsolidatedInvoiceTotals,
} from "@/lib/consolidated-invoice"
import { INVOICE_STATUS_LABELS } from "@/lib/invoice-status"
import { PAYMENT_STATUS_LABELS } from "@/lib/payment-status"
import { createCsv, neutralizeSpreadsheetFormula } from "@/lib/spreadsheet"

export type ConsolidatedInvoiceSpreadsheetInput = {
  mode: ConsolidatedInvoiceMode
  title: string
  statement: string
  footnote: string | null
  filterNote: string | null
  billTo: { name: string; ntn: string | null; strn: string | null }
  periodLabel: string
  rows: ConsolidatedInvoiceRow[]
  totals: ConsolidatedInvoiceTotals
  generatedAt: Date
}

type CellKind = "text" | "integer" | "quantity" | "money"

type Column = {
  title: string
  kind: CellKind
  /** Text for a text column, a number (cents for money) for the others. */
  value: (row: ConsolidatedInvoiceRow) => string | number
  /** What the Total row carries in this column, if anything. */
  total?: (totals: ConsolidatedInvoiceTotals) => number
  width: number
  invoicesOnly?: boolean
}

const COLUMNS: Column[] = [
  { title: "S. No", kind: "integer", value: (row) => row.serial, width: 7 },
  { title: "Invoice No", kind: "text", value: (row) => row.invoiceNumber, width: 22 },
  { title: "Invoice Date", kind: "text", value: (row) => row.invoiceDate, width: 13 },
  { title: "Order ID", kind: "integer", value: (row) => row.orderId, width: 10 },
  { title: "Order Status", kind: "text", value: (row) => row.orderStatus, width: 16 },
  { title: "Payment Status", kind: "text", value: (row) => PAYMENT_STATUS_LABELS[row.paymentStatus], width: 14, invoicesOnly: true },
  { title: "Invoice Status", kind: "text", value: (row) => (row.invoiceStatus ? INVOICE_STATUS_LABELS[row.invoiceStatus] : ""), width: 18, invoicesOnly: true },
  { title: "Department", kind: "text", value: (row) => row.department, width: 28 },
  { title: "Approver", kind: "text", value: (row) => row.approver, width: 24 },
  { title: "Approver Level", kind: "text", value: (row) => row.approverLevel, width: 14 },
  { title: "Designation", kind: "text", value: (row) => row.designation, width: 16 },
  { title: "CRC", kind: "text", value: (row) => row.crc, width: 14 },
  { title: "Items (Qty)", kind: "quantity", value: (row) => row.quantity, total: (totals) => totals.quantity, width: 12 },
  { title: "Value Excl. Sales Tax", kind: "money", value: (row) => row.valueExclTaxCents, total: (totals) => totals.valueExclTaxCents, width: 20 },
  { title: "Sales Tax %", kind: "text", value: (row) => row.taxRateLabel, width: 12 },
  { title: "Sales Tax Amount", kind: "money", value: (row) => row.taxCents, total: (totals) => totals.taxCents, width: 18 },
  { title: "Total Amount", kind: "money", value: (row) => row.totalCents, total: (totals) => totals.totalCents, width: 18 },
]

/** The columns this report carries: proformas are never paid and are all proformas, so they drop the two status columns. */
export function consolidatedInvoiceSpreadsheetColumns(mode: ConsolidatedInvoiceMode): string[] {
  return columnsFor(mode).map((column) => column.title)
}

function columnsFor(mode: ConsolidatedInvoiceMode): Column[] {
  return COLUMNS.filter((column) => mode === "invoices" || !column.invoicesOnly)
}

/** Integer cents as a plain decimal, exactly: 123450 → "1234.50". No float arithmetic, no grouping. */
export function centsToDecimalString(valueCents: number): string {
  const rounded = Math.round(Number(valueCents))
  if (!Number.isFinite(rounded)) return "0.00"
  const sign = rounded < 0 ? "-" : ""
  const abs = Math.abs(rounded)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}

const GENERATED_AT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

const MONEY_FORMAT = "#,##0.00"
const QUANTITY_FORMAT = "#,##0.###"

/**
 * The CSV: one header row, one row per invoice, and the Total row — nothing
 * above the header, so it opens as a table in any tool. Money is a plain
 * decimal in PKR. A byte-order mark makes Excel read it as UTF-8.
 */
export function renderConsolidatedInvoiceCsv(input: ConsolidatedInvoiceSpreadsheetInput): string {
  const columns = columnsFor(input.mode)
  const cell = (column: Column, value: string | number): string | number => {
    if (column.kind === "money") return centsToDecimalString(Number(value))
    return value
  }
  const body = input.rows.map((row) => columns.map((column) => cell(column, column.value(row))))
  const totalRow = columns.map((column, index) => {
    if (index === 0) return "Total"
    return column.total ? cell(column, column.total(input.totals)) : ""
  })
  return `\uFEFF${createCsv(columns.map((column) => column.title), [...body, totalRow])}\r\n`
}

/**
 * The workbook: the document's header (bill-to, period, filter, totals) above
 * the table, the Total row under it, and the statement and footnote last, as
 * the PDF prints them. Money cells are numbers in PKR formatted to two places,
 * so the sheet adds up; the header's Grand Total is the same figure.
 */
export function renderConsolidatedInvoiceXlsx(input: ConsolidatedInvoiceSpreadsheetInput): Uint8Array {
  const columns = columnsFor(input.mode)
  const text = (value: string) => neutralizeSpreadsheetFormula(value)
  const pkr = (valueCents: number) => Number(centsToDecimalString(valueCents))

  const preamble: (string | number)[][] = [
    [input.title],
    ["Bill To", text(input.billTo.name)],
    ...(input.billTo.ntn ? [["NTN", text(input.billTo.ntn)]] : []),
    ...(input.billTo.strn ? [["STRN", text(input.billTo.strn)]] : []),
    ["Invoice Period", input.periodLabel],
    ...(input.filterNote ? [["Filter", input.filterNote]] : []),
    ["Total Orders", input.totals.orders],
    ["Total Items", input.totals.quantity],
    ["Grand Total (PKR)", pkr(input.totals.totalCents)],
    ["Generated", `${GENERATED_AT.format(input.generatedAt)} (Karachi)`],
    [],
  ]
  const headerRowIndex = preamble.length
  const body = input.rows.map((row) => columns.map((column) => {
    const value = column.value(row)
    if (column.kind === "money") return pkr(Number(value))
    return typeof value === "string" ? text(value) : value
  }))
  const totalRow = columns.map((column, index) => {
    if (index === 0) return "Total"
    if (!column.total) return ""
    const value = column.total(input.totals)
    return column.kind === "money" ? pkr(value) : value
  })
  const notes = [[], ...(input.footnote ? [[input.footnote]] : []), [input.statement]]

  const sheet = XLSX.utils.aoa_to_sheet([
    ...preamble,
    columns.map((column) => column.title),
    ...body,
    totalRow,
    ...notes,
  ])

  // Number formats: the money and quantity columns of every body row and the Total row.
  const firstDataRow = headerRowIndex + 1
  const lastDataRow = headerRowIndex + body.length + 1
  columns.forEach((column, columnIndex) => {
    if (column.kind !== "money" && column.kind !== "quantity") return
    for (let rowIndex = firstDataRow; rowIndex <= lastDataRow; rowIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] as XLSX.CellObject | undefined
      if (cell && cell.t === "n") cell.z = column.kind === "money" ? MONEY_FORMAT : QUANTITY_FORMAT
    }
  })
  const grandTotalCell = sheet[XLSX.utils.encode_cell({ r: preamble.findIndex((row) => row[0] === "Grand Total (PKR)"), c: 1 })] as XLSX.CellObject | undefined
  if (grandTotalCell) grandTotalCell.z = MONEY_FORMAT
  sheet["!cols"] = columns.map((column) => ({ wch: column.width }))
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({ s: { r: headerRowIndex, c: 0 }, e: { r: headerRowIndex + body.length, c: columns.length - 1 } }),
  }

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, input.mode === "invoices" ? "Consolidated Invoice" : "Consolidated Proforma")
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer)
}
