type AnalyticsAuthScope = {
  role?: string | null
  organizationId?: number | null
  branchId?: number | null
}

function optionalId(value: string | null): number | null {
  if (!value || value === "null" || value === "0") return null
  return Number(value)
}

export function resolveAnalyticsRequestScope(searchParams: URLSearchParams, scope: AnalyticsAuthScope | null | undefined) {
  const requestedOrganizationId = optionalId(searchParams.get("organizationId"))
  const requestedBranchId = optionalId(searchParams.get("branchId"))
  return {
    organizationId: requestedOrganizationId ?? (scope?.role !== "SUPER_ADMIN" ? scope?.organizationId ?? null : null),
    branchId: requestedBranchId ?? (scope?.role === "BRANCH_ADMIN" ? scope.branchId ?? null : null),
    groupId: optionalId(searchParams.get("groupId")),
  }
}
