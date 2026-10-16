/**
 * The consolidated invoice PDF, in the supplied template
 * (`Group Invoice_Consolidation.pdf`; plans/OF-INVOICE-consolidated-invoices.md, D7).
 *
 * Kept out of the route so the printed document can be asserted on directly:
 * the route decides who may download a report, this module decides what the
 * page says. Rows and totals come from `lib/consolidated-invoice`, the same
 * module the on-screen preview renders, so the two cannot disagree.
 */
import { jsPDF } from "jspdf"
import autoTable from "jspdf-autotable"

import {
  formatReportMoney,
  formatReportQuantity,
  type ConsolidatedInvoiceRow,
  type ConsolidatedInvoiceTotals,
} from "@/lib/consolidated-invoice"
import { INVOICE_ISSUER } from "@/lib/invoice-issuer"
import { apricartLogoDataUrl } from "@/lib/server/pdf-logo"

type Rgb = [number, number, number]

const COLORS = {
  navy: [16, 30, 64] as Rgb,
  gold: [184, 148, 31] as Rgb,
  text: [15, 23, 42] as Rgb,
  muted: [100, 116, 139] as Rgb,
  title: [71, 85, 105] as Rgb,
  border: [203, 213, 225] as Rgb,
  card: [248, 250, 252] as Rgb,
  zebra: [241, 245, 249] as Rgb,
  white: [255, 255, 255] as Rgb,
}

const PAGE = { width: 297, height: 210, margin: 12 }

export type ConsolidatedInvoicePdfInput = {
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

const GENERATED_AT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
})

function drawMasthead(doc: jsPDF, title: string) {
  const { margin, width } = PAGE
  const logo = apricartLogoDataUrl()
  if (logo) {
    doc.addImage(logo, "PNG", margin, 10, 38, 11, undefined, "FAST")
  } else {
    doc.setFont("helvetica", "bold").setFontSize(15).setTextColor(...COLORS.navy)
    doc.text("APRICART", margin, 18)
  }

  const textX = margin + 44
  doc.setFont("helvetica", "bold").setFontSize(11).setTextColor(...COLORS.text)
  doc.text(INVOICE_ISSUER.name, textX, 13)
  doc.setFont("helvetica", "normal").setFontSize(7.5).setTextColor(...COLORS.muted)
  doc.text(INVOICE_ISSUER.addressLines.join(" "), textX, 17.5)
  doc.text(`NTN: ${INVOICE_ISSUER.ntn}    STRN: ${INVOICE_ISSUER.strn}`, textX, 21.5)

  doc.setFont("helvetica", "normal").setFontSize(19).setTextColor(...COLORS.title)
  doc.text(title, width - margin, 19, { align: "right" })
}

function drawCard(doc: jsPDF, x: number, y: number, width: number, height: number, lines: Array<{ text: string; size: number; bold?: boolean; color?: Rgb }>) {
  doc.setFillColor(...COLORS.card).setDrawColor(...COLORS.border).setLineWidth(0.2)
  doc.rect(x, y, width, height, "FD")
  let cursor = y + 4.6
  for (const line of lines) {
    doc.setFont("helvetica", line.bold ? "bold" : "normal").setFontSize(line.size).setTextColor(...(line.color ?? COLORS.text))
    const wrapped = doc.splitTextToSize(line.text, width - 6) as string[]
    doc.text(wrapped[0] ?? "", x + 3, cursor)
    cursor += line.size * 0.42 + 1.4
  }
}

function drawHeaderCards(doc: jsPDF, input: ConsolidatedInvoicePdfInput): number {
  const { margin, width } = PAGE
  const y = 27
  const height = 19
  const usable = width - margin * 2
  const widths = [usable * 0.28, usable * 0.24, usable * 0.2, usable * 0.28]
  const xs = widths.reduce<number[]>((acc, _, index) => [...acc, index === 0 ? margin : acc[index - 1] + widths[index - 1]], [])

  const taxIds = [input.billTo.ntn ? `NTN: ${input.billTo.ntn}` : null, input.billTo.strn ? `STRN: ${input.billTo.strn}` : null]
    .filter(Boolean).join("    ")
  drawCard(doc, xs[0], y, widths[0], height, [
    { text: "BILL TO", size: 7, color: COLORS.muted },
    { text: input.billTo.name, size: 10.5, bold: true },
    ...(taxIds ? [{ text: taxIds, size: 7, color: COLORS.muted }] : []),
  ])
  drawCard(doc, xs[1], y, widths[1], height, [
    { text: "Invoice Period", size: 7, color: COLORS.muted },
    { text: input.periodLabel, size: 9, bold: true },
    ...(input.filterNote ? [{ text: input.filterNote, size: 7, color: COLORS.muted }] : []),
  ])
  drawCard(doc, xs[2], y, widths[2], height, [
    { text: "Total Orders", size: 7, color: COLORS.muted },
    { text: String(input.totals.orders), size: 10.5, bold: true },
    { text: `Total Items: ${formatReportQuantity(input.totals.quantity)}`, size: 7, color: COLORS.muted },
  ])
  drawCard(doc, xs[3], y, widths[3], height, [
    { text: "Grand Total", size: 7, color: COLORS.muted },
    { text: `PKR ${formatReportMoney(input.totals.totalCents)}`, size: 10.5, bold: true },
    { text: `Excl. tax ${formatReportMoney(input.totals.valueExclTaxCents)} + tax ${formatReportMoney(input.totals.taxCents)}`, size: 7, color: COLORS.muted },
  ])
  return y + height + 5
}

const COLUMN_TITLES = [
  "S. No", "Invoice No", "Invoice Date", "Order ID", "Order Status", "Department", "Approver", "Approver Level",
  "Designation", "CRC", "Items (Qty)", "Value Excl. Sales Tax", "Sales Tax %", "Sales Tax Amount", "Total Amount",
]

/** Column widths in mm across the 273 mm of a landscape page inside its margins. */
const COLUMN_WIDTHS = [11, 23, 18, 14, 18, 26, 26, 14, 18, 14, 13, 23, 13, 18, 24]
const NUMERIC_COLUMNS = new Set([10, 11, 12, 13, 14])
const CENTERED_COLUMNS = new Set([0, 3, 7])

export function renderConsolidatedInvoicePdf(input: ConsolidatedInvoicePdfInput): ArrayBuffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" })
  const { margin, height } = PAGE

  drawMasthead(doc, input.title)
  const startY = drawHeaderCards(doc, input)

  const columnStyles = Object.fromEntries(COLUMN_WIDTHS.map((width, index) => [index, {
    cellWidth: width,
    halign: NUMERIC_COLUMNS.has(index) ? "right" : CENTERED_COLUMNS.has(index) ? "center" : "left",
  }]))

  autoTable(doc, {
    startY,
    margin: { left: margin, right: margin, top: 14, bottom: 20 },
    theme: "grid",
    showHead: "everyPage",
    showFoot: "lastPage",
    styles: { font: "helvetica", fontSize: 7, cellPadding: 1.6, textColor: COLORS.text, lineColor: COLORS.border, lineWidth: 0.15, valign: "middle", overflow: "linebreak" },
    headStyles: { fillColor: COLORS.navy, textColor: COLORS.white, fontStyle: "bold", halign: "center" },
    footStyles: { fillColor: COLORS.zebra, textColor: COLORS.text, fontStyle: "bold" },
    alternateRowStyles: { fillColor: COLORS.card },
    columnStyles: columnStyles as never,
    head: [
      [
        { content: "", styles: { fillColor: COLORS.white, lineWidth: 0 } },
        { content: "Apricart Details", colSpan: 2, styles: { fillColor: COLORS.gold } },
        { content: `${input.billTo.name} Details`, colSpan: 12, styles: { fillColor: COLORS.navy } },
      ],
      COLUMN_TITLES,
    ],
    body: input.rows.map((row) => [
      String(row.serial),
      row.invoiceNumber,
      row.invoiceDate,
      String(row.orderId),
      row.orderStatus,
      row.department,
      row.approver,
      row.approverLevel,
      row.designation,
      row.crc,
      formatReportQuantity(row.quantity),
      formatReportMoney(row.valueExclTaxCents),
      row.taxRateLabel,
      formatReportMoney(row.taxCents),
      formatReportMoney(row.totalCents),
    ]),
    foot: [[
      { content: "Total", colSpan: 10, styles: { halign: "left" } },
      { content: formatReportQuantity(input.totals.quantity), styles: { halign: "right" } },
      { content: formatReportMoney(input.totals.valueExclTaxCents), styles: { halign: "right" } },
      { content: "", styles: { halign: "right" } },
      { content: formatReportMoney(input.totals.taxCents), styles: { halign: "right" } },
      { content: formatReportMoney(input.totals.totalCents), styles: { halign: "right" } },
    ]],
  })

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? startY
  if (input.footnote) {
    doc.setFont("helvetica", "italic").setFontSize(7).setTextColor(...COLORS.muted)
    doc.text(input.footnote, margin, Math.min(finalY + 6, height - 22))
  }

  // Footer on every page, once the page count is known.
  const pages = doc.getNumberOfPages()
  const generated = `Generated on ${GENERATED_AT.format(input.generatedAt)} (Karachi)`
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    doc.setDrawColor(...COLORS.border).setLineWidth(0.2)
    doc.line(margin, height - 15, PAGE.width - margin, height - 15)
    doc.setFont("helvetica", "normal").setFontSize(7).setTextColor(...COLORS.muted)
    doc.text(input.statement, margin, height - 10)
    doc.text(generated, margin, height - 6)
    doc.text(`Page ${page} of ${pages}`, PAGE.width - margin, height - 10, { align: "right" })
  }

  return doc.output("arraybuffer")
}
