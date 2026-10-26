import type { SystemRole } from "@/lib/server/mutation-validation"

// Mirrors ROLE_HIERARCHY in `lib/rbac.ts`. VIEWER sits at the floor: it can act
// on nothing, so every acting role outranks it and both administrators who may
// manage users (`USER_MANAGEMENT_ROLES`) may assign it.
//
// ORDER_DESK sits above HEAD_OFFICE so that only Super Admin may create or
// manage one: it is Apricart staff working across tenants, never a tenant's
// own user. See `lib/order-desk-access.ts`.
const ROLE_LEVEL: Record<SystemRole, number> = {
  VIEWER: 1,
  ORDER_PORTAL: 2,
  GROUP_ORDER_PORTAL: 3,
  BRANCH_ADMIN: 4,
  GROUP_USER: 5,
  HEAD_OFFICE: 6,
  ORDER_DESK: 7,
  // Same reasoning as ORDER_DESK: Apricart's own cross-tenant staff, so only
  // Super Admin may create or manage one (`lib/apricart-executive-access.ts`).
  APRICART_EXECUTIVE: 7,
  // And again: Apricart's warehouse staff (`lib/warehouse-access.ts`).
  WAREHOUSE: 7,
  // And Apricart's support agents (`lib/apricart-support-access.ts`).
  APRICART_SUPPORT: 7,
  // And Apricart's riders (`lib/rider-access.ts`). Warehouse may create them
  // too via rider-ops; level 7 keeps Head Office from assigning the role.
  RIDER: 7,
  // And Apricart finance staff (`lib/finance-access.ts`).
  FINANCE: 7,
  SUPER_ADMIN: 8,
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
