"use client"

import Image from "next/image"
import Link from "next/link"

import { InvoiceStatusBadge } from "@/components/orders/invoice-status-badge"
import { SortableHeader, ariaSortFor } from "@/components/reports/sortable-header"
import {
  formatReportMoney,
  formatReportQuantity,
  type ConsolidatedInvoiceRow,
  type ConsolidatedInvoiceTotals,
} from "@/lib/consolidated-invoice"
import { INVOICE_ISSUER } from "@/lib/invoice-issuer"
import { PAYMENT_STATUS_LABELS } from "@/lib/payment-status"
import type { ConsolidatedInvoiceSortKey } from "@/lib/list-sort-keys"
import type { SortDirection, SortState } from "@/lib/table-sort"
import { cn } from "@/lib/utils"

export type ConsolidatedInvoiceResponse = {
  mode: "invoices" | "proformas"
  title: string
  statement: string
  footnote: string | null
  filterNote: string | null
  billTo: { name: string; code: string | null; ntn: string | null; strn: string | null }
  period: { from: string; to: string; label: string }
  rows: ConsolidatedInvoiceRow[]
  totals: ConsolidatedInvoiceTotals
  count: number
}

type Column = {
  key: ConsolidatedInvoiceSortKey | null
  label: string
  align?: "right" | "center"
  firstDirection?: SortDirection
}

/** The template's columns, in order. S. No and Designation do not sort. */
const COLUMNS: Column[] = [
  { key: null, label: "S. No", align: "center" },
  { key: "invoiceNumber", label: "Invoice No" },
  { key: "invoiceDate", label: "Invoice Date", firstDirection: "desc" },
  { key: "orderId", label: "Order ID", align: "center", firstDirection: "desc" },
  { key: "orderStatus", label: "Order Status" },
  { key: "department", label: "Department" },
  { key: "approver", label: "Approver" },
  { key: null, label: "Designation" },
  { key: "crc", label: "CRC" },
  { key: "quantity", label: "Items (Qty)", align: "right", firstDirection: "desc" },
  { key: "valueExclTax", label: "Value Excl. Sales Tax", align: "right", firstDirection: "desc" },
  { key: "taxRate", label: "Sales Tax %", align: "right", firstDirection: "desc" },
  { key: "tax", label: "Sales Tax Amount", align: "right", firstDirection: "desc" },
  { key: "total", label: "Total Amount", align: "right", firstDirection: "desc" },
]

const HEAD_CELL = "border border-slate-700/40 px-2 py-2 text-[11px] font-bold leading-tight text-white"
const ALIGN = { right: "text-right", center: "text-center" } as const

function HeaderCard({ label, value, detail, className }: Readonly<{ label: string; value: string; detail?: string | null; className?: string }>) {
  return (
    <div className={cn("min-w-0 border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40", className)}>
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="truncate text-sm font-bold text-slate-900 dark:text-slate-100" title={value}>{value}</p>
      {detail ? <p className="truncate text-[11px] text-slate-500" title={detail}>{detail}</p> : null}
    </div>
  )
}

/**
 * The report as the PDF prints it: masthead, the four header cards, the
 * two-band column header, the rows and the Total row. Sorting re-asks the
 * server, so the download prints in the same order.
 */
export function ConsolidatedInvoiceDocument({
  report,
  sort,
  onSort,
}: Readonly<{
  report: ConsolidatedInvoiceResponse
  sort: SortState<ConsolidatedInvoiceSortKey>
  onSort: (key: ConsolidatedInvoiceSortKey, firstDirection?: SortDirection) => void
}>) {
  const taxIds = [report.billTo.ntn ? `NTN: ${report.billTo.ntn}` : null, report.billTo.strn ? `STRN: ${report.billTo.strn}` : null]
    .filter(Boolean).join("   ")

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4">
        <div className="flex items-start gap-4">
          <Image src="/apricart-logo-blue.png" alt={INVOICE_ISSUER.name} width={140} height={40} className="shrink-0 object-contain" />
          <div>
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">{INVOICE_ISSUER.name}</p>
            <p className="text-[11px] text-slate-500">{INVOICE_ISSUER.addressLines.join(" ")}</p>
            <p className="text-[11px] text-slate-500">NTN: {INVOICE_ISSUER.ntn}&nbsp;&nbsp; STRN: {INVOICE_ISSUER.strn}</p>
          </div>
        </div>
        <h2 className="text-2xl font-light tracking-tight text-slate-600 dark:text-slate-300">{report.title}</h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
        <HeaderCard label="BILL TO" value={report.billTo.name} detail={taxIds || null} />
        <HeaderCard label="Invoice Period" value={report.period.label} detail={report.filterNote} />
        <HeaderCard label="Total Orders" value={String(report.totals.orders)} detail={`Total Items: ${formatReportQuantity(report.totals.quantity)}`} />
        <HeaderCard
          label="Grand Total"
          value={`PKR ${formatReportMoney(report.totals.totalCents)}`}
          detail={`Excl. tax ${formatReportMoney(report.totals.valueExclTaxCents)} + tax ${formatReportMoney(report.totals.taxCents)}`}
        />
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[1100px] border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-0 bg-transparent" aria-hidden />
              <th colSpan={2} className="border border-amber-700/40 bg-[#b8941f] px-2 py-1.5 text-center text-xs font-bold text-white">Apricart Details</th>
              <th colSpan={11} className="border border-slate-700/40 bg-[#101e40] px-2 py-1.5 text-center text-xs font-bold text-white">{report.billTo.name} Details</th>
            </tr>
            <tr className="bg-[#101e40]">
              {COLUMNS.map((column) => (
                column.key === null
                  ? <th key={column.label} className={cn(HEAD_CELL, ALIGN[column.align ?? "center"] ?? "")}>{column.label}</th>
                  : (
                    <th aria-sort={ariaSortFor(sort, column.key)} key={column.label} className={cn(HEAD_CELL, column.align ? ALIGN[column.align] : "text-left")}>
                      <SortableHeader label={column.label} sortKey={column.key} sort={sort} onSort={onSort} firstDirection={column.firstDirection} />
                    </th>
                  )
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={`${row.orderId}-${row.invoiceNumber}`} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-950 dark:even:bg-slate-900/50">
                <td className="border border-slate-200 px-2 py-1.5 text-center dark:border-slate-800">{row.serial}</td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">
                  <Link href={`/invoices/${row.orderId}`} className="font-medium text-indigo-700 hover:underline dark:text-indigo-300">{row.invoiceNumber}</Link>
                  {row.invoiceStatus ? <div className="mt-0.5"><InvoiceStatusBadge status={row.invoiceStatus} /></div> : null}
                </td>
                <td className="whitespace-nowrap border border-slate-200 px-2 py-1.5 dark:border-slate-800">{row.invoiceDate}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-center dark:border-slate-800">{row.orderId}</td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">
                  {row.orderStatus}
                  {report.mode === "invoices" ? (
                    <div className={cn("mt-0.5 text-[10px] font-semibold", row.paymentStatus === "PAID" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                      {PAYMENT_STATUS_LABELS[row.paymentStatus]}
                    </div>
                  ) : null}
                </td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">{row.department}</td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">{row.approver}</td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">{row.designation}</td>
                <td className="border border-slate-200 px-2 py-1.5 dark:border-slate-800">{row.crc}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-right tabular-nums dark:border-slate-800">{formatReportQuantity(row.quantity)}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-right tabular-nums dark:border-slate-800">{formatReportMoney(row.valueExclTaxCents)}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-right dark:border-slate-800">{row.taxRateLabel}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-right tabular-nums dark:border-slate-800">{formatReportMoney(row.taxCents)}</td>
                <td className="border border-slate-200 px-2 py-1.5 text-right font-semibold tabular-nums dark:border-slate-800">{formatReportMoney(row.totalCents)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-100 font-bold dark:bg-slate-800">
              <td colSpan={9} className="border border-slate-200 px-2 py-2 dark:border-slate-700">Total</td>
              <td className="border border-slate-200 px-2 py-2 text-right tabular-nums dark:border-slate-700">{formatReportQuantity(report.totals.quantity)}</td>
              <td className="border border-slate-200 px-2 py-2 text-right tabular-nums dark:border-slate-700">{formatReportMoney(report.totals.valueExclTaxCents)}</td>
              <td className="border border-slate-200 px-2 py-2 dark:border-slate-700" />
              <td className="border border-slate-200 px-2 py-2 text-right tabular-nums dark:border-slate-700">{formatReportMoney(report.totals.taxCents)}</td>
              <td className="border border-slate-200 px-2 py-2 text-right tabular-nums dark:border-slate-700">{formatReportMoney(report.totals.totalCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 space-y-1 text-[11px] text-slate-500">
        {report.footnote ? <p className="italic">{report.footnote}</p> : null}
        <p>{report.statement}</p>
      </div>
    </div>
  )
}
