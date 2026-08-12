"use client"

import { useState, type MouseEvent } from "react"
import { FileSpreadsheet, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  getBranchExportFilename,
  resolveBranchSheetWidths,
  type BranchExportPayload,
} from "@/lib/branch-excel-export"
import { sanitizeSpreadsheetRecords } from "@/lib/spreadsheet"

type BranchExcelExportButtonProps = {
  branch: {
    id: number
    name: string
    code?: string | null
  }
  onSuccess?: (message: string) => void
  onError?: (message: string) => void
}

export function BranchExcelExportButton({
  branch,
  onSuccess,
  onError,
}: Readonly<BranchExcelExportButtonProps>) {
  const [isExporting, setIsExporting] = useState(false)

  const handleExport = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (isExporting) return

    setIsExporting(true)
    try {
      const response = await fetch(`/api/v1/branches/${branch.id}/export`, {
        credentials: "include",
        cache: "no-store",
      })
      const data = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(data?.error || data?.message || "Branch export failed")
      }

      const payload = data?.item as BranchExportPayload | undefined
      if (!payload || !Array.isArray(payload.sheets)) {
        throw new Error("The branch export response was incomplete")
      }

      const XLSX = await import("xlsx")
      const workbook = XLSX.utils.book_new()
      const exportedAt = new Date(payload.generatedAt || Date.now())
      workbook.Props = {
        Title: `${payload.branchName} Complete Branch Details`,
        Subject: "Branch profile and operational records",
        Author: "OneFlowe",
        CreatedDate: exportedAt,
      }

      for (const sheet of payload.sheets) {
        const worksheet = XLSX.utils.json_to_sheet(
          sanitizeSpreadsheetRecords(sheet.rows),
          { header: sheet.headers },
        )
        worksheet["!cols"] = resolveBranchSheetWidths(sheet)
        if (sheet.name !== "Branch Details" && worksheet["!ref"]) {
          worksheet["!autofilter"] = { ref: worksheet["!ref"] }
        }
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name)
      }

      XLSX.writeFile(
        workbook,
        getBranchExportFilename(
          { name: payload.branchName, code: payload.branchCode || branch.code },
          exportedAt,
        ),
        { compression: true },
      )

      onSuccess?.(`${branch.name} complete details exported to Excel.`)
    } catch (error) {
      console.error("Branch Excel export failed", error)
      onError?.(error instanceof Error ? error.message : "Could not export this branch.")
    } finally {
      setIsExporting(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-9 w-9 rounded-xl text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-500/10 dark:hover:text-emerald-400"
      aria-label={`Export ${branch.name} complete details to Excel`}
      title="Export complete branch details to Excel"
      disabled={isExporting}
      onClick={handleExport}
    >
      {isExporting
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <FileSpreadsheet className="h-4 w-4" />}
    </Button>
  )
}
