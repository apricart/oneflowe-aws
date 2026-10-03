/**
 * The read-only Viewer role, in one place.
 *
 * A Viewer sees a dashboard and can do nothing else. What makes that true is
 * not a rule in this file — it is that `requireApiRole` denies any role absent
 * from a route's allowlist, and this role was added to read endpoints only. So
 * the load-bearing statement here is `VIEWER_READ_ROUTES`: the complete list of
 * routes that admit a Viewer. `lib/viewer-access.test.ts` reads those route
 * files and fails if one of them is missing from the list, or if a route on the
 * list turns out to export a mutating handler.
 *
 * Scope is the other half. A Viewer always belongs to exactly one organization,
 * and may additionally be pinned to one branch:
 *
 *   * unpinned — reads its whole tenant, and may narrow with a branch filter
 *   * pinned   — reads that branch alone, and the query string cannot widen it
 *
 * `resolveViewerScope` is that rule, and every route admitting the role calls
 * it rather than writing the comparison again.
 *
 * See `plans/OF-VIEWER-readonly-dashboard-role.md`.
 */

export const VIEWER_ROLE = "VIEWER" as const

/** Where a Viewer lands, and the only shell area it may reach. */
export const VIEWER_HOME = "/dashboard"

/**
 * Areas a Viewer may navigate to. `/change-password` is handled ahead of this
 * in `proxy.ts` so a forced password change can always complete.
 *
 * Support is deliberately absent, unlike every other client role: this account
 * was specified as dashboard-only.
 */
export const VIEWER_AREAS: readonly string[] = [VIEWER_HOME]

export function isViewerRole(role: unknown): boolean {
  return role === VIEWER_ROLE
}

/**
 * The complete set of route handlers that admit a Viewer. Everything else in
 * `app/api/v1/**` refuses it with 403, including every mutating route.
 *
 * Adding a route here is a deliberate act: it widens what a read-only account
 * can see. The contract test treats this list as the control.
 */
export const VIEWER_READ_ROUTES: readonly string[] = [
  "app/api/v1/analytics/sales-performance/route.ts",
  "app/api/v1/analytics/drill-down/route.ts",
  "app/api/v1/analytics/earliest-record/route.ts",
  "app/api/v1/branches/route.ts",
]

export type ViewerScopeInput = {
  /** From the session, never from the request. */
  organizationId: number | null | undefined
  /** From the session. When set, the Viewer is pinned to this branch. */
  branchId: number | null | undefined
  /** Whatever the query string asked for. Ignored when the Viewer is pinned. */
  requestedBranchId?: number | null
}

export type ViewerScope =
  | { organizationId: number; branchId: number | null; error?: undefined }
  | { error: string; organizationId?: undefined; branchId?: undefined }

const NO_ORGANIZATION = "Access denied: this account is not assigned to an organization"

function positiveIdOrNull(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * The organization and branch a Viewer's query runs against.
 *
 * The organization is always the session's. The branch is the session's when
 * the account is pinned, and only then falls back to the request — so a pinned
 * Viewer naming a sibling branch on the query string still reads its own.
 */
export function resolveViewerScope(input: ViewerScopeInput): ViewerScope {
  const organizationId = positiveIdOrNull(input.organizationId)
  if (!organizationId) return { error: NO_ORGANIZATION }

  const pinnedBranchId = positiveIdOrNull(input.branchId)
  if (pinnedBranchId) return { organizationId, branchId: pinnedBranchId }

  return { organizationId, branchId: positiveIdOrNull(input.requestedBranchId) }
}

/**
 * The branch id list a Viewer's query runs against, for the endpoints that take
 * one. A pinned Viewer collapses to its own branch whatever was requested; an
 * unpinned one passes its request through for the caller to validate against
 * the tenant, exactly as Head Office's is.
 */
export function resolveViewerBranchIds(input: {
  branchId: number | null | undefined
  requestedBranchIds?: ReadonlyArray<unknown>
}): number[] {
  const pinnedBranchId = positiveIdOrNull(input.branchId)
  if (pinnedBranchId) return [pinnedBranchId]

  return Array.from(new Set(
    (input.requestedBranchIds ?? [])
      .map(positiveIdOrNull)
      .filter((id): id is number => id !== null),
  ))
}

/** Whether a Viewer may pick its own branch filter, or is pinned to one. */
export function viewerMayFilterBranches(branchId: number | null | undefined): boolean {
  return positiveIdOrNull(branchId) === null
}
