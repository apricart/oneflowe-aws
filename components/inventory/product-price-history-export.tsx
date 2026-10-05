"use client"

import { useState } from "react"
import { FileIcon as FilePdf, FileSpreadsheet, FileText, Upload } from "lucide-react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/hooks/use-toast"
import type { ProductPriceHistoryPoint, ProductPriceHistoryProduct } from "@/lib/product-price-history"
import {
  PRODUCT_PRICE_HISTORY_EXPORT_HEADERS,
  buildProductPriceHistoryExportRows,
  productPriceHistoryExportFileName,
} from "@/lib/product-price-history-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"
import { formatPKR } from "@/lib/utils"

type ExportFormat = "csv" | "xlsx" | "pdf"

interface ProductPriceHistoryExportProps {
  product: Pick<ProductPriceHistoryProduct, "productCode" | "name">
  /** The records the table shows, newest first. */
  points: readonly ProductPriceHistoryPoint[]
  /** Human-readable filter summary printed on the PDF, e.g. "Last 12 months · K-Electric". */
  scopeDescription: string
}

function money(value: string | number) {
  return typeof value === "number" ? formatPKR(value, { maximumFractionDigits: 2, minimumFractionDigits: 0 }) : "—"
}

export function ProductPriceHistoryExport({ product, points, scopeDescription }: Readonly<ProductPriceHistoryExportProps>) {
  const [isExporting, setIsExporting] = useState(false)

  const exportSpreadsheet = (extension: "csv" | "xlsx") => {
    const rows = sanitizeSpreadsheetRecords(buildProductPriceHistoryExportRows(product, points))
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: [...PRODUCT_PRICE_HISTORY_EXPORT_HEADERS] })
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Price history")
    XLSX.writeFile(workbook, productPriceHistoryExportFileName(product, extension))
  }

  const exportPdf = () => {
    const rows = buildProductPriceHistoryExportRows(product, points)
    const doc = new jsPDF("l", "mm", "a4")
    doc.setFontSize(16)
    doc.text(`Product Price History — ${product.name}`, 14, 18)
    doc.setFontSize(10)
    doc.text(`Product code: ${product.productCode}`, 14, 26)
    doc.text(scopeDescription, 14, 32)
    doc.text(`Records: ${rows.length} · Generated: ${new Date().toLocaleString("en-PK", { timeZone: "Asia/Karachi" })} PKT`, 14, 38)

    autoTable(doc, {
      head: [["Changed (PKT)", "Previous price", "New price", "Change", "Scope", "Organization", "Group", "Branch", "Source"]],
      body: rows.map((row) => [
        row["Changed (PKT)"],
        money(row["Previous price (PKR)"]),
        money(row["New price (PKR)"]),
        money(row["Change (PKR)"]),
        row["Scope"],
        row["Organization"] || "—",
        row["Group"] || "—",
        row["Branch"] || "—",
        row["Source"],
      ]),
      startY: 44,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [15, 23, 42] },
      columnStyles: { 1: { halign: "right" }, 2: { halign: "right" }, 3: { halign: "right" } },
    })
    doc.save(productPriceHistoryExportFileName(product, "pdf"))
  }

  const runExport = (format: ExportFormat) => {
    if (isExporting) return
    setIsExporting(true)
    try {
      if (format === "pdf") exportPdf()
      else exportSpreadsheet(format)
    } catch {
      toast({
        title: "Export failed",
        description: "The price history could not be exported. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={isExporting || points.length === 0}>
          <Upload className="h-4 w-4" />
          {isExporting ? "Exporting…" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={isExporting} onClick={() => runExport("csv")}>
          <FileText className="mr-2 h-4 w-4" />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isExporting} onClick={() => runExport("xlsx")}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          Excel
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isExporting} onClick={() => runExport("pdf")}>
          <FilePdf className="mr-2 h-4 w-4" />
          PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
