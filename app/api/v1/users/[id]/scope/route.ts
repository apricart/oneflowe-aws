import { type NextRequest } from "next/server"
import { eq } from "drizzle-orm"

import { roles, users } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  getMultiBranchScope,
  usesMultiBranchScope,
  resolveScopedBranchIds,
} from "@/lib/server/multi-branch-scope"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

/**
 * Read the multi-branch scope of a Group Order Portal user.
 *
 * Writes go through PATCH /api/v1/users/[id]/access alongside the rest of the
 * administrative access fields, so there is exactly one place that can widen a
 * user's reach.
 */
export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (authError) return authError

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)

  const { id: targetUserId } = await props.params

  const [target] = await db
    .select({
      id: users.id,
      role: roles.name,
      organizationId: users.organizationId,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, targetUserId))
    .limit(1)

  if (!target) return error("User not found", 404)

  // Head Office administrators stay inside their own tenant.
  if (scope.role !== "SUPER_ADMIN" && target.organizationId !== scope.organizationId) {
    return error("You can only view users in your organization", 403)
  }

  if (!usesMultiBranchScope(target.role)) {
    return ok({ item: { groups: [], branches: [], effectiveBranchIds: [] } })
  }

  const [assignments, effectiveBranchIds] = await Promise.all([
    getMultiBranchScope(targetUserId),
    resolveScopedBranchIds(db, targetUserId),
  ])

  return ok({
    item: {
      groups: assignments.groups,
      branches: assignments.branches,
      effectiveBranchIds,
    },
  })
}
