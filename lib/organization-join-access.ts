import type { Role } from "@/lib/rbac"

/**
 * Who may open a tenant to joining, and who may decide a request.
 *
 * **Head Office alone**, for both. The code an organization hands out and the
 * decision on who gets in are the tenant's own gatekeeping, so they belong to
 * the tenant's own administrator.
 *
 * `SUPER_ADMIN` is deliberately absent, and its absence costs nothing: Super
 * Admin can already create a user in any organization through
 * `POST /api/v1/users`, which is a separate and separately audited act. What it
 * cannot do is quietly let somebody into a tenant through that tenant's own
 * join queue.
 *
 * This is a role allowlist rather than a `Permission`, following
 * `lib/user-management-access.ts`, for two reasons a permission cannot meet:
 * `ROLE_TEMPLATES.SUPER_ADMIN` is `Object.values(Permission)`, so any new
 * permission is granted to Super Admin by construction; and `rolePermissions`
 * rows exist only after `db:seed` has run, so a fresh environment would have
 * the check pass or fail depending on seeding rather than on the rule.
 */
export const JOIN_REQUEST_MANAGEMENT_ROLES: Role[] = ["HEAD_OFFICE"]

export function canManageJoinRequests(role: unknown): role is Role {
  return (
    typeof role === "string" &&
    JOIN_REQUEST_MANAGEMENT_ROLES.includes(role as Role)
  )
}
