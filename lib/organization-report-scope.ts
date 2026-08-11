type ReportScopeInput = {
  selectedOrganizationIds: string[]
  selectedBranchIds: string[]
  contextOrganizationId: string | null
  contextBranchId: string | null
  contextBranchIds: string[]
}

export function resolveOrganizationReportScope({
  selectedOrganizationIds,
  selectedBranchIds,
  contextOrganizationId,
  contextBranchId,
  contextBranchIds,
}: ReportScopeInput) {
  const organizationIds = (() => {
    if (selectedOrganizationIds.length > 0) {
      return selectedOrganizationIds
    }
    if (contextOrganizationId) {
      return [contextOrganizationId]
    }
    return []
  })()

  const branchIds = (() => {
    if (selectedBranchIds.length > 0) {
      return selectedBranchIds
    }
    if (contextBranchIds.length > 0) {
      return contextBranchIds
    }
    if (contextBranchId) {
      return [contextBranchId]
    }
    return []
  })()

  return { organizationIds, branchIds }
}

export function shouldIncludeHeadOfficeUsers(
  branchIdsParam: string | null,
  groupIdsParam: string | null,
) {
  return !branchIdsParam && !groupIdsParam
}
