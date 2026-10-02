import { type NextRequest } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { branches, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import {
  systemRoleSchema,
  type SystemRole,
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
import { roleChangeRequiresSettledOrders } from "@/lib/role-change-preconditions"
import { loadRoleChangeReadiness } from "@/lib/server/role-change-readiness"
import {
  clearMultiBranchScope,
  getMultiBranchScopeIds,
  usesMultiBranchScope,
  replaceMultiBranchScope,
  validateMultiBranchScope,
} from "@/lib/server/multi-branch-scope"

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
  // A group-based role draws its reach from group/branch assignments, so a
  // single pinned branch would be meaningless and is rejected outright. Named
  // for the mechanism rather than one role: GROUP_USER reaches this too, and
  // the message used to tell a Group User it was a Group Order Portal user.
  if (usesMultiBranchScope(nextRole)) {
    return nextBranchId === null
      ? null
      : "Group-based users are not assigned a single branch"
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

type ScopeWrite =
  | { action: "none" }
  | { action: "clear" }
  | { action: "replace"; organizationId: number; groupIds: number[]; branchIds: number[] }

/**
 * Decide what happens to the multi-branch scope for this access change.
 *
 * Assignments only ever exist for the two group-based roles, so moving off one
 * clears them and every single-branch path is a no-op.
 *
 * The three outcomes, now that a user can be moved between shapes:
 *   * into a group role  — the lists are required and validated (`replace`);
 *   * group role to group role — an untouched scope carries over unchanged
 *     (`none`), so a Group User promoted to approve the same branches keeps
 *     exactly the reach it had, along with who granted it and when;
 *   * out of a group role — every assignment is deleted (`clear`).
 *
 * `clear` is why `analytics/users/list` cannot key historical attribution on
 * assignments: they are gone the moment the role changes. It keys on the
 * orders instead.
 */
async function resolveNextScope({
  targetUserId,
  targetRole,
  targetOrganizationId,
  nextRole,
  nextOrganizationId,
  inputGroupIds,
  inputBranchIds,
  organizationChanged,
}: {
  targetUserId: string
  targetRole: string
  targetOrganizationId: number | null
  nextRole: string
  nextOrganizationId: number | null
  inputGroupIds: number[] | undefined
  inputBranchIds: number[] | undefined
  organizationChanged: boolean
}): Promise<ScopeWrite | { message: string; status: number }> {
  if (!usesMultiBranchScope(nextRole)) {
    if ((inputGroupIds?.length ?? 0) > 0 || (inputBranchIds?.length ?? 0) > 0) {
      return {
        message: "Group and branch assignments apply only to the group-based roles",
        status: 400,
      }
    }
    return { action: usesMultiBranchScope(targetRole) ? "clear" : "none" }
  }

  const listsSupplied = inputGroupIds !== undefined || inputBranchIds !== undefined
  const becomingGroupRole = !usesMultiBranchScope(targetRole)
  // An untouched scope is left exactly as it is. Revalidating it on every
  // unrelated access edit (an isActive toggle, say) would let an unrelated
  // later change — a deleted group, for instance — block that edit.
  if (!listsSupplied && !organizationChanged && !becomingGroupRole) {
    return { action: "none" }
  }

  const existing = await getMultiBranchScopeIds(targetUserId, targetOrganizationId)
  const groupIds = inputGroupIds ?? existing.groupIds
  const branchIds = inputBranchIds ?? existing.branchIds

  const scopeError = await validateMultiBranchScope({
    organizationId: nextOrganizationId,
    groupIds,
    branchIds,
  })
  if (scopeError) return scopeError

  return {
    action: "replace",
    organizationId: nextOrganizationId as number,
    groupIds,
    branchIds,
  }
}

async function applyResolvedScope(
  tx: any,
  scopeResolution: Awaited<ReturnType<typeof resolveNextScope>>,
  targetUserId: string,
  actorUserId: string,
) {
  if ("message" in scopeResolution || scopeResolution.action === "none") return
  if (scopeResolution.action === "clear") {
    await clearMultiBranchScope(tx, targetUserId)
    return
  }
  await replaceMultiBranchScope(tx, {
    userId: targetUserId,
    organizationId: scopeResolution.organizationId,
    groupIds: scopeResolution.groupIds,
    branchIds: scopeResolution.branchIds,
    createdByUserId: actorUserId,
  })
}

function resolveAccessValues(input: any, target: any, targetRole: SystemRole, actorRole: unknown) {
  const nextRole: SystemRole = input.role ?? targetRole
  const parsedActorRole = systemRoleSchema.safeParse(actorRole)
  if (input.role !== undefined && (!parsedActorRole.success || !canAssignRole(parsedActorRole.data, nextRole))) {
    return { message: "You cannot assign this role", status: 403 } as const
  }
  if (input.budgetAllocationEnabled !== undefined && nextRole !== "GROUP_USER") {
    return { message: "Budget allocation access applies only to Group Users", status: 400 } as const
  }
  return {
    nextRole,
    nextBudgetAllocationEnabled: nextRole === "GROUP_USER"
      ? input.budgetAllocationEnabled ?? (targetRole === "GROUP_USER" && target.budgetAllocationEnabled)
      : false,
    nextOrganizationId: input.organizationId !== undefined ? input.organizationId : target.organizationId,
    nextBranchId: input.branchId !== undefined ? input.branchId : target.branchId,
  }
}

/**
 * Why this role change cannot proceed, or null when it may.
 *
 * Only an actual role change is examined: an administrator toggling MFA or
 * moving a user's branch is not moving them between portals, and making that
 * wait on an unrelated pending order would obstruct with nothing behind it.
 *
 * A mirrored account (`external_source` set) is **not** refused here. It was
 * while the legacy K-Electric platform was still the source of truth, because
 * `sync:ke` recreates any role it finds missing for a person who still has a
 * branch-pinned account and would therefore have made a third account out of a
 * switched pair. That migration is complete and the sync is not run again, so
 * the refusal was removed; the cosmetic consequence — a `-ba`/`-op` username
 * suffix that no longer matches the role — is surfaced in the dialog instead.
 * Mirrored accounts still cannot sign in by email, which is unrelated to role
 * and untouched by this (`lib/auth-options.ts`).
 */
async function getRoleChangeBlock({
  targetUserId,
  targetRole,
  nextRole,
}: {
  targetUserId: string
  targetRole: SystemRole
  nextRole: SystemRole
}): Promise<string | null> {
  if (!roleChangeRequiresSettledOrders(targetRole, nextRole)) return null

  // The dialog previews this through GET, but the dialog is not the control: an
  // order can settle or be raised between the preview and the submit, so the
  // decision is taken here, immediately before the write.
  const readiness = await loadRoleChangeReadiness(targetUserId)
  return readiness.ready ? null : readiness.reason
}

/**
 * Whether this user's role may be changed right now, and why not if not.
 *
 * Read-only preview for the user-management dialog, so an administrator sees
 * the obstruction before filling the form rather than after submitting it. It
 * decides nothing: `PATCH` re-evaluates the same rule immediately before the
 * write, because an order can settle or be raised in between.
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
    .where(and(eq(users.id, targetUserId), isNull(users.deletedAt)))
    .limit(1)

  if (!target) return error("User not found", 404)

  const parsedTargetRole = systemRoleSchema.safeParse(target.role)
  if (!parsedTargetRole.success) return error("Target user has an invalid role", 409)

  // Same fence as the write: an administrator may only look at a user they
  // could actually manage, so this cannot be used to probe another tenant.
  const targetAccessError = getTargetAccessError(scope, target, parsedTargetRole.data)
  if (targetAccessError) return error(targetAccessError, 403)

  if (isSelfAccessChange(scope.userId, targetUserId)) {
    return ok({
      item: {
        roleChangeAllowed: false,
        reason: "You cannot change your own access level",
        blockers: null,
      },
    })
  }

  // The approver advisory depends on where the user is going, and the preview
  // does not know that yet. It is reported for "leaving GROUP_USER", which is
  // the only transition that can produce it.
  const readiness = await loadRoleChangeReadiness(targetUserId, {
    currentRole: parsedTargetRole.data,
    nextRole: parsedTargetRole.data === "GROUP_USER" ? "ORDER_PORTAL" : parsedTargetRole.data,
  })

  return ok({
    item: {
      roleChangeAllowed: readiness.ready,
      reason: readiness.ready ? null : readiness.reason,
      blockers: readiness.ready ? null : readiness.blockers,
      // Advisory, never a refusal. Set only when a Group User would stop being
      // able to decide orders that are still awaiting one.
      ordersAwaitingApproval: readiness.ordersAwaitingApproval ?? 0,
    },
  })
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
      budgetAllocationEnabled: users.budgetAllocationEnabled,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    // A deleted account keeps its rows for the audit trail but is not
    // administrable: changing its role would resurrect it into every report
    // keyed on a current role. Answered as 404, like any other absent row.
    .where(and(eq(users.id, targetUserId), isNull(users.deletedAt)))
    .limit(1)

  if (!target) return error("User not found", 404)

  const parsedTargetRole = systemRoleSchema.safeParse(target.role)
  if (!parsedTargetRole.success) return error("Target user has an invalid role", 409)
  const targetRole = parsedTargetRole.data

  const targetAccessError = getTargetAccessError(scope, target, targetRole)
  if (targetAccessError) return error(targetAccessError, 403)

  const accessValues = resolveAccessValues(input, target, targetRole, scope.role)
  if ("message" in accessValues && accessValues.message) return error(accessValues.message, accessValues.status)
  const { nextRole, nextBudgetAllocationEnabled, nextOrganizationId, nextBranchId } = accessValues

  const assignmentError = await getAssignmentError({ scope, nextRole, nextOrganizationId, nextBranchId })
  if (assignmentError) return error(assignmentError, 400)

  // Decided inside the write transaction below, not here — see
  // `getRoleChangeBlock`. Nothing reads it at this point.
  const roleChangeRequested = roleChangeRequiresSettledOrders(targetRole, nextRole)

  const scopeResolution = await resolveNextScope({
    targetUserId,
    targetRole,
    targetOrganizationId: target.organizationId,
    nextRole,
    nextOrganizationId,
    inputGroupIds: input.groupIds,
    inputBranchIds: input.branchIds,
    organizationChanged: nextOrganizationId !== target.organizationId,
  })
  if ("message" in scopeResolution) {
    return error(scopeResolution.message, scopeResolution.status)
  }
  const resolvedRoleId = await resolveRoleId(input.role, nextRole)
  if (resolvedRoleId === null) return error("Invalid role", 400)
  const nextRoleId = resolvedRoleId

  const outcome = await db.transaction(async (tx) => {
    // The lifecycle rule is decided here, on the transaction, immediately before
    // the write. Deciding it earlier would be a read-then-write across two
    // statements: an order raised in between would slip past a rule that says
    // there are none.
    if (roleChangeRequested) {
      const readiness = await loadRoleChangeReadiness(
        targetUserId,
        { currentRole: targetRole, nextRole },
        tx,
      )
      if (!readiness.ready) return { kind: "blocked" as const, reason: readiness.reason }
    }

    const [updatedUser] = await tx
      .update(users)
      .set({
        roleId: nextRoleId,
        organizationId: input.organizationId !== undefined ? nextOrganizationId : undefined,
        branchId: input.branchId !== undefined ? nextBranchId : undefined,
        isActive: input.isActive,
        mfaEnabled: input.mfaEnabled,
        budgetAllocationEnabled: nextBudgetAllocationEnabled,
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
        budgetAllocationEnabled: users.budgetAllocationEnabled,
      })

    await applyResolvedScope(tx, scopeResolution, targetUserId, scope.userId)

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
        previousBudgetAllocationEnabled: target.budgetAllocationEnabled,
        nextBudgetAllocationEnabled,
      },
      success: true,
    })

    return { kind: "updated" as const, user: updatedUser }
  })

  if (outcome.kind === "blocked") return error(outcome.reason, 409)
  const updated = outcome.user

  await invalidateSessionValidationCache(targetUserId)
  await invalidateByPrefix("users")

  return ok({ item: updated })
}
