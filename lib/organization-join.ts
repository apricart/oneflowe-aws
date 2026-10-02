/**
 * Joining an organization — every rule that does not need a database.
 *
 * The flow this serves: an applicant on the public join page types the code
 * their organization gave them, the code resolves the organization
 * server-side, they fill in the same details the Create User form asks for,
 * and Head Office approves or rejects what arrives. Nobody becomes a user
 * without that approval.
 *
 * Nothing here imports a database, a session, or `node:crypto`, so the join
 * page can hold the same rules the endpoints enforce and the two cannot
 * disagree about what a code looks like or which roles exist.
 */

import { emailMatchesDomain } from "@/lib/organization-email-domain"
import type { Role } from "@/lib/rbac"

/**
 * The only roles the public form may ask for.
 *
 * Narrower than `systemRoleSchema` on purpose: an applicant must never be able
 * to request administrative authority over the tenant they are asking to join.
 * The same four are pinned by a check constraint on
 * `organization_join_requests.requested_role`, so an endpoint that forgets this
 * list still cannot write a fifth.
 */
export const JOINABLE_ROLES = [
  "BRANCH_ADMIN",
  "ORDER_PORTAL",
  "GROUP_USER",
  "GROUP_ORDER_PORTAL",
] as const

export type JoinableRole = (typeof JOINABLE_ROLES)[number]

export function isJoinableRole(value: unknown): value is JoinableRole {
  return typeof value === "string" && (JOINABLE_ROLES as readonly string[]).includes(value)
}

/** What each joinable role is called on the form and in the request queue. */
export const JOINABLE_ROLE_LABELS: Record<JoinableRole, string> = {
  BRANCH_ADMIN: "Branch Admin",
  ORDER_PORTAL: "Order Portal User",
  GROUP_USER: "Group User",
  GROUP_ORDER_PORTAL: "Group Order Portal User",
}

/** Roles pinned to exactly one branch, mirroring `lib/server/multi-branch-scope.ts`. */
const SINGLE_BRANCH_JOINABLE_ROLES: readonly JoinableRole[] = ["BRANCH_ADMIN", "ORDER_PORTAL"]

export function isSingleBranchJoinableRole(role: JoinableRole): boolean {
  return SINGLE_BRANCH_JOINABLE_ROLES.includes(role)
}

export const JOIN_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number]

export function isJoinRequestStatus(value: unknown): value is JoinRequestStatus {
  return typeof value === "string" && (JOIN_REQUEST_STATUSES as readonly string[]).includes(value)
}

export const JOIN_DECISIONS = ["approve", "reject"] as const
export type JoinDecision = (typeof JOIN_DECISIONS)[number]

/**
 * The code's shape.
 *
 * A join code is a bearer secret typed by an anonymous caller, so the floor on
 * its length is the floor on how much work guessing one takes: 8 characters of
 * [A-Z0-9-] is ~2.8e12 combinations, against a rate limiter that allows 15
 * attempts per quarter hour. The dash is allowed so a human-readable code can
 * be grouped (`APR-2026-NORTH`); nothing else is, because a code has to survive
 * being read aloud, written down and retyped.
 */
export const JOIN_CODE_MIN_LENGTH = 8
export const JOIN_CODE_MAX_LENGTH = 32
export const JOIN_CODE_PATTERN = /^[A-Z0-9-]+$/

/**
 * The one spelling of a code.
 *
 * Upper-cased so the person typing it does not have to match case, and
 * whitespace-trimmed at the ends only. Internal whitespace is *not* stripped —
 * it is rejected by `joinCodeError` instead, because silently removing it would
 * let `AB CD1234` and `ABCD1234` be the same code and make the unique index a
 * lie about what was typed.
 */
export function normalizeJoinCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : ""
}

/** Why a code Head Office typed is unusable, or null when it is fine. */
export function joinCodeError(value: unknown): string | null {
  const code = normalizeJoinCode(value)
  if (code.length === 0) return "Enter a join code"
  if (code.length < JOIN_CODE_MIN_LENGTH) {
    return `A join code must be at least ${JOIN_CODE_MIN_LENGTH} characters`
  }
  if (code.length > JOIN_CODE_MAX_LENGTH) {
    return `A join code must be at most ${JOIN_CODE_MAX_LENGTH} characters`
  }
  if (!JOIN_CODE_PATTERN.test(code)) {
    return "A join code may contain only letters, numbers and dashes"
  }
  return null
}

export type JoinRequestScope = {
  role: JoinableRole
  branchId: number | null
  groupIds: readonly number[]
  branchIds: readonly number[]
}

/**
 * Whether a requested role carries the assignment shape that role needs.
 *
 * The same rule as `getRoleShapeError` + `rejectScopeForSingleBranchRole` on
 * `POST /api/v1/users`, restated here because the join path has no
 * `organizationId` of its own to check (it is resolved from the code) and
 * because Head Office may override the scope at approval and must be held to
 * the identical rule. It is pinned a third time by
 * `organization_join_requests_scope_shape_ck`.
 */
export function joinRequestScopeShapeError(scope: JoinRequestScope): string | null {
  if (isSingleBranchJoinableRole(scope.role)) {
    if (!scope.branchId) {
      return `${JOINABLE_ROLE_LABELS[scope.role]} must be assigned one branch`
    }
    if (scope.groupIds.length > 0 || scope.branchIds.length > 0) {
      return "Group and branch assignments apply only to the group-based roles"
    }
    return null
  }

  if (scope.branchId) {
    return "Group-based users are not assigned a single branch"
  }
  if (scope.groupIds.length === 0 && scope.branchIds.length === 0) {
    return "Assign at least one group or one branch"
  }
  return null
}

/**
 * A joinable role is one of the system roles, asserted once here so the server
 * modules can hand one straight to the existing user-creation helpers.
 *
 * `Role` rather than `SystemRole` deliberately: the two are the same union, and
 * `lib/server/mutation-validation.ts` imports the role allowlist *from* this
 * module, so taking the type from there would close a cycle.
 */
export function asSystemRole(role: JoinableRole): Role {
  return role
}

/**
 * What the public endpoints say, whatever actually happened.
 *
 * Each of these closes an oracle that an anonymous caller would otherwise get
 * for free:
 *
 *   * `UNKNOWN_JOIN_CODE` — a wrong code, a code belonging to a de-activated
 *     tenant, and a tenant that has never opened joining are indistinguishable.
 *     Otherwise a guesser learns which codes exist before learning which work.
 *   * `JOIN_IDENTITY_CONFLICT` — names no field. An email, a username, a phone
 *     number, an employee number and an already-queued request all answer the
 *     same way, so the form cannot be used to test whether a colleague has an
 *     account. This is why there is deliberately no public
 *     username-availability endpoint; `/api/v1/users/check-username` stays
 *     behind a session.
 */
export const UNKNOWN_JOIN_CODE_MESSAGE =
  "That join code is not recognised. Check it with your organization's head office."

export const JOIN_IDENTITY_CONFLICT_MESSAGE =
  "The details you entered cannot be used to join. If you already have an account, or a request is already waiting, contact your organization's head office."

export const JOIN_REQUEST_RECEIVED_MESSAGE =
  "Your request has been sent to your organization's head office. You will be able to sign in once it is approved."

/**
 * What an applicant is told when the organization their code opens has no
 * email domain. The join page shows it as a prompt instead of the form, and the
 * submit endpoint answers with it too, so a caller that skips the page hears
 * the same thing.
 *
 * It does not name the organization, so it can be shown before anything else
 * about the code is known. Only a holder of a *valid* code ever sees it — an
 * unknown code still gets `UNKNOWN_JOIN_CODE_MESSAGE` — so it tells a guesser
 * nothing.
 */
export const JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE =
  "Your organization's email domain is not set, so you cannot join yet. Please contact your organization."

export function joinEmailDomainMismatchMessage(emailDomain: string): string {
  return `Use your @${emailDomain} email address to join.`
}

export type JoinEmailDomainRefusal = { message: string; status: 400 | 409 }

/**
 * Whether an application's address is refused by its organization's domain.
 *
 * `emailDomain` is the organization's own, read from the database on the same
 * request that resolved the code — never something the page sent back.
 *
 *   * no domain set -> 409: the organization is not in a state that can take a
 *     request, whatever the applicant types;
 *   * an address not at exactly that domain -> 400: the input is wrong.
 */
export function joinEmailDomainRefusal(
  email: string,
  emailDomain: string | null,
): JoinEmailDomainRefusal | null {
  if (!emailDomain) return { message: JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE, status: 409 }
  if (!emailMatchesDomain(email, emailDomain)) {
    return { message: joinEmailDomainMismatchMessage(emailDomain), status: 400 }
  }
  return null
}
