/**
 * Who may read the activity log, and how much of it.
 *
 * Two reaches, decided from the caller's own account and never from the
 * request (`plans/OF-AUDIT-head-office-activity-log.md`):
 *
 * * **Super Admin reads the whole platform** — every tenant, and the platform
 *   rows that belong to none. Carried in RBAC as
 *   `Permission.SYSTEM_VIEW_AUDIT_LOGS`, which only the Super Admin template
 *   holds.
 * * **Head Office reads its own organization** — the rows tagged with the
 *   organization on its `users` row, with anyone outside that organization
 *   anonymised (`lib/activity-log-reach.ts`). Carried as
 *   `Permission.ORG_VIEW_AUDIT_LOGS`.
 *
 * Every other role is refused outright. The first version of this screen
 * refused Head Office too, on the ground that the audited party should not
 * curate its own audit; a read cannot curate — the tables stay append-only and
 * Head Office is given no write — so that refusal was reversed on request and
 * the remaining concern, learning about people outside the tenant, is handled
 * by the anonymisation instead.
 *
 * This module is the one place the rule is stated, in the shape
 * `lib/pricing-access.ts` uses: pure predicates plus the refusal, so the route,
 * the page, `proxy.ts` and the sidebar all read the same answer and a test can
 * pin the whole matrix.
 */

import type {
  ActivityFilters,
  ActivityReach,
  ActivityRequestFilters,
} from "@/lib/activity-log"
import { Permission } from "@/lib/permissions"
import type { Role } from "@/lib/rbac"

/** The permission behind the whole-platform reach. */
export const ACTIVITY_LOG_PLATFORM_PERMISSION = Permission.SYSTEM_VIEW_AUDIT_LOGS

/** The permission behind the one-organization reach. */
export const ACTIVITY_LOG_ORGANIZATION_PERMISSION = Permission.ORG_VIEW_AUDIT_LOGS

export const ACTIVITY_LOG_PLATFORM_ROLES: readonly Role[] = ["SUPER_ADMIN"]

export const ACTIVITY_LOG_ORGANIZATION_ROLES: readonly Role[] = ["HEAD_OFFICE"]

/** Every role that may open the screen at all, whatever its reach. */
export const ACTIVITY_LOG_ROLES: readonly Role[] = [
  ...ACTIVITY_LOG_PLATFORM_ROLES,
  ...ACTIVITY_LOG_ORGANIZATION_ROLES,
]

function holds(roles: readonly Role[], role: string | null | undefined): boolean {
  return typeof role === "string" && (roles as readonly string[]).includes(role)
}

export function canViewActivityLog(role: string | null | undefined): boolean {
  return holds(ACTIVITY_LOG_ROLES, role)
}

/** Whether the role reads every tenant's trail. Used for copy, never for a fence. */
export function readsWholePlatform(role: string | null | undefined): boolean {
  return holds(ACTIVITY_LOG_PLATFORM_ROLES, role)
}

export type ActivityLogFailure = { message: string; status: 401 | 403 }

const UNAUTHORIZED: ActivityLogFailure = { message: "Unauthorized", status: 401 }

const FORBIDDEN_ROLE: ActivityLogFailure = {
  message: "Forbidden - you do not have access to the activity log",
  status: 403,
}

const FORBIDDEN_NO_ORGANIZATION: ActivityLogFailure = {
  message: "Forbidden - your account is not assigned to an organization",
  status: 403,
}

const FORBIDDEN_OTHER_ORGANIZATION: ActivityLogFailure = {
  message: "Forbidden - you can read only your own organization's activity",
  status: 403,
}

/**
 * The refusal for a role that may not open the screen, or null when it may.
 *
 * 403 rather than 404: the screen's existence is not a secret, and a Super
 * Admin debugging a colleague's access needs to see the difference between "not
 * signed in" and "not permitted".
 */
export function activityLogAccessFailure(
  role: string | null | undefined,
): ActivityLogFailure | null {
  if (!role) return UNAUTHORIZED
  if (!canViewActivityLog(role)) return FORBIDDEN_ROLE
  return null
}

/** The part of `getRequestScope()` this rule reads. */
export type ActivityLogCaller = {
  role?: string | null
  organizationId?: number | null
} | null | undefined

export type ActivityReachResult =
  | { ok: true; reach: ActivityReach }
  | { ok: false; failure: ActivityLogFailure }

function isOrganizationId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/**
 * The reach of a signed-in caller, from the server-resolved scope.
 *
 * `scope.organizationId` must come from `getRequestScope()`, which re-reads it
 * from the `users` row on every request — never from the session cookie or the
 * request. An organization-scoped role with no organization is **refused**,
 * not widened: a Head Office account that lost its tenant must see nothing,
 * not everything.
 */
export function resolveActivityLogReach(scope: ActivityLogCaller): ActivityReachResult {
  const denied = activityLogAccessFailure(scope?.role)
  if (denied) return { ok: false, failure: denied }

  if (holds(ACTIVITY_LOG_PLATFORM_ROLES, scope?.role)) {
    return { ok: true, reach: { kind: "platform" } }
  }

  if (holds(ACTIVITY_LOG_ORGANIZATION_ROLES, scope?.role) && isOrganizationId(scope?.organizationId)) {
    return { ok: true, reach: { kind: "organization", organizationId: scope.organizationId } }
  }

  return { ok: false, failure: FORBIDDEN_NO_ORGANIZATION }
}

export type ActivityFiltersResult =
  | { ok: true; filters: ActivityFilters }
  | { ok: false; failure: ActivityLogFailure }

/**
 * Fence what the caller asked for with what the caller may see.
 *
 * An organization reader naming another organization is refused rather than
 * silently re-pointed at their own: the request says something the caller is
 * not allowed to ask, and a quiet substitution would hide a probe. Every
 * organization id gets the same answer, so the refusal says nothing about
 * whether that tenant exists. A branch or actor of another tenant is not
 * refused here — the fence on the query intersects it to nothing.
 */
export function applyActivityReach(
  requested: ActivityRequestFilters,
  reach: ActivityReach,
): ActivityFiltersResult {
  if (
    reach.kind === "organization" &&
    requested.organizationId !== null &&
    requested.organizationId !== reach.organizationId
  ) {
    return { ok: false, failure: FORBIDDEN_OTHER_ORGANIZATION }
  }
  return { ok: true, filters: { ...requested, reach } }
}
