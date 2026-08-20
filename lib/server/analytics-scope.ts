const BRANCH_SCOPED_ROLES = new Set([
  "BRANCH_ADMIN",
  "BRANCH_MANAGER",
  "ORDER_PORTAL",
])

/**
 * Roles whose analytics reach is a *set* of branches rather than the one branch
 * pinned on the user row. Only the group approver reads reports; the ordering
 * group role has no reporting surface and is deliberately absent, so nothing
 * here can widen what it sees.
 */
const MULTI_BRANCH_SCOPED_ROLES = new Set([
  "GROUP_USER",
])

export function isBranchScopedAnalyticsRole(role: unknown) {
  return typeof role === "string" && BRANCH_SCOPED_ROLES.has(role)
}

export function isMultiBranchAnalyticsRole(role: unknown) {
  return typeof role === "string" && MULTI_BRANCH_SCOPED_ROLES.has(role)
}

/**
 * The branch filter a multi-branch role must be pinned to, or `null` when the
 * role is not one. Returning an empty array is a deny, never "everything": a
 * caller that finds no branch here has to refuse the request rather than run an
 * unfiltered query.
 */
export function resolveMultiBranchAnalyticsIds({
  role,
  assignedBranchIds,
  allowedBranchIds,
  requestedBranchIds = [],
}: {
  role: string
  assignedBranchIds: unknown[] | null | undefined
  allowedBranchIds?: unknown[]
  requestedBranchIds?: unknown[]
}): number[] | null {
  if (!isMultiBranchAnalyticsRole(role)) return null

  const assigned = normalizePositiveIds(assignedBranchIds ?? [])
  if (assigned.length === 0) return []

  // The tenant's own branch list, when the caller has one, narrows the
  // assignments further; it never adds to them.
  const permitted = allowedBranchIds === undefined
    ? assigned
    : assigned.filter((branchId) => new Set(normalizePositiveIds(allowedBranchIds)).has(branchId))

  const requested = normalizePositiveIds(requestedBranchIds)
  return requested.length > 0
    ? requested.filter((branchId) => permitted.includes(branchId))
    : permitted
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
  assignedBranchIds,
}: {
  role: string
  userBranchId: unknown
  requestedBranchIds: unknown[]
  allowedBranchIds: unknown[]
  /** Required for a multi-branch role; ignored for every other role. */
  assignedBranchIds?: unknown[] | null
}) {
  const allowed = normalizePositiveIds(allowedBranchIds)
  const allowedSet = new Set(allowed)

  const multiBranchIds = resolveMultiBranchAnalyticsIds({
    role,
    assignedBranchIds,
    allowedBranchIds,
    requestedBranchIds,
  })
  if (multiBranchIds !== null) return multiBranchIds

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
