import type { SystemRole } from "@/lib/server/mutation-validation"

const ROLE_LEVEL: Record<SystemRole, number> = {
  ORDER_PORTAL: 1,
  BRANCH_ADMIN: 2,
  HEAD_OFFICE: 3,
  SUPER_ADMIN: 4,
}

/**
 * Super administrators are provisioned through the bootstrap operation, never
 * through the normal user-management API. Other administrators may only
 * assign roles strictly below their own authority.
 */
export function canAssignRole(actorRole: SystemRole, requestedRole: SystemRole): boolean {
  if (requestedRole === "SUPER_ADMIN") return false
  return ROLE_LEVEL[requestedRole] < ROLE_LEVEL[actorRole]
}

/** An administrator may not manage a peer or a user above their authority. */
export function canManageUser(actorRole: SystemRole, targetRole: SystemRole): boolean {
  if (targetRole === "SUPER_ADMIN") return false
  return ROLE_LEVEL[targetRole] < ROLE_LEVEL[actorRole]
}

export function isSelfAccessChange(actorUserId: string, targetUserId: string): boolean {
  return actorUserId === targetUserId
}

export function canUseOrganization(
  actorRole: SystemRole,
  actorOrganizationId: number | null,
  requestedOrganizationId: number,
): boolean {
  return actorRole === "SUPER_ADMIN" || actorOrganizationId === requestedOrganizationId
}
