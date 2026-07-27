"use client"

import { useState, type MouseEvent } from "react"
import { FileSpreadsheet, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ORGANIZATION_BRANCH_HEADERS,
  ORGANIZATION_DETAIL_HEADERS,
  buildOrganizationWorkbookData,
  getOrganizationExportFilename,
  type OrganizationBranchExportData,
  type OrganizationExportData,
} from "@/lib/organization-excel-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

type OrganizationExcelExportButtonProps = {
  organization: OrganizationExportData
  branches: OrganizationBranchExportData[]
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
}

export function OrganizationExcelExportButton({
  organization,
  branches,
  onSuccess,
  onError,
}: OrganizationExcelExportButtonProps) {
  const [isExporting, setIsExporting] = useState(false)

  const handleExport = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isExporting) return

    setIsExporting(true)
    try {
      const XLSX = await import("xlsx")
      const exportedAt = new Date()
      const { organizationDetails, branchDetails } = buildOrganizationWorkbookData(
        organization,
        branches,
        exportedAt,
      )

      const organizationSheet = XLSX.utils.json_to_sheet(
        sanitizeSpreadsheetRecords(organizationDetails),
        { header: [...ORGANIZATION_DETAIL_HEADERS] },
      )
      organizationSheet["!cols"] = [{ wch: 26 }, { wch: 48 }]

      const branchesSheet = XLSX.utils.json_to_sheet(
        sanitizeSpreadsheetRecords(branchDetails),
        { header: [...ORGANIZATION_BRANCH_HEADERS] },
      )
      branchesSheet["!cols"] = [
        { wch: 28 },
        { wch: 20 },
        { wch: 12 },
        { wch: 28 },
        { wch: 20 },
        { wch: 12 },
        { wch: 18 },
        { wch: 18 },
        { wch: 48 },
        { wch: 20 },
        { wch: 24 },
        { wch: 22 },
        { wch: 22 },
      ]
      if (branchesSheet["!ref"]) {
        branchesSheet["!autofilter"] = { ref: branchesSheet["!ref"] }
      }

      const workbook = XLSX.utils.book_new()
      workbook.Props = {
        Title: `${organization.name} Organization Details`,
        Subject: "Organization and branch details",
        Author: "OneFlowe",
        CreatedDate: exportedAt,
      }
      XLSX.utils.book_append_sheet(workbook, organizationSheet, "Organization")
      XLSX.utils.book_append_sheet(workbook, branchesSheet, "Branches")
      XLSX.writeFile(
        workbook,
        getOrganizationExportFilename(organization, exportedAt),
        { compression: true },
      )

      onSuccess?.(`${organization.name} details exported to Excel.`)
    } catch (error) {
      console.error("Organization Excel export failed", error)
      onError?.("Could not export this company. Please try again.")
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 rounded-lg text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400"
      aria-label={`Export ${organization.name} details to Excel`}
      title="Export company details to Excel"
      disabled={isExporting}
      onClick={handleExport}
    >
      {isExporting
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <FileSpreadsheet className="h-4 w-4" />}
    </Button>
  )
}
