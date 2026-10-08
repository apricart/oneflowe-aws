import "server-only"

import { and, eq, inArray } from "drizzle-orm"

import { branches } from "@/db/schema"
import { db } from "@/lib/db"
import {
  narrowRequestedBranchIdsToGroups,
  resolveAnalyticsBranchIds,
  resolveAnalyticsOrganizationIds,
} from "@/lib/server/analytics-scope"

/**
 * The branches a per-user analytics report (`/analytics/users/performance`,
 * `/analytics/users/products`) may read for this caller.
 *
 * Both routes used to resolve this themselves and returned request-supplied
 * branch, group and organization ids unchecked, so a Head Office or Branch
 * Admin of one tenant could read another tenant's people — names, emails,
 * order references and spend — by naming its ids in the query string. This
 * goes through the same primitives every other analytics route uses: the
 * organization is the caller's own unless they are Super Admin, and whatever
 * the request names can only narrow that reach, never widen it.
 *
 * An empty result means "nothing permitted" and the caller must refuse.
 */
export async function resolveUserAnalyticsBranchIds(input: {
  role: string
  userOrganizationId: unknown
  userBranchId: unknown
  requestedOrganizationIds: number[]
  requestedBranchIds: number[]
  groupIds: number[]
  assignedBranchIds: number[] | null
}): Promise<number[]> {
  const organizationIds = resolveAnalyticsOrganizationIds({
    role: input.role,
    userOrganizationId: input.userOrganizationId,
    requestedOrganizationIds: input.requestedOrganizationIds,
  })
  if (input.role !== "SUPER_ADMIN" && organizationIds.length === 0) return []

  const allowedRows = organizationIds.length > 0
    ? await db.select({ id: branches.id }).from(branches).where(inArray(branches.organizationId, organizationIds))
    : await db.select({ id: branches.id }).from(branches)
  const allowedBranchIds = allowedRows.map((row) => row.id)
  if (allowedBranchIds.length === 0) return []

  let requestedBranchIds = input.requestedBranchIds
  if (input.groupIds.length > 0) {
    const groupRows = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(inArray(branches.groupId, input.groupIds), inArray(branches.id, allowedBranchIds)))
    requestedBranchIds = narrowRequestedBranchIdsToGroups({
      requestedBranchIds: input.requestedBranchIds,
      groupBranchIds: groupRows.map((row) => row.id),
    })
    if (requestedBranchIds.length === 0) return []
  }

  return resolveAnalyticsBranchIds({
    role: input.role,
    userBranchId: input.userBranchId,
    requestedBranchIds,
    allowedBranchIds,
    assignedBranchIds: input.assignedBranchIds,
  })
}

/**
 * Request-named branch ids, cut down to the caller's own organization.
 *
 * For routes that keep their own "no branch named means no branch filter"
 * behaviour but must not let a named id reach outside the tenant. Super Admin
 * keeps every id it names. A caller with no organization keeps none.
 */
export async function fenceBranchIdsToOrganization(input: {
  role: string
  userOrganizationId: unknown
  branchIds: number[]
}): Promise<number[]> {
  if (input.role === "SUPER_ADMIN" || input.branchIds.length === 0) return input.branchIds
  const [organizationId] = resolveAnalyticsOrganizationIds({
    role: input.role,
    userOrganizationId: input.userOrganizationId,
    requestedOrganizationIds: [],
  })
  if (!organizationId) return []
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(inArray(branches.id, input.branchIds), eq(branches.organizationId, organizationId)))
  const owned = new Set(rows.map((row) => row.id))
  return input.branchIds.filter((branchId) => owned.has(branchId))
}
