"use client"

import { useState } from "react"
import { Download, FileIcon as FilePdf, FileSpreadsheet } from "lucide-react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/hooks/use-toast"
import {
  ASSIGNED_EXPORT_HEADERS,
  NOT_ASSIGNED_EXPORT_HEADERS,
  ORGANIZATION_PRODUCTS_LIST_LABELS,
  buildAssignedExportRows,
  buildNotAssignedExportRows,
  organizationProductsExportFileName,
  type AssignedExportProduct,
  type NotAssignedExportProduct,
  type OrganizationProductsExportList,
} from "@/lib/organization-products-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"
import { formatPKR } from "@/lib/utils"

type ExportFormat = "xlsx" | "pdf"
type ExportScope = OrganizationProductsExportList | "all"

interface OrganizationProductsExportProps {
  organizationName: string
  /** The rows the "Not Assigned" tab shows, after search and filters. */
  notAssigned: readonly NotAssignedExportProduct[]
  /** The rows the "Assigned" tab shows, after search and filters. */
  assigned: readonly AssignedExportProduct[]
  /** Human-readable filter summary printed on the PDF, e.g. "Search: rice · Category: Grocery". */
  filterDescription: string
  disabled?: boolean
}

function money(value: string | number) {
  return typeof value === "number" ? formatPKR(value, { maximumFractionDigits: 2, minimumFractionDigits: 0 }) : "Not set"
}

const SCOPES: readonly ExportScope[] = ["not-assigned", "assigned", "all"]

export function OrganizationProductsExport({
  organizationName,
  notAssigned,
  assigned,
  filterDescription,
  disabled = false,
}: Readonly<OrganizationProductsExportProps>) {
  const [isExporting, setIsExporting] = useState(false)

  const lists = (scope: ExportScope): OrganizationProductsExportList[] =>
    scope === "all" ? ["not-assigned", "assigned"] : [scope]

  const countOf = (scope: ExportScope) => {
    if (scope === "not-assigned") return notAssigned.length
    if (scope === "assigned") return assigned.length
    return notAssigned.length + assigned.length
  }

  const scopeLabel = (scope: ExportScope) =>
    scope === "all" ? "Both lists" : ORGANIZATION_PRODUCTS_LIST_LABELS[scope]

  const exportExcel = (scope: ExportScope) => {
    const workbook = XLSX.utils.book_new()
    for (const list of lists(scope)) {
      const worksheet = list === "assigned"
        ? XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(buildAssignedExportRows(assigned)), { header: [...ASSIGNED_EXPORT_HEADERS] })
        : XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(buildNotAssignedExportRows(notAssigned)), { header: [...NOT_ASSIGNED_EXPORT_HEADERS] })
      XLSX.utils.book_append_sheet(workbook, worksheet, ORGANIZATION_PRODUCTS_LIST_LABELS[list])
    }
    XLSX.writeFile(workbook, organizationProductsExportFileName(organizationName, scope, "xlsx"))
  }

  const exportPdf = (scope: ExportScope) => {
    const doc = new jsPDF("l", "mm", "a4")
    lists(scope).forEach((list, index) => {
      if (index > 0) doc.addPage()
      const isAssigned = list === "assigned"
      const count = isAssigned ? assigned.length : notAssigned.length
      doc.setFontSize(16)
      doc.text(`Organization Products — ${organizationName}`, 14, 18)
      doc.setFontSize(10)
      doc.text(`${ORGANIZATION_PRODUCTS_LIST_LABELS[list]} products: ${count}`, 14, 26)
      doc.text(filterDescription, 14, 32)
      doc.text(`Generated: ${new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} PKT`, 14, 38)

      if (isAssigned) {
        autoTable(doc, {
          head: [[...ASSIGNED_EXPORT_HEADERS.map((h) => h.replace(" (PKR)", ""))]],
          body: buildAssignedExportRows(assigned).map((row) => [
            row["Product code"],
            row["Product"],
            row["Category"],
            row["Subcategory"],
            money(row["Custom price (PKR)"]),
            row["Status"],
          ]),
          startY: 44,
          styles: { fontSize: 8 },
          headStyles: { fillColor: [15, 23, 42] },
          columnStyles: { 4: { halign: "right" } },
        })
      } else {
        autoTable(doc, {
          head: [[...NOT_ASSIGNED_EXPORT_HEADERS.map((h) => h.replace(" (PKR)", ""))]],
          body: buildNotAssignedExportRows(notAssigned).map((row) => [
            row["Product code"],
            row["Product"],
            row["Category"],
            row["Subcategory"],
            money(row["Base price (PKR)"]),
            row["Unit"],
          ]),
          startY: 44,
          styles: { fontSize: 8 },
          headStyles: { fillColor: [15, 23, 42] },
          columnStyles: { 4: { halign: "right" } },
        })
      }
    })
    doc.save(organizationProductsExportFileName(organizationName, scope, "pdf"))
  }

  const runExport = (format: ExportFormat, scope: ExportScope) => {
    if (isExporting) return
    setIsExporting(true)
    try {
      if (format === "pdf") exportPdf(scope)
      else exportExcel(scope)
    } catch {
      toast({
        title: "Export failed",
        description: "The product list could not be exported. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsExporting(false)
    }
  }

  const renderItems = (format: ExportFormat) =>
    SCOPES.map((scope) => (
      <DropdownMenuItem
        key={`${format}-${scope}`}
        disabled={isExporting || countOf(scope) === 0}
        onClick={() => runExport(format, scope)}
      >
        {format === "pdf" ? <FilePdf className="mr-2 h-4 w-4" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
        {`${scopeLabel(scope)} (${countOf(scope)}) — ${format === "pdf" ? "PDF" : "Excel"}`}
      </DropdownMenuItem>
    ))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-9 gap-2"
          disabled={disabled || isExporting || countOf("all") === 0}
        >
          <Download className="h-4 w-4" />
          {isExporting ? "Exporting…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Excel</DropdownMenuLabel>
        {renderItems("xlsx")}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>PDF</DropdownMenuLabel>
        {renderItems("pdf")}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
