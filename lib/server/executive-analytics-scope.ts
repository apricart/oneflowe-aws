import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { branches, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { isExecutiveAnalyticsRole } from "@/lib/executive-analytics"
import {
  normalizePositiveIds,
  parseRequestedOrganizationIds,
  resolveAnalyticsBranchIds,
  resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"
import { scopedCacheKey } from "@/lib/cache-utils"

/**
 * The authorization boundary for the Executive Analytics Center.
 *
 * Every figure the Center returns — a KPI, a chart point, a heatmap cell, a
 * branch name in a tooltip, a row of the attention list — is drawn from the
 * branch set this module resolves, and that set is derived from the caller's
 * own user row, never from the request. A query parameter can only ever narrow
 * it: `organizationId` and `branchIds` are intersected with what the caller
 * already had, so no value a client can send widens the answer.
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
 *   everything else is refused before a single query runs. A branch-scoped or
 *                 group-scoped role has no Executive Analytics surface at all;
 *                 there is no "hidden chart" path where the data is fetched and
 *                 then dropped in the browser.
 *
 * An empty resolved branch set is a deny, never "everything": callers must
 * return the empty payload rather than fall through to an unfiltered query.
 */

export type ExecutiveScopeDenial = { ok: false; error: string; status: number }

export type ExecutiveScope = {
  ok: true
  role: "SUPER_ADMIN" | "HEAD_OFFICE"
  userId: string
  /** Empty only for a SUPER_ADMIN that selected no tenant. */
  organizationIds: number[]
  /**
   * The branches every query is fenced to. `null` only for a SUPER_ADMIN with
   * no tenant and no branch selection, where "all branches" is the correct and
   * authorized answer. Never null for HEAD_OFFICE.
   */
  branchIds: number[] | null
  /** The tenant's full branch list, for filter UI and share-of-total maths. */
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

export async function resolveExecutiveScope(
  session: unknown,
  searchParams: URLSearchParams,
): Promise<ExecutiveScopeResult> {
  const sessionUser = (session as { user?: { id?: unknown; role?: unknown } } | null)?.user
  const userId = sessionUser?.id
  if (typeof userId !== "string" || userId.length === 0) {
    return { ok: false, error: "Unauthorized", status: 401 }
  }

  const caller = await loadCallerContext(userId, sessionUser?.role)
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

  if (caller.role === "HEAD_OFFICE" && organizationIds.length === 0) {
    // A head-office user with no tenant on its row has no data to see, and
    // must not fall through to the unrestricted branch list.
    return { ok: false, error: "Organization context missing", status: 403 }
  }

  const allowedBranchIds = await loadTenantBranchIds(organizationIds)

  const requestedBranchIds = normalizePositiveIds(
    (searchParams.get("branchIds") || "").split(",").filter(Boolean),
  )

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

  // Requested branches are intersected with the tenant's own list, so an id
  // belonging to another organization simply drops out.
  const branchIds = resolveAnalyticsBranchIds({
    role: caller.role,
    userBranchId: caller.branchId,
    requestedBranchIds,
    allowedBranchIds,
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
