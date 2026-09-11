import type { Role } from "@/lib/rbac"

/**
 * Roles that can manage their own MFA from the shared Settings page.
 *
 * GROUP_ORDER_PORTAL is intentionally absent: that role is confined to the
 * dedicated ordering storefront and has no Settings page. Its MFA enrollment
 * is managed by an administrator, while its login challenge uses the separate
 * /api/v1/mfa/login endpoints.
 */
export const MFA_SELF_SERVICE_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
] satisfies Role[]
