"use client"

import { useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ORGANIZATION_LIST_HEADERS,
  buildOrganizationListWorkbookData,
  getOrganizationListExportFilename,
  type OrganizationBranchExportData,
  type OrganizationExportData,
} from "@/lib/organization-excel-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

type OrganizationListExcelExportButtonProps = {
  organizations: OrganizationExportData[]
  branches: OrganizationBranchExportData[]
  isLoading?: boolean
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
}

export function OrganizationListExcelExportButton({
  organizations,
  branches,
  isLoading = false,
  onSuccess,
  onError,
}: OrganizationListExcelExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false)

  const handleExport = async () => {
    if (isLoading || isExporting || organizations.length === 0) return

    setIsExporting(true)
    try {
      const XLSX = await import("xlsx")
      const exportedAt = new Date()
      const rows = buildOrganizationListWorkbookData(organizations, branches)
      const worksheet = XLSX.utils.json_to_sheet(
        sanitizeSpreadsheetRecords(rows),
        { header: [...ORGANIZATION_LIST_HEADERS] },
      )

      worksheet["!cols"] = [
        { wch: 30 },
        { wch: 20 },
        { wch: 14 },
        { wch: 24 },
        { wch: 20 },
        { wch: 16 },
        { wch: 16 },
        { wch: 18 },
      ]
      if (worksheet["!ref"]) {
        worksheet["!autofilter"] = { ref: worksheet["!ref"] }
      }

      const workbook = XLSX.utils.book_new()
      workbook.Props = {
        Title: "Organization List",
        Subject: "Authorized organization summary",
        Author: "OneFlowe",
        CreatedDate: exportedAt,
      }
      XLSX.utils.book_append_sheet(workbook, worksheet, "Organizations")
      XLSX.writeFile(workbook, getOrganizationListExportFilename(exportedAt), {
        compression: true,
      })

      onSuccess?.(`${organizations.length} organization${organizations.length === 1 ? "" : "s"} exported to Excel.`)
    } catch (error) {
      console.error("Organization list Excel export failed", error)
      onError?.("Could not export the organization list. Please try again.")
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="rounded-lg text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400"
      aria-label="Download all organizations as Excel"
      title="Download all organizations as Excel"
      disabled={isLoading || isExporting || organizations.length === 0}
      onClick={() => { void handleExport() }}
    >
      {isLoading || isExporting
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <Download className="h-4 w-4" />}
    </Button>
  )
}
