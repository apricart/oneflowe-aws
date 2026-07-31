import type { Role } from "@/lib/rbac"

export const BRANCH_CREATION_ROLES: Role[] = ["SUPER_ADMIN", "HEAD_OFFICE"]

type BranchCreationScope = {
  role: Role
  organizationId: number | null
}

type BranchCreationAccess =
  | { allowed: true; organizationId: number }
  | { allowed: false; status: 400 | 403; message: string }

/**
 * Resolves the tenant that owns a newly-created branch.
 *
 * Super Admins may choose a tenant. Head Office users are always bound to the
 * organization stored in their server-side request scope, and a mismatched
 * client value is rejected instead of being trusted or silently accepted.
 */
export function resolveBranchCreationAccess(
  scope: BranchCreationScope,
  requestedOrganizationId: number,
): BranchCreationAccess {
  if (!Number.isInteger(requestedOrganizationId) || requestedOrganizationId <= 0) {
    return {
      allowed: false,
      status: 400,
      message: "Organization ID must be a positive integer",
    }
  }

  if (scope.role === "SUPER_ADMIN") {
    return { allowed: true, organizationId: requestedOrganizationId }
  }

  if (scope.role !== "HEAD_OFFICE") {
    return {
      allowed: false,
      status: 403,
      message: "Forbidden: Insufficient permissions",
    }
  }

  if (!scope.organizationId) {
    return {
      allowed: false,
      status: 403,
      message: "Organization context required",
    }
  }

  if (requestedOrganizationId !== scope.organizationId) {
    return {
      allowed: false,
      status: 403,
      message: "Forbidden: Branches can only be created in your assigned organization",
    }
  }

  return { allowed: true, organizationId: scope.organizationId }
}
