import "server-only"

import { branches } from "@/db/schema"
import { db } from "@/lib/db"
import { resolveAnalyticsBranchIds } from "@/lib/server/analytics-scope"
import { and, eq, inArray } from "drizzle-orm"

/**
 * The branch fence every product report runs behind.
 *
 * Extracted from the product performance route so the consumption-trend route
 * reads the same one rather than a second copy. Two product reports on the same
 * screen resolving branches through two functions is how one of them quietly
 * stops agreeing with the other — or stops fencing.
 *
 * The order matters and is the security property: the *allowed* set is read
 * first from the database, then `resolveAnalyticsBranchIds` intersects anything
 * the request asked for with it (and pins a branch-scoped role to its own
 * branch, a group role to its assignment set), and only then does a group
 * selection narrow it further. A request can therefore only ever subtract.
 *
 * An empty result is a refusal for the caller to make, never "no filter".
 */
export async function resolveProductBranches({
  role,
  userBranchId,
  userOrganizationId,
  organizationIds,
  requestedBranchIds,
  groupIds,
  assignedBranchIds,
}: {
  role: string
  userBranchId: unknown
  userOrganizationId: number | null
  organizationIds: number[]
  requestedBranchIds: number[]
  groupIds: number[]
  assignedBranchIds: number[] | null
}): Promise<number[]> {
  let allowedBranchQuery = db.select({ id: branches.id }).from(branches)
  if (organizationIds.length > 0) {
    allowedBranchQuery = allowedBranchQuery.where(inArray(branches.organizationId, organizationIds)) as any
  }
  const allowedBranches = await allowedBranchQuery

  let branchIds = resolveAnalyticsBranchIds({
    role,
    userBranchId,
    requestedBranchIds,
    allowedBranchIds: allowedBranches.map((branch) => branch.id),
    assignedBranchIds,
  })
  if (groupIds.length === 0) return branchIds

  let organizationCondition = organizationIds.length > 0
    ? inArray(branches.organizationId, organizationIds)
    : undefined
  if (organizationIds.length === 0 && userOrganizationId) {
    organizationCondition = eq(branches.organizationId, userOrganizationId)
  }
  const groupBranches = await db.select({ id: branches.id })
    .from(branches)
    .where(and(inArray(branches.groupId, groupIds), organizationCondition))
  const groupBranchIds = new Set(groupBranches.map((branch) => branch.id))
  branchIds = branchIds.filter((branchId) => groupBranchIds.has(branchId))
  return branchIds
}
