import { safeFilenamePart } from "@/lib/security"

export type OrganizationExportData = {
  id: number
  name: string
  code: string
  status?: string | null
  budgetAllocationMode?: string | null
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
}

export type OrganizationBranchExportData = {
  id: number
  organizationId: number
  name: string
  code: string
  status?: string | null
  province?: string | null
  city?: string | null
  address?: string | null
  costCenterId?: string | null
  groupId?: number | null
  groupName?: string | null
  createdAt?: string | Date | null
  updatedAt?: string | Date | null
}

export const ORGANIZATION_DETAIL_HEADERS = ["Field", "Value"] as const

export const ORGANIZATION_BRANCH_HEADERS = [
  "Organization Name",
  "Organization Code",
  "Branch ID",
  "Branch Name",
  "Branch Code",
  "Status",
  "Province",
  "City",
  "Address",
  "Cost Center ID",
  "Group / Cluster",
  "Created At",
  "Last Updated",
] as const

const formatStatus = (value: unknown, fallback = "Active") => {
  if (typeof value !== "string" || !value.trim()) return fallback

  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

const formatDateTime = (value: string | Date | null | undefined) => {
  if (!value) return "-"

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "-"

  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`
}

const isActive = (status: unknown) =>
  typeof status === "string"
    ? status.trim().toLowerCase() === "active"
    : Boolean(status)

export function buildOrganizationWorkbookData(
  organization: OrganizationExportData,
  branches: OrganizationBranchExportData[],
  exportedAt = new Date(),
) {
  const organizationBranches = branches.filter(
    (branch) => String(branch.organizationId) === String(organization.id),
  )
  const activeBranchCount = organizationBranches.filter((branch) => isActive(branch.status)).length
  const inactiveBranchCount = organizationBranches.length - activeBranchCount

  const organizationDetails: Record<(typeof ORGANIZATION_DETAIL_HEADERS)[number], unknown>[] = [
    { Field: "Organization ID", Value: organization.id },
    { Field: "Organization Name", Value: organization.name },
    { Field: "Organization Code", Value: organization.code },
    { Field: "Status", Value: formatStatus(organization.status) },
    {
      Field: "Budget Allocation Mode",
      Value: organization.budgetAllocationMode === "quantity" ? "Quantity-based" : "Money-based",
    },
    { Field: "Total Branches", Value: organizationBranches.length },
    { Field: "Active Branches", Value: activeBranchCount },
    { Field: "Inactive Branches", Value: inactiveBranchCount },
    { Field: "Created At", Value: formatDateTime(organization.createdAt) },
    { Field: "Last Updated", Value: formatDateTime(organization.updatedAt) },
    { Field: "Exported At", Value: formatDateTime(exportedAt) },
  ]

  const branchDetails: Record<(typeof ORGANIZATION_BRANCH_HEADERS)[number], unknown>[] =
    organizationBranches.map((branch) => ({
      "Organization Name": organization.name,
      "Organization Code": organization.code,
      "Branch ID": branch.id,
      "Branch Name": branch.name,
      "Branch Code": branch.code,
      "Status": formatStatus(branch.status),
      "Province": branch.province || "-",
      "City": branch.city || "-",
      "Address": branch.address || "-",
      "Cost Center ID": branch.costCenterId || "-",
      "Group / Cluster": branch.groupName || (branch.groupId ? `Group ${branch.groupId}` : "Ungrouped"),
      "Created At": formatDateTime(branch.createdAt),
      "Last Updated": formatDateTime(branch.updatedAt),
    }))

  return { organizationDetails, branchDetails }
}

export function getOrganizationExportFilename(
  organization: Pick<OrganizationExportData, "name" | "code">,
  exportedAt = new Date(),
) {
  const companyIdentifier = safeFilenamePart(organization.code || organization.name, "company")
  const exportDate = exportedAt.toISOString().slice(0, 10)
  return `${companyIdentifier}-organization-details-${exportDate}.xlsx`
}
