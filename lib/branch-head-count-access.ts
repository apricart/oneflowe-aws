import type { Role } from "@/lib/rbac"

/**
 * Who may set a branch's head count, who may ask for one, and who may grant
 * the ask. See plans/OF-BRANCH-head-count.md.
 *
 * Role allowlists rather than `Permission` entries, for the reasons
 * `lib/delivery-address-access.ts` gives: `ROLE_TEMPLATES.SUPER_ADMIN` holds
 * every permission by construction, and `rolePermissions` rows exist only
 * after `db:seed` has run.
 */

/**
 * The roles that write `branches.head_count` directly, through the branch
 * create and edit forms. Exactly the roles `POST /api/v1/branches` and
 * `PATCH /api/v1/branches/[id]` already admit; Head Office only ever on its own
 * organization's branches, which those routes already enforce.
 */
export const HEAD_COUNT_DIRECT_WRITE_ROLES: Role[] = ["SUPER_ADMIN", "HEAD_OFFICE"]

/**
 * The roles that may raise a request, for a branch they act for: a Branch
 * Admin for its own branch, a Group User across its resolved assignment set.
 *
 * Neither may write the figure itself — that is the point of the request.
 */
export const HEAD_COUNT_REQUEST_ROLES: Role[] = ["BRANCH_ADMIN", "GROUP_USER"]

/**
 * The roles that may approve or reject one: **Head Office alone**, in its own
 * organization. Super Admin is absent from the queue; it sets the figure
 * directly when it needs to, which is a separate and separately audited act.
 */
export const HEAD_COUNT_DECISION_ROLES: Role[] = ["HEAD_OFFICE"]

/** Everyone who may raise plus everyone who may decide. Derived, so the two cannot drift. */
export const HEAD_COUNT_REQUEST_READ_ROLES: Role[] = [
  ...HEAD_COUNT_REQUEST_ROLES,
  ...HEAD_COUNT_DECISION_ROLES,
]

function roleIn(list: Role[], role: unknown): role is Role {
  return typeof role === "string" && list.includes(role as Role)
}

export function canWriteBranchHeadCount(role: unknown): role is Role {
  return roleIn(HEAD_COUNT_DIRECT_WRITE_ROLES, role)
}

export function canRequestBranchHeadCount(role: unknown): role is Role {
  return roleIn(HEAD_COUNT_REQUEST_ROLES, role)
}

export function canDecideBranchHeadCount(role: unknown): role is Role {
  return roleIn(HEAD_COUNT_DECISION_ROLES, role)
}

export function canReadBranchHeadCountRequests(role: unknown): role is Role {
  return roleIn(HEAD_COUNT_REQUEST_READ_ROLES, role)
}

/** The shell area holding the request queue. Gated in `proxy.ts`. */
export const HEAD_COUNT_REQUESTS_AREA = "/head-count-requests"
