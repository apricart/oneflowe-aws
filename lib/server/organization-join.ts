import "server-only"

import { randomInt } from "node:crypto"

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"

import {
  branches,
  groups,
  organizationJoinCodes,
  organizationJoinRequests,
  organizations,
  roles as rolesTable,
  users as usersTable,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  JOINABLE_ROLES,
  type JoinDecision,
  type JoinRequestStatus,
  type JoinableRole,
  asSystemRole,
  isSingleBranchJoinableRole,
  joinRequestScopeShapeError,
} from "@/lib/organization-join"
import {
  assertUniqueUserFields,
  normalizeEmail,
  normalizeOptionalText,
} from "@/lib/user-uniqueness"
import { usernameExists } from "@/lib/user-username-uniqueness"
import {
  replaceMultiBranchScope,
  usesMultiBranchScope,
  validateMultiBranchScope,
} from "@/lib/server/multi-branch-scope"

/**
 * The database side of joining an organization.
 *
 * Two rules run through every function here and are the reason the feature is
 * tenant-safe:
 *
 *   1. **The organization is resolved from the code, never from a request.** No
 *      function here takes an `organizationId` from a caller that has not
 *      already proved it — the public paths derive it from the code, and the
 *      managed paths derive it from the signed-in Head Office session.
 *   2. **A branch or group id is re-checked against that organization every
 *      time it is used** — once when the request is stored and again inside the
 *      approval transaction, because the branch could have been moved,
 *      de-activated or deleted in between.
 */

/** How many rows a single code can make an anonymous caller's answer carry. */
const MAX_LOOKUP_BRANCHES = 500
const MAX_LOOKUP_GROUPS = 200
/** How many requests one queue page returns. */
export const MAX_JOIN_REQUEST_PAGE = 200
/**
 * How many requests one tenant may have waiting at once.
 *
 * A ceiling on the damage a leaked code can do: the code buys the right to ask,
 * and past this many unanswered asks it buys nothing until Head Office clears
 * the queue. Chosen well above any plausible real intake.
 */
export const MAX_PENDING_REQUESTS_PER_ORGANIZATION = 200

/**
 * A generated code: 14 characters in three dash-separated groups, drawn with
 * `randomInt` from an alphabet with no character that survives being read aloud
 * ambiguously — no O/0, no I/1, no S/5, no B/8, no Z/2.
 *
 * ~4.7e15 combinations, which is what makes generating one the recommended path
 * over typing a memorable one.
 */
const CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679"

export function generateJoinCode(): string {
  const groupsOfFour = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""),
  )
  return groupsOfFour.join("-")
}

export type JoinCodeRecord = {
  code: string
  updatedAt: Date | null
}

export type JoinFormOptions = {
  organizationName: string
  /** Null when the organization has not set one, and the form cannot be used. */
  emailDomain: string | null
  branches: Array<{ id: number; name: string }>
  groups: Array<{ id: number; name: string }>
}

export type ResolvedJoinOrganization = {
  organizationId: number
  organizationName: string
  emailDomain: string | null
}

/**
 * The organization a code belongs to, or null.
 *
 * Null covers three cases the caller must not be able to tell apart: no such
 * code, a code whose tenant is not active, and a tenant that never opened
 * joining. The routes answer all three with `UNKNOWN_JOIN_CODE_MESSAGE`.
 *
 * The code arrives already normalised, so this is one exact probe of
 * `organization_join_codes_code_uq`.
 */
export async function resolveOrganizationByJoinCode(
  normalizedCode: string,
): Promise<ResolvedJoinOrganization | null> {
  if (!normalizedCode) return null

  const [row] = await db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      emailDomain: organizations.emailDomain,
    })
    .from(organizationJoinCodes)
    .innerJoin(organizations, eq(organizations.id, organizationJoinCodes.organizationId))
    .where(and(
      eq(organizationJoinCodes.code, normalizedCode),
      eq(organizations.status, "active"),
    ))
    .limit(1)

  return row ?? null
}

/**
 * What the join form needs in order to be filled in: the tenant's name, and the
 * identity of the branches and groups that can be asked for.
 *
 * Identity fields only. Deliberately not the branch's budget baseline, its
 * administrator, its cost centre, its external identifiers or its code — this
 * answer goes to somebody holding a shared code and nothing else, so it carries
 * the minimum the form cannot work without.
 *
 * An organization with no email domain cannot take a request at all, so for
 * one of those even the branches and groups are withheld: the page shows the
 * "domain not set" prompt, and nothing it would have needed to fill in the form
 * leaves the server.
 */
export async function loadJoinFormOptions(
  organization: ResolvedJoinOrganization,
): Promise<JoinFormOptions> {
  if (!organization.emailDomain) {
    return {
      organizationName: organization.organizationName,
      emailDomain: null,
      branches: [],
      groups: [],
    }
  }

  const [branchRows, groupRows] = await Promise.all([
    db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(
        eq(branches.organizationId, organization.organizationId),
        eq(branches.status, "active"),
      ))
      .orderBy(asc(branches.name))
      .limit(MAX_LOOKUP_BRANCHES),
    db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(
        eq(groups.organizationId, organization.organizationId),
        eq(groups.status, "active"),
      ))
      .orderBy(asc(groups.name))
      .limit(MAX_LOOKUP_GROUPS),
  ])

  return {
    organizationName: organization.organizationName,
    emailDomain: organization.emailDomain,
    branches: branchRows,
    groups: groupRows,
  }
}

/* ── The code, as Head Office manages it ─────────────────────────────────── */

/**
 * The caller's own organization's email domain, so Head Office can see beside
 * its code whether applicants can actually use it. Read-only here: only Super
 * Admin sets it, through the organization endpoints.
 */
export async function readOrganizationEmailDomain(organizationId: number): Promise<string | null> {
  const [row] = await db
    .select({ emailDomain: organizations.emailDomain })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return row?.emailDomain ?? null
}

export async function readJoinCode(organizationId: number): Promise<JoinCodeRecord | null> {
  const [row] = await db
    .select({ code: organizationJoinCodes.code, updatedAt: organizationJoinCodes.updatedAt })
    .from(organizationJoinCodes)
    .where(eq(organizationJoinCodes.organizationId, organizationId))
    .limit(1)
  return row ?? null
}

export type JoinCodeWriteFailure = { message: string; status: number }

/**
 * Set or replace the organization's code.
 *
 * One row per organization, so this is an upsert on `organization_id`. A code
 * already held by another tenant is refused rather than stolen: the unique index
 * on `code` is what guarantees a code resolves to exactly one organization, and
 * without that guarantee the whole lookup is ambiguous.
 */
export async function setJoinCode(input: {
  organizationId: number
  code?: string
  actorUserId: string
}): Promise<{ code: string } | JoinCodeWriteFailure> {
  const code = input.code ?? generateJoinCode()

  const [takenElsewhere] = await db
    .select({ organizationId: organizationJoinCodes.organizationId })
    .from(organizationJoinCodes)
    .where(eq(organizationJoinCodes.code, code))
    .limit(1)
  if (takenElsewhere && takenElsewhere.organizationId !== input.organizationId) {
    return { message: "That join code is already in use. Choose another.", status: 409 }
  }

  try {
    await db
      .insert(organizationJoinCodes)
      .values({
        organizationId: input.organizationId,
        code,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
      })
      .onConflictDoUpdate({
        target: organizationJoinCodes.organizationId,
        set: {
          code,
          updatedByUserId: input.actorUserId,
          updatedAt: new Date(),
        },
      })
  } catch (caughtError: any) {
    // The read above can be overtaken: two tenants issuing the same code at the
    // same instant both see it free, and `organization_join_codes_code_uq`
    // decides between them. The loser gets the same answer it would have got a
    // moment earlier, rather than a 500.
    const errorCode = String(caughtError?.code ?? caughtError?.cause?.code ?? "")
    if (errorCode === "23505") {
      return { message: "That join code is already in use. Choose another.", status: 409 }
    }
    throw caughtError
  }

  return { code }
}

/** Close joining for this tenant. Pending requests are left to be decided. */
export async function clearJoinCode(organizationId: number): Promise<boolean> {
  const removed = await db
    .delete(organizationJoinCodes)
    .where(eq(organizationJoinCodes.organizationId, organizationId))
    .returning({ id: organizationJoinCodes.id })
  return removed.length > 0
}

/* ── Submitting a request ────────────────────────────────────────────────── */

export type JoinRequestSubmission = {
  organizationId: number
  role: JoinableRole
  branchId: number | null
  groupIds: number[]
  branchIds: number[]
  firstName: string
  lastName: string
  email: string
  username: string
  passwordHash: string
  phone: string | null
  employeeId: string | null
  imprestHolder: string | null
  contactPerson: string | null
  location: string | null
  address: string | null
  submittedIp: string | null
  submittedUserAgent: string | null
}

export type JoinRequestFailure = {
  /**
   * `identity` is answered to the caller with one message per form, listing
   * every field checked but never singling one out, because naming the field
   * turns the public form into a way of testing whether a colleague has an
   * account. `scope` and `limit` are safe to describe: they are
   * about the tenant's own structure, which the code already disclosed.
   */
  kind: "identity" | "scope" | "limit"
  message: string
  status: number
}

/**
 * Whether every branch and group id named belongs to this organization.
 *
 * Shared by submission and by approval, so an override at approval is held to
 * exactly the rule the submission was. `validateMultiBranchScope` already does
 * this for the group roles; the single-branch case is checked here because
 * `getTenantReferenceError` on the users route is not importable from a
 * route-handler-shaped module.
 */
async function scopeTenantError(input: {
  organizationId: number
  role: JoinableRole
  branchId: number | null
  groupIds: number[]
  branchIds: number[]
}): Promise<string | null> {
  const shapeError = joinRequestScopeShapeError(input)
  if (shapeError) return shapeError

  if (isSingleBranchJoinableRole(input.role)) {
    const [branch] = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(
        eq(branches.id, input.branchId as number),
        eq(branches.organizationId, input.organizationId),
        eq(branches.status, "active"),
      ))
      .limit(1)
    if (!branch) return "That branch is not available in this organization"
    return null
  }

  const scopeError = await validateMultiBranchScope({
    organizationId: input.organizationId,
    groupIds: input.groupIds,
    branchIds: input.branchIds,
  })
  return scopeError?.message ?? null
}

/**
 * Whether this identity is already spoken for, anywhere it matters.
 *
 * Three doors an account can come through, and they are **not** all scoped the
 * same way, deliberately:
 *
 *   * `users` and `employee_credentials` are checked application-wide, because
 *     that is the existing rule for an account — one email, one username, one
 *     phone, one employee number across the whole platform
 *     (`assertUniqueUserFields`, `usernameExists`). Relaxing that here would let
 *     the join path create something the admin path refuses.
 *   * the queue is checked **within this tenant only**. A global check here
 *     would make one tenant's pending queue block the same person from applying
 *     to another tenant, which is a cross-tenant channel and not this feature's
 *     business. The two-tenant race it allows is resolved at approval, where the
 *     application-wide checks above run again.
 *
 * `checkAccountUsername` is false for the department sign-up, whose username
 * is not something the applicant typed: it is the email's local part, so
 * `ali@ke.example` would be refused because another tenant has a user `ali`,
 * and the applicant would have no field to change. That clash is not refused
 * here; the review flags it (`usernameTaken`) and Head Office picks another
 * username before approving, where `usernameExists` runs again.
 *
 * The caller collapses every one of these into a single message that singles
 * out no field.
 */
export async function identityConflictReason(input: {
  organizationId: number
  email: string
  username: string
  phone: string | null
  employeeId: string | null
  checkAccountUsername: boolean
}): Promise<string | null> {
  if (input.checkAccountUsername && await usernameExists(input.username)) return "username taken"

  try {
    await assertUniqueUserFields({
      email: input.email,
      phone: input.phone,
      employeeId: input.employeeId,
    })
  } catch {
    return "user field taken"
  }

  const [pending] = await db
    .select({ id: organizationJoinRequests.id })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.organizationId, input.organizationId),
      eq(organizationJoinRequests.status, "pending"),
      sql`(${organizationJoinRequests.email} = ${input.email} OR ${organizationJoinRequests.username} = ${input.username})`,
    ))
    .limit(1)
  if (pending) return "request already pending"

  return null
}

export async function createJoinRequest(
  submission: JoinRequestSubmission,
): Promise<{ id: number } | JoinRequestFailure> {
  const scopeError = await scopeTenantError(submission)
  if (scopeError) return { kind: "scope", message: scopeError, status: 400 }

  const [{ pendingCount }] = await db
    .select({ pendingCount: sql<number>`count(*)::int` })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.organizationId, submission.organizationId),
      eq(organizationJoinRequests.status, "pending"),
    ))
  if (pendingCount >= MAX_PENDING_REQUESTS_PER_ORGANIZATION) {
    // 409, not 429: this is the tenant's queue being full, not the caller being
    // too fast, and there is no retry window to name — it clears when Head
    // Office works through it. A 429 here would also owe a `Retry-After` nobody
    // can compute (rule 05).
    return {
      kind: "limit",
      message: "This organization already has the maximum number of requests waiting. Contact its head office.",
      status: 409,
    }
  }

  if (await identityConflictReason({ ...submission, checkAccountUsername: true })) {
    return { kind: "identity", message: "identity conflict", status: 409 }
  }

  try {
    const [created] = await db
      .insert(organizationJoinRequests)
      .values({
        organizationId: submission.organizationId,
        requestedRole: submission.role,
        requestedBranchId: submission.branchId,
        requestedGroupIds: submission.groupIds,
        requestedBranchIds: submission.branchIds,
        firstName: submission.firstName,
        lastName: submission.lastName,
        email: submission.email,
        username: submission.username,
        phone: submission.phone,
        employeeId: submission.employeeId,
        imprestHolder: submission.imprestHolder,
        contactPerson: submission.contactPerson,
        location: submission.location,
        address: submission.address,
        passwordHash: submission.passwordHash,
        submittedIp: submission.submittedIp,
        submittedUserAgent: submission.submittedUserAgent,
      })
      .returning({ id: organizationJoinRequests.id })
    return { id: created.id }
  } catch (caughtError: any) {
    // The partial unique indexes on a pending email/username are what decide a
    // race between two simultaneous submissions. Losing that race is the same
    // answer as losing the read above.
    const code = String(caughtError?.code ?? caughtError?.cause?.code ?? "")
    if (code === "23505") {
      return { kind: "identity", message: "identity conflict", status: 409 }
    }
    throw caughtError
  }
}

/* ── The queue, and deciding it ──────────────────────────────────────────── */

export type JoinRequestListRow = {
  id: number
  /** 1 = the standard form; 2 = the department sign-up (reviewed through its own read). */
  formVersion: number
  status: JoinRequestStatus
  requestedRole: JoinableRole
  requestedBranchId: number | null
  requestedBranchName: string | null
  requestedGroupIds: number[]
  requestedBranchIds: number[]
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string | null
  employeeId: string | null
  imprestHolder: string | null
  contactPerson: string | null
  location: string | null
  address: string | null
  decisionReason: string | null
  decidedAt: Date | null
  createdUserId: string | null
  createdAt: Date
}

/**
 * One tenant's queue.
 *
 * `organizationId` comes from the caller's session, never from a query string,
 * and is the only tenant predicate this read needs. `password_hash`,
 * `submitted_ip` and `submitted_user_agent` are deliberately not selected — the
 * hash must never leave the server, and the other two are for investigating
 * abuse from the database, not for rendering.
 */
export async function listJoinRequests(input: {
  organizationId: number
  status?: JoinRequestStatus
  limit?: number
}): Promise<JoinRequestListRow[]> {
  const conditions = [eq(organizationJoinRequests.organizationId, input.organizationId)]
  if (input.status) conditions.push(eq(organizationJoinRequests.status, input.status))

  const rows = await db
    .select({
      id: organizationJoinRequests.id,
      formVersion: organizationJoinRequests.formVersion,
      status: organizationJoinRequests.status,
      requestedRole: organizationJoinRequests.requestedRole,
      requestedBranchId: organizationJoinRequests.requestedBranchId,
      requestedBranchName: branches.name,
      requestedGroupIds: organizationJoinRequests.requestedGroupIds,
      requestedBranchIds: organizationJoinRequests.requestedBranchIds,
      firstName: organizationJoinRequests.firstName,
      lastName: organizationJoinRequests.lastName,
      email: organizationJoinRequests.email,
      username: organizationJoinRequests.username,
      phone: organizationJoinRequests.phone,
      employeeId: organizationJoinRequests.employeeId,
      imprestHolder: organizationJoinRequests.imprestHolder,
      contactPerson: organizationJoinRequests.contactPerson,
      location: organizationJoinRequests.location,
      address: organizationJoinRequests.address,
      decisionReason: organizationJoinRequests.decisionReason,
      decidedAt: organizationJoinRequests.decidedAt,
      createdUserId: organizationJoinRequests.createdUserId,
      createdAt: organizationJoinRequests.createdAt,
    })
    .from(organizationJoinRequests)
    .leftJoin(branches, eq(branches.id, organizationJoinRequests.requestedBranchId))
    .where(and(...conditions))
    .orderBy(
      // Pending first, then newest — the queue is a work list.
      asc(sql`CASE WHEN ${organizationJoinRequests.status} = 'pending' THEN 0 ELSE 1 END`),
      desc(organizationJoinRequests.createdAt),
    )
    .limit(Math.min(input.limit ?? MAX_JOIN_REQUEST_PAGE, MAX_JOIN_REQUEST_PAGE))

  return rows as JoinRequestListRow[]
}

/** How many requests are still waiting, for the queue badge. */
export async function countPendingJoinRequests(organizationId: number): Promise<number> {
  const [row] = await db
    .select({ pendingCount: sql<number>`count(*)::int` })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.organizationId, organizationId),
      eq(organizationJoinRequests.status, "pending"),
    ))
  return row?.pendingCount ?? 0
}

export type JoinDecisionOverrides = {
  role?: JoinableRole
  branchId?: number | null
  groupIds?: number[]
  branchIds?: number[]
  budgetAllocationEnabled?: boolean
}

export type JoinDecisionOutcome =
  | {
      ok: true
      decision: JoinDecision
      requestId: number
      createdUserId: string | null
      email: string
      firstName: string
      username: string
      role: JoinableRole
      organizationName: string
    }
  | { ok: false; message: string; status: number }

/** The scope actually applied, after any Head Office override. */
function resolveDecisionScope(
  stored: {
    requestedRole: JoinableRole
    requestedBranchId: number | null
    requestedGroupIds: number[]
    requestedBranchIds: number[]
  },
  overrides: JoinDecisionOverrides,
) {
  const role = overrides.role ?? stored.requestedRole
  const roleChanged = role !== stored.requestedRole

  // A role override invalidates the stored assignment for the *other* shape, so
  // an unaccompanied role change is refused rather than silently paired with a
  // branch or list that role cannot hold. `scopeTenantError` reports it.
  const branchId = overrides.branchId !== undefined
    ? overrides.branchId
    : (roleChanged ? null : stored.requestedBranchId)
  const groupIds = overrides.groupIds ?? (roleChanged ? [] : stored.requestedGroupIds)
  const branchIds = overrides.branchIds ?? (roleChanged ? [] : stored.requestedBranchIds)

  return { role, branchId, groupIds, branchIds }
}

/**
 * Approve or reject one request.
 *
 * Everything happens in a single transaction, and the request row is taken
 * `FOR UPDATE` before anything is read off it, so two Head Office users
 * clicking Approve at the same moment produce one user and one 409 rather than
 * two users. `organizationId` is the caller's own, and it is part of the
 * `WHERE` on that lock — a request belonging to another tenant is simply not
 * found, which is also the answer for one that does not exist.
 */
export async function decideJoinRequest(input: {
  requestId: number
  organizationId: number
  actorUserId: string
  decision: JoinDecision
  reason: string | null
  overrides: JoinDecisionOverrides
}): Promise<JoinDecisionOutcome> {
  const [organization] = await db
    .select({ name: organizations.name, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1)
  if (!organization) return { ok: false, message: "Organization not found", status: 404 }

  const roleNames = input.overrides.role ? [input.overrides.role] : [...JOINABLE_ROLES]
  const roleRows = await db
    .select({ id: rolesTable.id, name: rolesTable.name })
    .from(rolesTable)
    .where(inArray(rolesTable.name, roleNames))
  const roleIdByName = new Map(roleRows.map((row) => [row.name, row.id]))

  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        id: organizationJoinRequests.id,
        status: organizationJoinRequests.status,
        requestedRole: organizationJoinRequests.requestedRole,
        requestedBranchId: organizationJoinRequests.requestedBranchId,
        requestedGroupIds: organizationJoinRequests.requestedGroupIds,
        requestedBranchIds: organizationJoinRequests.requestedBranchIds,
        firstName: organizationJoinRequests.firstName,
        lastName: organizationJoinRequests.lastName,
        email: organizationJoinRequests.email,
        username: organizationJoinRequests.username,
        phone: organizationJoinRequests.phone,
        employeeId: organizationJoinRequests.employeeId,
        imprestHolder: organizationJoinRequests.imprestHolder,
        contactPerson: organizationJoinRequests.contactPerson,
        location: organizationJoinRequests.location,
        address: organizationJoinRequests.address,
        passwordHash: organizationJoinRequests.passwordHash,
      })
      .from(organizationJoinRequests)
      .where(and(
        eq(organizationJoinRequests.id, input.requestId),
        eq(organizationJoinRequests.organizationId, input.organizationId),
        // A department sign-up is decided by decideDepartmentJoinRequest,
        // which creates its approvers and branches; this path must never
        // approve one as a lone user.
        eq(organizationJoinRequests.formVersion, 1),
      ))
      .for("update")
      .limit(1)

    if (!stored) return { ok: false as const, message: "Join request not found", status: 404 }
    if (stored.status !== "pending") {
      return {
        ok: false as const,
        message: `This request has already been ${stored.status}.`,
        status: 409,
      }
    }

    const decidedAt = new Date()

    if (input.decision === "reject") {
      await tx
        .update(organizationJoinRequests)
        .set({
          status: "rejected",
          decisionReason: input.reason,
          decidedByUserId: input.actorUserId,
          decidedAt,
          updatedAt: decidedAt,
        })
        .where(eq(organizationJoinRequests.id, stored.id))

      return {
        ok: true as const,
        decision: "reject" as const,
        requestId: stored.id,
        createdUserId: null,
        email: stored.email,
        firstName: stored.firstName,
        username: stored.username,
        role: stored.requestedRole as JoinableRole,
        organizationName: organization.name,
      }
    }

    const scope = resolveDecisionScope(
      {
        requestedRole: stored.requestedRole as JoinableRole,
        requestedBranchId: stored.requestedBranchId,
        requestedGroupIds: stored.requestedGroupIds ?? [],
        requestedBranchIds: stored.requestedBranchIds ?? [],
      },
      input.overrides,
    )

    // Asked again at decision time rather than trusted from submission time: the
    // branch or group could have been moved to another tenant, de-activated or
    // deleted while the request sat in the queue.
    //
    // Precisely: this runs *within* the transaction but reads through the pool,
    // because `scopeTenantError` and `validateMultiBranchScope` are shared with
    // the submission path and take no executor. That is sound here — the
    // transaction never writes a branch or a group, so there is no uncommitted
    // state of its own to miss — and the real guarantee that a stale id cannot
    // land is the foreign key on `users.branch_id`, which would fail the insert
    // and roll the whole decision back.
    const scopeError = await scopeTenantError({
      organizationId: input.organizationId,
      ...scope,
    })
    if (scopeError) return { ok: false as const, message: scopeError, status: 400 }

    const roleId = roleIdByName.get(scope.role)
    if (!roleId) return { ok: false as const, message: "Invalid role", status: 400 }

    // The identity was free when the request was raised. An administrator may
    // have created the same person in the meantime, so it is asked again — and
    // here the answer *is* named, because the caller is an authenticated
    // administrator of this tenant rather than an anonymous applicant.
    //
    // A narrow race remains between this check and the insert, exactly as on
    // `POST /api/v1/users`, which asks the same questions the same way. The
    // username is backstopped by `users_username_idx`, so the worst case there
    // is a rolled-back decision rather than a duplicate. Email has no database
    // uniqueness (`20260906020000_users_email_non_unique`), so two simultaneous
    // approvals of the same address in different tenants could both land; that
    // is pre-existing platform behaviour and not something this path makes worse.
    if (await usernameExists(stored.username)) {
      return { ok: false as const, message: "That username has since been taken", status: 409 }
    }
    try {
      await assertUniqueUserFields({
        email: stored.email,
        phone: stored.phone,
        employeeId: stored.employeeId,
      })
    } catch (uniqueError: any) {
      return {
        ok: false as const,
        message: uniqueError?.message ?? "These details have since been registered",
        status: 409,
      }
    }

    const [createdUser] = await tx
      .insert(usersTable)
      .values({
        email: stored.email,
        username: stored.username,
        passwordHash: stored.passwordHash,
        roleId,
        firstName: stored.firstName,
        lastName: stored.lastName,
        fullName: `${stored.firstName} ${stored.lastName}`,
        phone: stored.phone,
        employeeId: stored.employeeId,
        imprestHolder: stored.imprestHolder,
        contactPerson: stored.contactPerson,
        location: stored.location,
        address: stored.address,
        organizationId: input.organizationId,
        branchId: scope.branchId,
        // Neither is ever taken from the applicant. MFA follows the tenant's own
        // default (off here, as on the admin form); allocation is granted by
        // Head Office at this moment or not at all.
        mfaEnabled: false,
        isActive: true,
        budgetAllocationEnabled:
          scope.role === "GROUP_USER" && input.overrides.budgetAllocationEnabled === true,
        // Deliberately false, unlike `POST /api/v1/users`. There the
        // administrator chose the password and the user must rotate away from
        // it; here the applicant chose their own, so there is nothing to rotate.
        mustChangePassword: false,
      })
      .returning({ id: usersTable.id })

    if (usesMultiBranchScope(asSystemRole(scope.role))) {
      await replaceMultiBranchScope(tx, {
        userId: createdUser.id,
        organizationId: input.organizationId,
        groupIds: scope.groupIds,
        branchIds: scope.branchIds,
        createdByUserId: input.actorUserId,
      })
    }

    await tx
      .update(organizationJoinRequests)
      .set({
        status: "approved",
        decisionReason: input.reason,
        decidedByUserId: input.actorUserId,
        decidedAt,
        createdUserId: createdUser.id,
        // The approved role and scope are recorded on the request too, so the
        // trail says what was granted rather than only what was asked for.
        requestedRole: scope.role,
        requestedBranchId: scope.branchId,
        requestedGroupIds: scope.groupIds,
        requestedBranchIds: scope.branchIds,
        updatedAt: decidedAt,
      })
      .where(eq(organizationJoinRequests.id, stored.id))

    return {
      ok: true as const,
      decision: "approve" as const,
      requestId: stored.id,
      createdUserId: createdUser.id,
      email: stored.email,
      firstName: stored.firstName,
      username: stored.username,
      role: scope.role,
      organizationName: organization.name,
    }
  })
}

/** Normalisation applied once, so the stored row and the checks agree. */
export function normalizeJoinSubmissionIdentity(input: {
  email: string
  username: string
  phone?: string | null
  employeeId?: string | null
}) {
  return {
    email: normalizeEmail(input.email),
    username: input.username.trim().toLowerCase(),
    phone: normalizeOptionalText(input.phone),
    employeeId: normalizeOptionalText(input.employeeId),
  }
}
