import { and, eq, inArray } from "drizzle-orm"

import { branches, organizations } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  MULTI_BRANCH_SCOPE_ROLES,
  getMultiBranchScope,
  isGroupApproverRole,
  resolveScopedBranchIds,
} from "@/lib/server/multi-branch-scope"

export const dynamic = "force-dynamic"

/**
 * The signed-in group user's own reach: the groups and branches an
 * administrator assigned, plus the branch list those resolve to right now.
 *
 * Restricted to the group-based roles so no other role can use it as a side
 * door into branch data.
 */
export async function GET() {
  const authError = await requireApiRole([...MULTI_BRANCH_SCOPE_ROLES])
  if (authError) return authError

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)

  const [assignments, effectiveBranchIds] = await Promise.all([
    getMultiBranchScope(scope.userId),
    resolveScopedBranchIds(db, scope.userId),
  ])

  // Defence in depth: the assignment rows are already tenant-pinned at write
  // time, but the response is re-filtered to the user's own organization so a
  // stale row can never leak another tenant's branch names.
  const effectiveBranches = effectiveBranchIds.length > 0 && scope.organizationId
    ? await db
        .select({
          id: branches.id,
          name: branches.name,
          city: branches.city,
          groupId: branches.groupId,
        })
        .from(branches)
        .where(and(
          inArray(branches.id, effectiveBranchIds),
          eq(branches.organizationId, scope.organizationId),
        ))
        .orderBy(branches.name)
    : []

  const [organization] = scope.organizationId
    ? await db
        .select({ id: organizations.id, name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, scope.organizationId))
        .limit(1)
    : [null]

  return ok({
    item: {
      organization: organization ?? null,
      role: scope.role,
      canApproveOrders: isGroupApproverRole(scope.role),
      groups: assignments.groups,
      assignedBranches: assignments.branches,
      branches: effectiveBranches,
    },
  })
}
