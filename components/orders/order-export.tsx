"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Upload, FileSpreadsheet, FileIcon as FilePdf, FileText } from "lucide-react"
import * as XLSX from "xlsx"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import { formatPKR } from "@/lib/utils"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

interface OrderExportProps {
    orders: any[]
    role?: string
}

export function OrderExport({ orders, role }: OrderExportProps) {
    const [isExporting, setIsExporting] = useState(false)

    const formatDataForExport = (order: any) => {
        const isSuperAdmin = role === "SUPER_ADMIN"

        // Derive refund status like in the UI
        let refundStatus = "None"
        if (order.status?.toLowerCase() === "refunded") {
            refundStatus = "Full"
        } else if (order.refundAmountCents && order.refundAmountCents > 0) {
            refundStatus = "Partial"
        }

        const data: any = {
            "ID": order.id,
            "TID": order.tid,
            "Date": new Date(order.createdAt).toLocaleDateString(),
            "Branch": order.branchName || "-",
            "Status": order.status?.toUpperCase() || "-",
            "Refund Status": refundStatus,
            "Amount (PKR)": order.totalCents !== null && order.totalCents !== undefined ? (order.totalCents / 100).toFixed(2) : "-",
            "Items": order.itemNames || "-",
        }

        // Add Org for Super Admin
        if (isSuperAdmin) {
            return {
                "ID": data.ID,
                "TID": data.TID,
                "Organization": order.organizationName || "-",
                "Branch": data.Branch,
                "Status": data.Status,
                "Refund Status": data["Refund Status"],
                "Amount (PKR)": data["Amount (PKR)"],
                "Date": data.Date,
                "Items": data["Items"],
                "Rejection Reason": order.rejectionReason || "-",
            }
        }

        return {
            ...data,
            "Rejection Reason": order.rejectionReason || "-",
        }
    }

    const handleExportCSV = () => {
        try {
            setIsExporting(true)
            const data = sanitizeSpreadsheetRecords(orders.map(o => formatDataForExport(o)))
            const worksheet = XLSX.utils.json_to_sheet(data)
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, "Orders")
            XLSX.writeFile(workbook, `orders-export-${new Date().toISOString().split('T')[0]}.csv`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    const handleExportExcel = () => {
        try {
            setIsExporting(true)
            const data = sanitizeSpreadsheetRecords(orders.map(o => formatDataForExport(o)))
            const worksheet = XLSX.utils.json_to_sheet(data)
            const workbook = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(workbook, worksheet, "Orders")
            XLSX.writeFile(workbook, `orders-export-${new Date().toISOString().split('T')[0]}.xlsx`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    const handleExportPDF = () => {
        try {
            setIsExporting(true)
            const doc = new jsPDF('l', 'mm', 'a4') // Landscape for better column fit

            // Header
            doc.setFontSize(18)
            doc.text("Orders Report", 14, 22)
            doc.setFontSize(10)
            doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 30)
            if (role) doc.text(`Role: ${role}`, 14, 36)

            const isSuperAdmin = role === "SUPER_ADMIN"
            const headers = ["ID", "TID", "Date", "Branch", "Status", "Refund", "Amount", "Items", "Reason"]
            if (isSuperAdmin) headers.splice(2, 0, "Organization")

            const tableData = orders.map(order => {
                let refundStatus = "None"
                if (order.status?.toLowerCase() === "refunded") {
                    refundStatus = "Full"
                } else if (order.refundAmountCents && order.refundAmountCents > 0) {
                    refundStatus = "Partial"
                }

                const row = [
                    order.id,
                    order.tid,
                    new Date(order.createdAt).toLocaleDateString(),
                    order.branchName || "-",
                    order.status?.toUpperCase() || "-",
                    refundStatus,
                    order.totalCents !== null && order.totalCents !== undefined ? formatPKR(order.totalCents / 100) : "-",
                    order.itemNames || "-",
                    order.rejectionReason || "-"
                ]
                if (isSuperAdmin) row.splice(2, 0, order.organizationName || "-")
                return row
            })

            autoTable(doc, {
                head: [headers],
                body: tableData,
                startY: 44,
                styles: { fontSize: 8 },
                headStyles: { fillColor: [15, 23, 42] }, // Slate-900
            })

            doc.save(`orders-export-${new Date().toISOString().split('T')[0]}.pdf`)
        } catch (error) {
            console.error("Export failed", error)
        } finally {
            setIsExporting(false)
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2" disabled={isExporting || orders.length === 0}>
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
