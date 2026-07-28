import type { Role } from "@/lib/rbac"

export const USER_MANAGEMENT_ROLES: Role[] = ["SUPER_ADMIN", "HEAD_OFFICE"]

export function canAccessUserManagement(role: unknown): role is Role {
  return (
    typeof role === "string" &&
    USER_MANAGEMENT_ROLES.includes(role as Role)
  )
}
