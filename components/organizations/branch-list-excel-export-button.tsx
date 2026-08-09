"use client"

import { useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BRANCH_LIST_HEADERS,
  buildBranchListWorkbookData,
  getBranchListExportFilename,
  type BranchListExportData,
  type BranchListOrganizationData,
} from "@/lib/branch-excel-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

type BranchListExcelExportButtonProps = {
  branches: BranchListExportData[]
  organizations: BranchListOrganizationData[]
  selectedOrganization?: BranchListOrganizationData | null
  isLoading?: boolean
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
}

export function BranchListExcelExportButton({
  branches,
  organizations,
  selectedOrganization,
  isLoading = false,
  onSuccess,
  onError,
}: BranchListExcelExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false)
  const branchesToExport = selectedOrganization
    ? branches.filter(
        (branch) => String(branch.organizationId) === String(selectedOrganization.id),
      )
    : branches
  const scopeLabel = selectedOrganization?.name || "all organizations"

  const handleExport = async () => {
    if (isLoading || isExporting || branchesToExport.length === 0) return

    setIsExporting(true)
    try {
      const XLSX = await import("xlsx")
      const exportedAt = new Date()
      const rows = buildBranchListWorkbookData(branchesToExport, organizations)
      const worksheet = XLSX.utils.json_to_sheet(
        sanitizeSpreadsheetRecords(rows),
        { header: [...BRANCH_LIST_HEADERS] },
      )

      worksheet["!cols"] = [
        { wch: 30 },
        { wch: 30 },
        { wch: 20 },
        { wch: 14 },
        { wch: 18 },
        { wch: 18 },
        { wch: 48 },
        { wch: 22 },
      ]
      if (worksheet["!ref"]) {
        worksheet["!autofilter"] = { ref: worksheet["!ref"] }
      }

      const workbook = XLSX.utils.book_new()
      workbook.Props = {
        Title: selectedOrganization
          ? `${selectedOrganization.name} Branch List`
          : "Branch List",
        Subject: "Authorized branch summary",
        Author: "OneFlowe",
        CreatedDate: exportedAt,
      }
      XLSX.utils.book_append_sheet(workbook, worksheet, "Branches")
      XLSX.writeFile(
        workbook,
        getBranchListExportFilename(selectedOrganization, exportedAt),
        { compression: true },
      )

      onSuccess?.(
        `${branchesToExport.length} branch${branchesToExport.length === 1 ? "" : "es"} for ${scopeLabel} exported to Excel.`,
      )
    } catch (error) {
      console.error("Branch list Excel export failed", error)
      onError?.("Could not export the branch list. Please try again.")
    } finally {
      setIsExporting(false)
    }
  }

  const accessibleLabel = selectedOrganization
    ? `Download all branches for ${selectedOrganization.name} as Excel`
    : "Download all branches as Excel"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="rounded-lg text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      disabled={isLoading || isExporting || branchesToExport.length === 0}
      onClick={() => { void handleExport() }}
    >
      {isLoading || isExporting
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <Download className="h-4 w-4" />}
    </Button>
  )
}
