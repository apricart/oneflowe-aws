import { viewerReadRole } from "@/lib/viewer-access"
import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { branches, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { isExecutiveAnalyticsRole, type ExecutiveAnalyticsRole } from "@/lib/executive-analytics"
import { EXECUTIVE_MAX_ID_FILTERS } from "@/lib/executive-analytics-request"
import {
  isMultiBranchAnalyticsRole,
  narrowRequestedBranchIdsToGroups,
  normalizePositiveIds,
  parseRequestedOrganizationIds,
  resolveAnalyticsBranchIds,
  resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { scopedCacheKey } from "@/lib/cache-utils"

/**
 * The authorization boundary for the Executive Analytics Center.
 *
 * Every figure the Center returns — a KPI, a chart point, a heatmap cell, a
 * branch name in a tooltip, a row of the attention list — is drawn from the
 * branch set this module resolves, and that set is derived from the caller's
 * own user row, never from the request. A query parameter can only ever narrow
 * it: `organizationId`, `branchIds` and `groupIds` are intersected with what
 * the caller already had, so no value a client can send widens the answer.
 *
 * A group is a set of branches, so `groupIds` is resolved *here*, into the
 * branch set, rather than left as an order-level filter downstream. That is
 * what makes the budget side, the branch picker and every label lookup agree
 * with the order side about which branches are on screen: all of them read
 * `branchIds`, and none of them has to know a group was involved.
 *
 * The rules, and why each exists:
 *
 *   SUPER_ADMIN   is global by definition, so `organizationIds` may be empty
 *                 (meaning "no tenant restriction") and `branchIds` may be null
 *                 (meaning "no branch restriction"). Selecting a tenant narrows.
 *
 *   HEAD_OFFICE   is pinned to the organization on its own user row. A
 *                 requested `organizationId` is discarded outright by
 *                 `resolveAnalyticsOrganizationIds`, and the branch set is
 *                 re-read from `branches` for that tenant — so a branch id from
 *                 another tenant intersects to nothing rather than to itself.
 *
 *   GROUP_USER    is pinned to its tenant the same way, but its branch set is
 *                 not the tenant's: it is the live union of its assigned
 *                 groups' member branches and its individually assigned
 *                 branches (`resolveScopedBranchIds`), intersected with the
 *                 tenant's list so a stale assignment on another tenant's
 *                 branch contributes nothing. A requested `branchIds` narrows
 *                 within that set. No assignments means no branches, and no
 *                 branches is a refusal — never the tenant.
 *
 *   everything else is refused before a single query runs. A single-branch
 *                 role and the ordering group role have no Executive Analytics
 *                 surface at all; there is no "hidden chart" path where the
 *                 data is fetched and then dropped in the browser.
 *
 * An empty resolved branch set is a deny, never "everything": callers must
 * return the empty payload rather than fall through to an unfiltered query.
 */

export type ExecutiveScopeDenial = { ok: false; error: string; status: number }

export type ExecutiveScope = {
  ok: true
  role: ExecutiveAnalyticsRole
  userId: string
  /** Empty only for a SUPER_ADMIN that selected no tenant. */
  organizationIds: number[]
  /**
   * The branches every query is fenced to. `null` only for a SUPER_ADMIN with
   * no tenant and no branch selection, where "all branches" is the correct and
   * authorized answer. Never null for HEAD_OFFICE or GROUP_USER.
   */
  branchIds: number[] | null
  /**
   * Every branch the caller may name, before any request-side narrowing: the
   * tenant's full list for the tenant-wide roles, the assigned set for the
   * multi-branch approver. For filter UI and share-of-total maths.
   */
  allowedBranchIds: number[]
}

export type ExecutiveScopeResult = ExecutiveScope | ExecutiveScopeDenial

/**
 * The caller's real role and tenant, read from the database rather than taken
 * from the session claim. A JWT is reissued on role change but may be older
 * than a demotion; the user row is the current truth.
 */
async function loadCallerContext(userId: string, fallbackRole: unknown) {
  const [row] = await db
    .select({
      organizationId: users.organizationId,
      branchId: users.branchId,
      roleName: roles.name,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)

  const rawRole = row?.roleName ?? (typeof fallbackRole === "string" ? fallbackRole : "")
  return {
    role: rawRole.toUpperCase().replace(/\s+/g, "_"),
    organizationId: row?.organizationId ?? null,
    branchId: row?.branchId ?? null,
  }
}

async function loadTenantBranchIds(organizationIds: number[]): Promise<number[]> {
  const rows = organizationIds.length > 0
    ? await db
      .select({ id: branches.id })
      .from(branches)
      .where(inArray(branches.organizationId, organizationIds))
    : await db.select({ id: branches.id }).from(branches)
  return rows.map((row) => row.id)
}

/**
 * The member branches of the selected groups, read inside the tenant fence.
 *
 * The tenant predicate is applied here as well as in the intersection that
 * follows, so a group id belonging to another organization matches no branch
 * at all rather than matching branches the later intersection then drops —
 * the two guards agree, and neither is the only one.
 */
async function loadGroupBranchIds(groupIds: number[], organizationIds: number[]): Promise<number[]> {
  const conditions = [
    inArray(branches.groupId, groupIds),
    organizationIds.length > 0 ? inArray(branches.organizationId, organizationIds) : undefined,
  ].filter(Boolean)
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(conditions.length > 1 ? and(...conditions) : conditions[0])
  return rows.map((row) => row.id)
}

export async function resolveExecutiveScope(
  session: unknown,
  searchParams: URLSearchParams,
): Promise<ExecutiveScopeResult> {
  const sessionUser = (session as { user?: { id?: unknown; role?: unknown } } | null)?.user
  const userId = sessionUser?.id
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, error: "Unauthorized", status: 401 }
  }

  // Every caller of this resolver is a GET handler (pinned by
  // `lib/viewer-access.test.ts`), so an organization-wide Viewer reads these
  // reports as Head Office does; a pinned one maps to no role and is refused.
  const loaded = await loadCallerContext(userId, sessionUser?.role)
  const caller = { ...loaded, role: viewerReadRole(loaded) ?? "" }
  if (!isExecutiveAnalyticsRole(caller.role)) {
    return { ok: false, error: "Forbidden: Insufficient permissions", status: 403 }
  }

  const requestedOrganizationIds = parseRequestedOrganizationIds({
    organizationIds: searchParams.get("organizationIds"),
    organizationId: searchParams.get("organizationId"),
  })

  // For HEAD_OFFICE this discards whatever was requested and returns the
  // session tenant; for SUPER_ADMIN it validates the requested ids.
  const organizationIds = resolveAnalyticsOrganizationIds({
    role: caller.role,
    userOrganizationId: caller.organizationId,
    requestedOrganizationIds,
  })

  if (caller.role !== "SUPER_ADMIN" && organizationIds.length === 0) {
    // A tenant-pinned user with no tenant on its row has no data to see, and
    // must not fall through to the unrestricted branch list.
    return { ok: false, error: "Organization context missing", status: 403 }
  }

  const tenantBranchIds = await loadTenantBranchIds(organizationIds)

  // The approver's reach is its assignment rows, read on the server and never
  // from the request. `null` for every other role, so their path below keeps
  // its shape; an empty array is a deny and resolves to nothing further down.
  const assignedBranchIds = isMultiBranchAnalyticsRole(caller.role)
    ? await resolveScopedBranchIds(db, userId)
    : null

  // What the caller may name at all: the tenant for the tenant-wide roles, the
  // assignments — re-checked against the tenant — for the approver.
  const allowedBranchIds = assignedBranchIds === null
    ? tenantBranchIds
    : assignedBranchIds.filter((branchId) => tenantBranchIds.includes(branchId))

  const namedBranchIds = normalizePositiveIds(
    (searchParams.get("branchIds") || "").split(",").filter(Boolean),
  )
  // Capped exactly as the filter parser caps the same parameter, so the fence
  // and the downstream filter never disagree about which groups were asked
  // for — and so no request can push an unbounded IN list at the database.
  const requestedGroupIds = normalizePositiveIds(
    (searchParams.get("groupIds") || "").split(",").filter(Boolean),
  ).slice(0, EXECUTIVE_MAX_ID_FILTERS)

  // A group selection becomes the branch selection it stands for, and takes
  // the same path from here on. Nothing left after the narrowing is a refusal,
  // not an unfiltered request: the resolver below reads an empty request as
  // "every branch allowed", which is the one thing a group must never mean.
  const requestedBranchIds = requestedGroupIds.length > 0
    ? narrowRequestedBranchIdsToGroups({
      requestedBranchIds: namedBranchIds,
      groupBranchIds: await loadGroupBranchIds(requestedGroupIds, organizationIds),
    })
    : namedBranchIds

  if (requestedGroupIds.length > 0 && requestedBranchIds.length === 0) {
    return { ok: false, error: "No branches in scope", status: 403 }
  }

  const isUnrestrictedSuperAdmin = caller.role === "SUPER_ADMIN"
    && organizationIds.length === 0
    && requestedBranchIds.length === 0

  if (isUnrestrictedSuperAdmin) {
    return {
      ok: true,
      role: caller.role,
      userId,
      organizationIds,
      branchIds: null,
      allowedBranchIds,
    }
  }

  // Requested branches are intersected with the tenant's own list — and, for
  // the approver, with its assignments — so an id belonging to another
  // organization or to an unassigned branch simply drops out.
  const branchIds = resolveAnalyticsBranchIds({
    role: caller.role,
    userBranchId: caller.branchId,
    requestedBranchIds,
    allowedBranchIds: tenantBranchIds,
    assignedBranchIds,
  })

  if (branchIds.length === 0) {
    return { ok: false, error: "No branches in scope", status: 403 }
  }

  return {
    ok: true,
    role: caller.role,
    userId,
    organizationIds,
    branchIds,
    allowedBranchIds,
  }
}

/**
 * A cache key that cannot collide across tenants.
 *
 * The resolved organization and branch sets are part of the key, not the
 * requested ones, so two callers only ever share a cached entry when the server
 * has already decided they may see exactly the same rows. Filters and the
 * selected metric are appended for correctness rather than for isolation.
 */
export function executiveCacheKey(
  prefix: string,
  scope: ExecutiveScope,
  params: Record<string, string | number | null | undefined>,
): string {
  return scopedCacheKey(prefix, { role: scope.role }, {
    orgs: scope.organizationIds.length > 0 ? scope.organizationIds.join(".") : "all",
    branches: scope.branchIds ? scope.branchIds.join(".") : "all",
    ...params,
  })
}

/** The tenant fence, as drizzle conditions, for any query rooted at `orders`. */
export function branchScopeCondition(scope: ExecutiveScope, column: Parameters<typeof inArray>[0]) {
  return scope.branchIds ? inArray(column, scope.branchIds) : undefined
}

/** Branch rows the caller may name, for filter dropdowns and label lookups. */
export async function loadScopedBranches(scope: ExecutiveScope) {
  const conditions = [
    scope.organizationIds.length > 0 ? inArray(branches.organizationId, scope.organizationIds) : undefined,
    scope.branchIds ? inArray(branches.id, scope.branchIds) : undefined,
  ].filter(Boolean)

  return db
    .select({
      id: branches.id,
      name: branches.name,
      organizationId: branches.organizationId,
      groupId: branches.groupId,
      baselineBudgetCents: branches.baselineBudgetCents,
    })
    .from(branches)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(branches.name)
}
