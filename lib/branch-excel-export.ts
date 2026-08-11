import { stringifyPrimitive } from "./stringify-primitive"
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

export type BranchListExportData = {
  id: number
  organizationId: number
  name: string
  code?: string | null
  status?: string | null
  province?: string | null
  city?: string | null
  address?: string | null
  costCenterId?: string | null
}

export type BranchListOrganizationData = {
  id: number
  name: string
  code?: string | null
}

export const BRANCH_LIST_HEADERS = [
  "Organization Name",
  "Branch Name",
  "Branch Code",
  "Status",
  "Province",
  "City",
  "Address",
  "Cost Center ID",
] as const

const formatStatus = (value: unknown, fallback = "Active") => {
  if (typeof value !== "string" || !value.trim()) return fallback

  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export function buildBranchListWorkbookData(
  branches: BranchListExportData[],
  organizations: BranchListOrganizationData[],
) {
  const organizationNames = new Map(
    organizations.map((organization) => [String(organization.id), organization.name]),
  )

  return branches.map((branch) => ({
    "Organization Name": organizationNames.get(String(branch.organizationId)) || "-",
    "Branch Name": branch.name,
    "Branch Code": branch.code || "-",
    "Status": formatStatus(branch.status),
    "Province": branch.province || "-",
    "City": branch.city || "-",
    "Address": branch.address || "-",
    "Cost Center ID": branch.costCenterId || "-",
  } satisfies Record<(typeof BRANCH_LIST_HEADERS)[number], unknown>))
}

export function getBranchListExportFilename(
  organization?: BranchListOrganizationData | null,
  exportedAt = new Date(),
) {
  const scopeIdentifier = organization
    ? safeFilenamePart(organization.code || organization.name, "organization")
    : "all"
  return `${scopeIdentifier}-branches-${exportedAt.toISOString().slice(0, 10)}.xlsx`
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
      return Math.max(width, stringifyPrimitive(value).length)
    }, header.length)

    return { wch: Math.min(Math.max(contentWidth + 2, 10), 50) }
  })
}
