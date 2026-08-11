const BRANCH_SCOPED_ROLES = new Set([
  "BRANCH_ADMIN",
  "BRANCH_MANAGER",
  "ORDER_PORTAL",
])

export function isBranchScopedAnalyticsRole(role: unknown) {
  return typeof role === "string" && BRANCH_SCOPED_ROLES.has(role)
}

export function normalizePositiveIds(values: unknown[]) {
  return Array.from(new Set(
    values
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0),
  ))
}

export function parseRequestedOrganizationIds({
  organizationIds,
  organizationId,
}: {
  organizationIds: string | null
  organizationId: string | null
}) {
  const requested = (() => {
    if (organizationIds?.trim()) {
      return organizationIds.split(",")
    }
    if (organizationId) {
      return [organizationId]
    }
    return []
  })()

  return normalizePositiveIds(requested)
}

export function resolveAnalyticsOrganizationIds({
  role,
  userOrganizationId,
  requestedOrganizationIds,
}: {
  role: string
  userOrganizationId: unknown
  requestedOrganizationIds: unknown[]
}) {
  if (role === "SUPER_ADMIN") {
    return normalizePositiveIds(requestedOrganizationIds)
  }

  return normalizePositiveIds([userOrganizationId])
}

export function resolveAnalyticsBranchIds({
  role,
  userBranchId,
  requestedBranchIds,
  allowedBranchIds,
}: {
  role: string
  userBranchId: unknown
  requestedBranchIds: unknown[]
  allowedBranchIds: unknown[]
}) {
  const allowed = normalizePositiveIds(allowedBranchIds)
  const allowedSet = new Set(allowed)

  if (isBranchScopedAnalyticsRole(role)) {
    const [assignedBranchId] = normalizePositiveIds([userBranchId])
    return assignedBranchId && allowedSet.has(assignedBranchId)
      ? [assignedBranchId]
      : []
  }

  const requested = normalizePositiveIds(requestedBranchIds)
  return requested.length > 0
    ? requested.filter((branchId) => allowedSet.has(branchId))
    : allowed
}
