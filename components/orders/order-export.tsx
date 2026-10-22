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
import { toast } from "@/hooks/use-toast"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"
import { getOrderStatusDisplay } from "@/lib/order-status-display"
import type { OrderStatusContext } from "@/lib/order-status"
import { renamedRoleName } from "@/lib/role-display-names"
import { isApricartSupportRole } from "@/lib/apricart-support-access"

interface OrderExportProps {
    /**
     * Every order matching the active filters, not the page on screen. The
     * orders list is paginated, so the caller walks all of its pages here.
     */
    fetchOrders: () => Promise<any[]>
    /** Orders in the whole filtered scope, used only to disable an empty export. */
    totalOrders: number
    role?: string
    statusContext?: OrderStatusContext
}

export function OrderExport({ fetchOrders, totalOrders, role, statusContext = "default" }: Readonly<OrderExportProps>) {
    const [isExporting, setIsExporting] = useState(false)

    const formatDataForExport = (order: any) => {
        const showOrganization = role === "SUPER_ADMIN" || isApricartSupportRole(role)

        const statusDisplay = getOrderStatusDisplay(order, statusContext)

        const data: any = {
            "ID": order.id,
            "TID": order.tid,
            "Date": new Date(order.createdAt).toLocaleDateString(),
            "Group": order.groupName || "-",
            "Branch": order.branchName || "-",
            "Status": statusDisplay.orderStatus.label,
            "Fulfillment Status": statusDisplay.fulfillmentStatus || "-",
            "Payment Status": statusDisplay.paymentStatus || "-",
            "Refund Status": statusDisplay.refundStatus || "None",
            "Amount (PKR)": order.totalCents !== null && order.totalCents !== undefined ? (order.totalCents / 100).toFixed(2) : "-",
            "Items": order.itemNames || "-",
        }

        // Add Org for Super Admin
        if (showOrganization) {
            return {
                "ID": data.ID,
                "TID": data.TID,
                "Organization": order.organizationName || "-",
                "Group": data.Group,
                "Branch": data.Branch,
                "Status": data.Status,
                "Fulfillment Status": data["Fulfillment Status"],
                "Payment Status": data["Payment Status"],
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

    const exportSpreadsheet = async (extension: "csv" | "xlsx") => {
        const orders = await fetchOrders()
        if (orders.length === 0) {
            toast({ title: "No orders to export", description: "No orders match the active filters." })
            return
        }
        const data = sanitizeSpreadsheetRecords(orders.map(o => formatDataForExport(o)))
        const worksheet = XLSX.utils.json_to_sheet(data)
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Orders")
        XLSX.writeFile(workbook, `orders-export-${new Date().toISOString().split('T')[0]}.${extension}`)
    }

    const exportPDF = async () => {
        const orders = await fetchOrders()
        if (orders.length === 0) {
            toast({ title: "No orders to export", description: "No orders match the active filters." })
            return
        }
        const doc = new jsPDF('l', 'mm', 'a4') // Landscape for better column fit

        // Header
        doc.setFontSize(18)
        doc.text("Orders Report", 14, 22)
        doc.setFontSize(10)
        doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 30)
        if (role) doc.text(`Role: ${renamedRoleName(role) ?? role.replaceAll("_", " ")}`, 14, 36)

        const showOrganization = role === "SUPER_ADMIN" || isApricartSupportRole(role)
        const headers = ["ID", "TID", "Date", "Group", "Branch", "Status", "Fulfillment", "Payment", "Refund", "Amount", "Items", "Reason"]
        if (showOrganization) headers.splice(2, 0, "Organization")

        const tableData = orders.map(order => {
            const statusDisplay = getOrderStatusDisplay(order, statusContext)

            const row = [
                order.id,
                order.tid,
                new Date(order.createdAt).toLocaleDateString(),
                order.groupName || "-",
                order.branchName || "-",
                statusDisplay.orderStatus.label,
                statusDisplay.fulfillmentStatus || "-",
                statusDisplay.paymentStatus || "-",
                statusDisplay.refundStatus || "None",
                order.totalCents !== null && order.totalCents !== undefined ? formatPKR(order.totalCents / 100) : "-",
                order.itemNames || "-",
                order.rejectionReason || "-"
            ]
            if (showOrganization) row.splice(2, 0, order.organizationName || "-")
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
    }

    const runExport = async (task: () => Promise<void>) => {
        if (isExporting) return
        setIsExporting(true)
        try {
            await task()
        } catch (error) {
            console.error("Export failed", error)
            toast({
                title: "Export failed",
                description: error instanceof Error ? error.message : "Unable to export the filtered orders.",
                variant: "destructive",
            })
        } finally {
            setIsExporting(false)
        }
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" className="gap-2" disabled={isExporting || totalOrders === 0}>
                    <Upload className="h-4 w-4" />
                    {isExporting ? "Exporting…" : "Export"}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={isExporting} onClick={() => runExport(() => exportSpreadsheet("csv"))}>
                    <FileText className="mr-2 h-4 w-4" />
                    CSV
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isExporting} onClick={() => runExport(() => exportSpreadsheet("xlsx"))}>
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                    Excel
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isExporting} onClick={() => runExport(exportPDF)}>
                    <FilePdf className="mr-2 h-4 w-4" />
                    PDF
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
