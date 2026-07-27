import { safeFilenamePart } from "@/lib/security"

export type BranchExportSheet = {
  name: string
  headers: string[]
  rows: Record<string, unknown>[]
  columnWidths?: number[]
}

export type BranchExportPayload = {
  branchName: string
  branchCode: string
  generatedAt: string
  sheets: BranchExportSheet[]
}

export function getBranchExportFilename(
  branch: { name: string; code?: string | null },
  exportedAt = new Date(),
) {
  const branchIdentifier = safeFilenamePart(branch.code || branch.name, "branch")
  return `${branchIdentifier}-complete-details-${exportedAt.toISOString().slice(0, 10)}.xlsx`
}

export function resolveBranchSheetWidths(sheet: BranchExportSheet) {
  if (sheet.columnWidths?.length === sheet.headers.length) {
    return sheet.columnWidths.map((width) => ({ wch: Math.min(Math.max(width, 10), 60) }))
  }

  return sheet.headers.map((header) => {
    const contentWidth = sheet.rows.reduce((width, row) => {
      const value = row[header]
      return Math.max(width, String(value ?? "").length)
    }, header.length)

    return { wch: Math.min(Math.max(contentWidth + 2, 10), 50) }
  })
}
