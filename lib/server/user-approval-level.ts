import "server-only"

import { and, count, eq, gt, isNull } from "drizzle-orm"

import { organizationApprovalLevels, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  USER_APPROVAL_LEVEL_AUDIT_ACTION,
  approvalLevelAssignmentRefusal,
  type ApprovalLevelOrganization,
} from "@/lib/order-approval-levels"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { systemRoleSchema } from "@/lib/server/mutation-validation"
import { canManageUser, isSelfAccessChange } from "@/lib/server/user-access-policy"

/**
 * The level a user holds among their organization's order approval levels
 * (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
 *
 * Every write that gives a user a level takes the organization row `FOR SHARE`
 * before checking the level exists; the levels PUT takes it `FOR UPDATE` before
 * checking no removed level is held. The two therefore serialise: a level can
 * never be assigned while it is being removed, nor removed while assigned.
 */

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Executor = Pick<typeof db, "select">

export type ApprovalLevelContext = ApprovalLevelOrganization & { levelCount: number }

/**
 * What the assignment rule needs to know about an organization, or null when it
 * does not exist. `lock` is for use inside a write transaction.
 */
export async function loadApprovalLevelContext(
  executor: Executor | TransactionExecutor,
  organizationId: number,
  lock = false,
): Promise<ApprovalLevelContext | null> {
  const query = executor
    .select({
      orderApprovalRequired: organizations.orderApprovalRequired,
      orderApprovalLevelsEnabled: organizations.orderApprovalLevelsEnabled,
      orderApproverRole: organizations.orderApproverRole,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
  const [organization] = lock ? await query.for("share").limit(1) : await query.limit(1)
  if (!organization) return null

  const [levels] = await executor
    .select({ value: count() })
    .from(organizationApprovalLevels)
    .where(eq(organizationApprovalLevels.organizationId, organizationId))
  return { ...organization, levelCount: Number(levels?.value ?? 0) }
}

/**
 * Why a new user of `role` in `organizationId` may not be created holding
 * `level`, or null. Called inside the user-creation transaction.
 */
export async function approvalLevelRefusalForNewUser(
  tx: TransactionExecutor,
  input: { organizationId: number | null; role: string; level: number | null },
): Promise<string | null> {
  if (input.level === null) return null
  const organization = input.organizationId === null
    ? null
    : await loadApprovalLevelContext(tx, input.organizationId, true)
  return approvalLevelAssignmentRefusal({
    role: input.role,
    organization,
    levelCount: organization?.levelCount ?? 0,
    level: input.level,
  })
}

/**
 * The levels above `keepCount` that non-deleted users of the organization still
 * hold, with how many hold each. Empty means removing them is safe. Called by
 * the levels PUT under its `FOR UPDATE` on the organization row.
 */
export async function heldRemovedApprovalLevels(
  tx: TransactionExecutor,
  organizationId: number,
  keepCount: number,
): Promise<{ level: number; users: number }[]> {
  const rows = await tx
    .select({ level: users.orderApprovalLevel, users: count() })
    .from(users)
    .where(and(
      eq(users.organizationId, organizationId),
      isNull(users.deletedAt),
      gt(users.orderApprovalLevel, keepCount),
    ))
    .groupBy(users.orderApprovalLevel)
    .orderBy(users.orderApprovalLevel)
  return rows.map((row) => ({ level: Number(row.level), users: Number(row.users) }))
}

export type SetUserApprovalLevelOutcome =
  | { kind: "not-found" }
  | { kind: "forbidden"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "saved"; changed: boolean; level: number | null }

/**
 * Super Admin or Head Office giving a user a level, or taking it away.
 *
 * The fence is the access route's: the actor must be able to manage the
 * target's role, Head Office only within its own organization, and never on its
 * own account. The organization is the target's, read from its row.
 */
export async function setUserApprovalLevel(input: {
  actor: { userId: string; role: string; organizationId: number | null }
  targetUserId: string
  level: number | null
}): Promise<SetUserApprovalLevelOutcome> {
  if (isSelfAccessChange(input.actor.userId, input.targetUserId)) {
    return { kind: "forbidden", message: "You cannot change your own approval level" }
  }
  const actorRole = systemRoleSchema.safeParse(input.actor.role)
  if (!actorRole.success) return { kind: "forbidden", message: "You cannot manage this user" }

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        role: roles.name,
        organizationId: users.organizationId,
        level: users.orderApprovalLevel,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.id, input.targetUserId), isNull(users.deletedAt)))
      .for("update", { of: users })
      .limit(1)
    if (!target) return { kind: "not-found" as const }

    // Out of Head Office's tenant reads as absent, so ids cannot be probed.
    if (actorRole.data === "HEAD_OFFICE" && (
      input.actor.organizationId === null || target.organizationId !== input.actor.organizationId
    )) {
      return { kind: "not-found" as const }
    }
    const targetRole = systemRoleSchema.safeParse(target.role)
    if (!targetRole.success || !canManageUser(actorRole.data, targetRole.data)) {
      return { kind: "forbidden" as const, message: "You cannot manage a user at this privilege level" }
    }

    if (target.level === input.level) {
      return { kind: "saved" as const, changed: false, level: target.level }
    }

    if (input.level !== null) {
      const organization = target.organizationId === null
        ? null
        : await loadApprovalLevelContext(tx, target.organizationId, true)
      const refusal = approvalLevelAssignmentRefusal({
        role: target.role,
        organization,
        levelCount: organization?.levelCount ?? 0,
        level: input.level,
      })
      if (refusal) return { kind: "refused" as const, message: refusal }
    }

    await tx
      .update(users)
      .set({ orderApprovalLevel: input.level, updatedAt: new Date() })
      .where(eq(users.id, input.targetUserId))

    await recordAuditEvent(tx, {
      action: USER_APPROVAL_LEVEL_AUDIT_ACTION,
      entity: "user",
      entityId: input.targetUserId,
      actor: { id: input.actor.userId, role: input.actor.role },
      organizationId: target.organizationId,
      before: { orderApprovalLevel: target.level },
      after: { orderApprovalLevel: input.level },
    })

    return { kind: "saved" as const, changed: true, level: input.level }
  })
}
