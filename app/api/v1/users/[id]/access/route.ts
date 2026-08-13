import { type NextRequest } from "next/server"
import { and, eq } from "drizzle-orm"
import { branches, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import {
  systemRoleSchema,
  userAccessUpdateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import {
  canAssignRole,
  canManageUser,
  canUseOrganization,
  isSelfAccessChange,
} from "@/lib/server/user-access-policy"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

function getTargetAccessError(scope: NonNullable<Awaited<ReturnType<typeof getRequestScope>>>, target: any, targetRole: any) {
  if (!canManageUser(scope.role, targetRole)) {
    return "You cannot manage a user at this privilege level"
  }
  if (scope.role === "HEAD_OFFICE" && (
    !scope.organizationId || target.organizationId !== scope.organizationId
  )) {
    return "You can only manage users in your organization"
  }
  return null
}

async function getAssignmentError({
  scope,
  nextRole,
  nextOrganizationId,
  nextBranchId,
}: {
  scope: NonNullable<Awaited<ReturnType<typeof getRequestScope>>>
  nextRole: string
  nextOrganizationId: number | null
  nextBranchId: number | null
}) {
  if (nextOrganizationId && !canUseOrganization(scope.role, scope.organizationId, nextOrganizationId)) {
    return "Tenant reassignment is not permitted"
  }
  if (!nextOrganizationId) return "An organization is required for this role"
  const [organization] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, nextOrganizationId))
    .limit(1)
  if (!organization) return "Invalid organization"
  if (nextRole === "HEAD_OFFICE") {
    return nextBranchId === null ? null : "Head Office users cannot be assigned to a branch"
  }
  if (!["BRANCH_ADMIN", "ORDER_PORTAL"].includes(nextRole)) return null
  if (!nextBranchId) return "A branch is required for this role"
  const [branch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(
      eq(branches.id, nextBranchId),
      eq(branches.organizationId, nextOrganizationId),
    ))
    .limit(1)
  return branch ? null : "Branch does not belong to the selected organization"
}

async function resolveRoleId(inputRole: string | undefined, nextRole: string) {
  if (inputRole === undefined) return undefined
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, nextRole))
    .limit(1)
  return role?.id ?? null
}

/**
 * Administrative access changes are intentionally isolated from profile edits.
 * This route is the only HTTP operation allowed to change a user's role,
 * organization, branch, active state, or administrative MFA state.
 */
export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> },
) {
  const authError = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (authError) return authError

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)

  const { id: targetUserId } = await props.params
  if (isSelfAccessChange(scope.userId, targetUserId)) {
    return error("You cannot change your own access level", 403)
  }

  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = userAccessUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const input = parsedBody.data

  const [target] = await db
    .select({
      id: users.id,
      roleId: users.roleId,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, targetUserId))
    .limit(1)

  if (!target) return error("User not found", 404)

  const parsedTargetRole = systemRoleSchema.safeParse(target.role)
  if (!parsedTargetRole.success) return error("Target user has an invalid role", 409)
  const targetRole = parsedTargetRole.data

  const targetAccessError = getTargetAccessError(scope, target, targetRole)
  if (targetAccessError) return error(targetAccessError, 403)

  const nextRole = input.role ?? targetRole
  if (input.role !== undefined && !canAssignRole(scope.role, nextRole)) {
    return error("You cannot assign this role", 403)
  }

  const nextOrganizationId = input.organizationId !== undefined
    ? input.organizationId
    : target.organizationId
  const nextBranchId = input.branchId !== undefined
    ? input.branchId
    : target.branchId

  const assignmentError = await getAssignmentError({ scope, nextRole, nextOrganizationId, nextBranchId })
  if (assignmentError) return error(assignmentError, 400)
  const resolvedRoleId = await resolveRoleId(input.role, nextRole)
  if (resolvedRoleId === null) return error("Invalid role", 400)
  const nextRoleId = resolvedRoleId

  const [updated] = await db.transaction(async (tx) => {
    const [updatedUser] = await tx
      .update(users)
      .set({
        roleId: nextRoleId,
        organizationId: input.organizationId !== undefined ? nextOrganizationId : undefined,
        branchId: input.branchId !== undefined ? nextBranchId : undefined,
        isActive: input.isActive,
        mfaEnabled: input.mfaEnabled,
        sessionVersion: target.sessionVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetUserId))
      .returning({
        id: users.id,
        roleId: users.roleId,
        organizationId: users.organizationId,
        branchId: users.branchId,
        isActive: users.isActive,
        mfaEnabled: users.mfaEnabled,
      })

    await tx.delete(sessions).where(eq(sessions.userId, targetUserId))
    await tx.insert(systemLogs).values({
      userId: scope.userId,
      userRole: scope.role,
      organizationId: scope.organizationId,
      branchId: scope.branchId ?? undefined,
      action: "USER_ACCESS_UPDATE",
      resourceType: "user",
      resourceId: targetUserId,
      details: {
        changedFields: Object.keys(input),
        previousRole: targetRole,
        nextRole,
        previousOrganizationId: target.organizationId,
        nextOrganizationId,
        previousBranchId: target.branchId,
        nextBranchId,
      },
      success: true,
    })

    return [updatedUser]
  })

  await invalidateSessionValidationCache(targetUserId)
  await invalidateByPrefix("users")

  return ok({ item: updated })
}
