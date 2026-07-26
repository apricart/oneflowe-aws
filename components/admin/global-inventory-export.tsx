"use client"

import { useState } from "react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"
import { FileIcon as FilePdf, FileSpreadsheet, FileText, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatPKR } from "@/lib/utils"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

type GlobalInventoryExportItem = {
    id: number
    productCode?: string | null
    name: string
    categoryName?: string | null
    parentCategoryName?: string | null
    basePrice: number
    status: string
    stockQuantity: number
}

type GlobalInventoryExportProps = {
    products: GlobalInventoryExportItem[]
}

export function GlobalInventoryExport({ products }: GlobalInventoryExportProps) {
    const [isExporting, setIsExporting] = useState(false)

    const exportDate = new Date().toISOString().split("T")[0]

    const getProductLabel = (product: GlobalInventoryExportItem) => {
        const identifier = product.productCode || `#${product.id}`
        return `${product.name} (${identifier})`
    }

    const formatDataForExport = (product: GlobalInventoryExportItem) => ({
        Product: getProductLabel(product),
        Category: product.parentCategoryName || "Uncategorized",
        Subcategory: product.categoryName || "Uncategorized",
        "Base Price": formatPKR(product.basePrice / 100),
        Status: product.status || "-",
        Stock: product.stockQuantity ?? 0,
    })

    const handleExportCSV = () => {
        try {
            setIsExporting(true)
            const worksheet = XLSX.utils.json_to_sheet(
                sanitizeSpreadsheetRecords(products.map(formatDataForExport)),
            )
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, "Global Products")
            XLSX.writeFile(workbook, `global-products-export-${exportDate}.csv`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    const handleExportExcel = () => {
        try {
            setIsExporting(true)
            const worksheet = XLSX.utils.json_to_sheet(
                sanitizeSpreadsheetRecords(products.map(formatDataForExport)),
            )
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, "Global Products")
            XLSX.writeFile(workbook, `global-products-export-${exportDate}.xlsx`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    const handleExportPDF = () => {
        try {
            setIsExporting(true)
            const doc = new jsPDF("l", "mm", "a4")

            doc.setFontSize(18)
            doc.text("Global Products Report", 14, 22)
            doc.setFontSize(10)
            doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 30)

            autoTable(doc, {
                head: [["Product", "Category", "Subcategory", "Base Price", "Status", "Stock"]],
                body: products.map((product) => [
                    getProductLabel(product),
                    product.parentCategoryName || "Uncategorized",
                    product.categoryName || "Uncategorized",
                    formatPKR(product.basePrice / 100),
                    product.status || "-",
                    product.stockQuantity ?? 0,
                ]),
                startY: 38,
                styles: { fontSize: 8 },
                headStyles: { fillColor: [15, 23, 42] },
            })

            doc.save(`global-products-export-${exportDate}.pdf`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    className="w-full gap-2 lg:w-auto"
                    disabled={isExporting || products.length === 0}
                >
                    <Upload className="h-4 w-4" />
                    Export
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportCSV}>
                    <FileText className="mr-2 h-4 w-4" />
                    CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportExcel}>
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Excel
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportPDF}>
                    <FilePdf className="mr-2 h-4 w-4" />
                    PDF
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
