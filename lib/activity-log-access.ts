/**
 * Who may read the activity log.
 *
 * **Super Admin alone, and it is not narrowed to a tenant.** The trail spans
 * every organization and records administrative action against it — including
 * action taken *by* Head Office — so handing an organization-scoped view to
 * Head Office would let the audited party curate their own audit. Head Office
 * already has the reports it needs for its own operations.
 *
 * The right is carried in RBAC as `Permission.SYSTEM_VIEW_AUDIT_LOGS`, which
 * only the Super Admin template holds (`lib/permissions.ts`). This module is
 * the one place the rule is stated, in the shape `lib/pricing-access.ts` uses:
 * a pure predicate plus the refusal, so a route cannot approximate it with an
 * inline role comparison and a test can pin the whole matrix.
 */

import { Permission } from "@/lib/permissions"
import type { Role } from "@/lib/rbac"

/** The permission this module enforces. Named so a reader can find it in RBAC. */
export const ACTIVITY_LOG_PERMISSION = Permission.SYSTEM_VIEW_AUDIT_LOGS

export const ACTIVITY_LOG_ROLES: readonly Role[] = ["SUPER_ADMIN"]

export function canViewActivityLog(role: string | null | undefined): boolean {
  return typeof role === "string" && (ACTIVITY_LOG_ROLES as readonly string[]).includes(role)
}

export type ActivityLogFailure = { message: string; status: 401 | 403 }

/**
 * The refusal for a caller who may not read the trail, or null when they may.
 *
 * 403 rather than 404: the screen's existence is not a secret, and a Super
 * Admin debugging a colleague's access needs to see the difference between "not
 * signed in" and "not permitted".
 */
export function activityLogAccessFailure(
  role: string | null | undefined,
): ActivityLogFailure | null {
  if (!role) {
    return { message: "Unauthorized", status: 401 }
  }
  if (!canViewActivityLog(role)) {
    return {
      message: "Forbidden - Super Admin access required to read the activity log",
      status: 403,
    }
  }
  return null
}
