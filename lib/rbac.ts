export type Role = "SUPER_ADMIN" | "HEAD_OFFICE" | "GROUP_USER" | "BRANCH_ADMIN" | "GROUP_ORDER_PORTAL" | "ORDER_PORTAL"

/**
 * Validate if a string is a valid role
 */
export function isValidRole(role: unknown): role is Role {
  if (typeof role !== 'string') return false
  const validRoles: Role[] = ['SUPER_ADMIN', 'HEAD_OFFICE', 'GROUP_USER', 'BRANCH_ADMIN', 'GROUP_ORDER_PORTAL', 'ORDER_PORTAL']
  return validRoles.includes(role as Role)
}

/**
 * Require specific role for access
 * @throws Error with status 403 if role not allowed
 */
export function requireRole(current: Role, allowed: Role[]) {
  // Validate inputs
  if (!current || !isValidRole(current)) {
    const err: any = new Error("Invalid role provided")
    err.status = 400
    throw err
  }

  if (!Array.isArray(allowed) || allowed.length === 0) {
    const err: any = new Error("Invalid allowed roles configuration")
    err.status = 500
    throw err
  }

  // Validate all allowed roles
  const invalidRoles = allowed.filter(role => !isValidRole(role))
  if (invalidRoles.length > 0) {
    console.error('[RBAC] Invalid roles in allowed list:', invalidRoles)
    const err: any = new Error("Invalid role configuration")
    err.status = 500
    throw err
  }

  if (!allowed.includes(current)) {
    const err: any = new Error("Forbidden: Insufficient permissions")
    err.status = 403
    err.details = {
      currentRole: current,
      requiredRoles: allowed
    }
    throw err
  }
}

/**
 * Check if a role has permission (non-throwing version)
 */
export function hasRole(current: Role | undefined | null, allowed: Role[]): boolean {
  try {
    if (!current || !isValidRole(current)) return false
    if (!Array.isArray(allowed) || allowed.length === 0) return false
    return allowed.includes(current)
  } catch (error) {
    console.error('[RBAC] Error checking role permission:', error)
    return false
  }
}

/**
 * Role hierarchy levels (higher number = more permissions)
 */
// Levels are compared only relative to one another, so slotting the two
// group-based roles into the scale renumbers it without changing any existing
// pairwise relationship. GROUP_USER sits above BRANCH_ADMIN because it decides
// orders across many branches rather than one.
const ROLE_HIERARCHY: Record<Role, number> = {
  'ORDER_PORTAL': 1,
  'GROUP_ORDER_PORTAL': 2,
  'BRANCH_ADMIN': 3,
  'GROUP_USER': 4,
  'HEAD_OFFICE': 5,
  'SUPER_ADMIN': 6
}

/**
 * Check if one role has equal or higher permissions than another
 */
export function hasEqualOrHigherRole(current: Role, required: Role): boolean {
  try {
    if (!isValidRole(current) || !isValidRole(required)) {
      return false
    }
    return ROLE_HIERARCHY[current] >= ROLE_HIERARCHY[required]
  } catch (error) {
    console.error('[RBAC] Error comparing role hierarchy:', error)
    return false
  }
}

/**
 * Get all roles with equal or lower permissions
 */
export function getLowerOrEqualRoles(current: Role): Role[] {
  try {
    if (!isValidRole(current)) {
      return []
    }

    const currentLevel = ROLE_HIERARCHY[current]
    return (Object.keys(ROLE_HIERARCHY) as Role[]).filter(
      role => ROLE_HIERARCHY[role] <= currentLevel
    )
  } catch (error) {
    console.error('[RBAC] Error getting lower roles:', error)
    return []
  }
}

/**
 * Require minimum role level
 */
export function requireMinimumRole(current: Role, minimum: Role) {
  if (!isValidRole(current)) {
    const err: any = new Error("Invalid current role")
    err.status = 400
    throw err
  }

  if (!isValidRole(minimum)) {
    const err: any = new Error("Invalid minimum role configuration")
    err.status = 500
    throw err
  }

  if (!hasEqualOrHigherRole(current, minimum)) {
    const err: any = new Error("Forbidden: Insufficient role level")
    err.status = 403
    err.details = {
      currentRole: current,
      minimumRole: minimum,
      currentLevel: ROLE_HIERARCHY[current],
      requiredLevel: ROLE_HIERARCHY[minimum]
    }
    throw err
  }
}
