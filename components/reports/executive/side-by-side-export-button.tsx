"use client"

import * as React from "react"
import { FileSpreadsheet, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { SideBySidePanel } from "@/lib/executive-analytics"
import {
  buildSideBySideWorkbookData,
  getSideBySideExportFilename,
  isSideBySideExportReady,
  type SideBySideExportContext,
  type SideBySidePanelSnapshot,
} from "@/lib/executive-side-by-side-export"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"

/**
 * Downloads the Compare Side by Side screen as one workbook.
 *
 * The sheets are built from the responses the panels already hold — nothing
 * is re-fetched — so the file is the screen, under the same filters, at the
 * same measure. The button waits until every panel has answered: a workbook
 * with a sheet saying "had not loaded" is what a reader gets by clicking too
 * early, and nobody wants that one.
 */
export function SideBySideExportButton({ panels, ready, readSnapshots, context }: Readonly<{
  panels: readonly SideBySidePanel[]
  /** Whether every panel on screen has answered; the button stays off until then. */
  ready: boolean
  /** The panels' current responses, read at the moment of the click. */
  readSnapshots: () => Readonly<Record<string, SideBySidePanelSnapshot | undefined>>
  /** Everything but the timestamp, which is taken at the moment of the click. */
  context: Omit<SideBySideExportContext, "exportedAt">
}>) {
  const [exporting, setExporting] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const handleExport = async () => {
    if (exporting || !ready) return
    // Re-checked against the responses themselves: a filter change between
    // the render and the click must not ship a half-loaded workbook.
    const snapshots = readSnapshots()
    if (!isSideBySideExportReady(panels, snapshots)) return

    setExporting(true)
    setFailed(false)
    try {
      const XLSX = await import("xlsx")
      const exportedAt = new Date()
      const sheets = buildSideBySideWorkbookData(panels, snapshots, { ...context, exportedAt })

      const workbook = XLSX.utils.book_new()
      workbook.Props = {
        Title: "Compare Side by Side",
        Subject: "Executive procurement analytics",
        Author: "OneFlowe",
        CreatedDate: exportedAt,
      }
      for (const sheet of sheets) {
        // Labels are product and person names typed by users; a name that
        // starts with "=" must open as text, not run as a formula.
        const worksheet = XLSX.utils.aoa_to_sheet([sheet.columns, ...sheet.rows.map(sanitizeSpreadsheetRow)])
        worksheet["!cols"] = sheet.columnWidths.map((wch) => ({ wch }))
        XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name)
      }
      XLSX.writeFile(workbook, getSideBySideExportFilename(context), { compression: true })
    } catch {
      setFailed(true)
    } finally {
      setExporting(false)
    }
  }

  const title = (() => {
    if (exporting) return "Preparing the workbook…"
    if (!ready) return "Waiting for every comparison to load"
    return "Download every panel on screen as an Excel workbook"
  })()

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1.5 rounded-lg text-xs font-semibold"
        disabled={exporting || !ready}
        aria-busy={exporting}
        title={title}
        onClick={handleExport}
      >
        {exporting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          : <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />}
        Download Excel
      </Button>
      {failed ? (
        <span role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">
          The workbook could not be created. Please try again.
        </span>
      ) : null}
    </div>
  )
}
