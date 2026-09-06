import type { NextAuthOptions } from "next-auth"
import { randomUUID } from "node:crypto"
import Credentials from "next-auth/providers/credentials"
import { db } from "@/lib/db"
import { users,roles,employeeCredentials,organizations,branches } from "@/db/schema"
import { eq,and,isNull,sql,or } from "drizzle-orm"
import { verifyPassword } from "@/lib/password"
import { verifyOTP,clearDailyCount } from "@/lib/mfa"
import { bcryptCompare as compare } from "@/lib/server/password-hasher"
import { getSessionValidationCache,setSessionValidationCache } from "@/lib/session-validation-cache"
import { env } from "@/lib/server/env"
import {
  getEffectiveSessionExpiresAt,
  getSessionNonIdleExpirationReason,
  isSessionActivityUpdate,
  issueSessionPolicyClaims,
  readSessionPolicyClaims,
  SESSION_ABSOLUTE_TIMEOUT_SECONDS,
} from "@/lib/session-policy"
import { resolveSessionIdleTimeoutMinutes } from "@/lib/server/session-policy"
import {
  advanceAuthSessionRecord,
  createAuthSessionRecord,
  revokeAuthSessionFromToken,
  validateAuthSessionRecord,
  type SessionRegistryIdentity,
} from "@/lib/server/auth-session-store"
import { sessionValidationUnavailablePayload } from "@/lib/session-response"
import {
  evaluateNetworkAccess,
  type NetworkAccessDecision,
} from "@/lib/server/network-policy"
import { resolveRequestClientIp } from "@/lib/server/request-ip"
import {
  recordAuthAuditEvent,
  type AuthFailureReason,
} from "@/lib/server/auth-audit"
import {
  ACCOUNT_LOCKED_ERROR,
  clearFailedLogins,
  evaluateLockout,
  registerFailedLogin,
  type LockoutPrincipal,
  type LockoutState,
} from "@/lib/server/auth-lockout"

const SESSION_REGISTRY_STATUS_FIELD = "sessionRegistryStatus"

/**
 * Everything the audit trail knows about one sign-in attempt. Starts with only
 * the typed identifier and is filled in by the provider as the account, tenant
 * and role are resolved, so a failure at any stage still records what was known
 * at that point.
 */
type AuthAttemptContext = {
  provider: string
  attemptedIdentifier: string
  subjectId: string | null
  email: string | null
  role: string | null
  organizationId: number | null
  branchId: number | null
  /** Set once a specific event has already been recorded for this attempt. */
  audited: boolean
}

function attemptContext(
  provider: string,
  attemptedIdentifier: string,
): AuthAttemptContext {
  return {
    provider,
    attemptedIdentifier,
    subjectId: null,
    email: null,
    role: null,
    organizationId: null,
    branchId: null,
    audited: false,
  }
}

/**
 * Wraps a provider so that every terminal outcome reaches the audit trail
 * exactly once, including the sentinel errors thrown deep inside the flow.
 *
 * The inner function records the outcomes only it can describe (a wrong
 * password, a lockout) and marks the context audited; everything else is
 * classified here from the thrown sentinel.
 */
async function auditedAuthorize(
  provider: string,
  attemptedIdentifier: string,
  run: (context: AuthAttemptContext) => Promise<any>,
): Promise<any> {
  const context = attemptContext(provider, attemptedIdentifier)

  try {
    const principal = await run(context)

    if (!principal) {
      // A provider returns null without auditing only when no account matched.
      if (!context.audited) {
        await recordAuthAuditEvent({
          ...auditIdentity(context),
          action: "AUTH_LOGIN_FAILURE",
          success: false,
          reason: "unknown_account",
        })
      }
      return null
    }

    await recordAuthAuditEvent({
      ...auditIdentity(context),
      action: "AUTH_LOGIN_SUCCESS",
      success: true,
    })
    return principal
  } catch (error) {
    if (!context.audited) {
      const code = error instanceof Error ? error.message : String(error)
      const reason = AUTH_FAILURE_REASONS[code]
      await recordAuthAuditEvent({
        ...auditIdentity(context),
        // A first factor that passed and now awaits an OTP is a distinct event
        // from a rejected credential, and must not read as a failed login.
        action: reason === "mfa_required" ? "AUTH_MFA_CHALLENGE" : "AUTH_LOGIN_FAILURE",
        success: false,
        reason,
        errorMessage: reason ? null : code,
      })
    }
    throw error
  }
}

function auditIdentity(context: AuthAttemptContext) {
  return {
    provider: context.provider,
    attemptedIdentifier: context.attemptedIdentifier,
    subjectId: context.subjectId,
    email: context.email,
    role: context.role,
    organizationId: context.organizationId,
    branchId: context.branchId,
  }
}

/**
 * Refuse a locked account before its password is verified, so a lockout cannot
 * be probed for a correct password and every attempt against a locked account
 * is equally cheap.
 */
async function assertAccountNotLocked(
  principal: LockoutPrincipal,
  state: LockoutState,
  context: AuthAttemptContext,
): Promise<void> {
  const decision = evaluateLockout(state)
  if (!decision.locked) return

  context.audited = true
  await recordAuthAuditEvent({
    ...auditIdentity(context),
    action: "AUTH_LOCKOUT_BLOCKED",
    success: false,
    reason: "account_locked",
    details: {
      lockoutUntil: decision.until.toISOString(),
      retryAfterSeconds: decision.retryAfterSeconds,
    },
  })
  throw new Error(ACCOUNT_LOCKED_ERROR)
}

async function recordLockoutApplied(
  context: AuthAttemptContext,
  lockoutUntil: Date | null,
  threshold: number,
): Promise<never> {
  await recordAuthAuditEvent({
    ...auditIdentity(context),
    action: "AUTH_ACCOUNT_LOCKED",
    success: false,
    reason: "account_locked",
    details: { lockoutUntil: lockoutUntil?.toISOString() ?? null, threshold },
  })
  throw new Error(ACCOUNT_LOCKED_ERROR)
}

/**
 * Record a specific rejection and return null, preserving the "null means
 * CredentialsSignin" contract while keeping the audit trail accurate.
 */
async function rejectWithReason(
  context: AuthAttemptContext,
  reason: AuthFailureReason,
): Promise<null> {
  context.audited = true
  await recordAuthAuditEvent({
    ...auditIdentity(context),
    action: "AUTH_LOGIN_FAILURE",
    success: false,
    reason,
  })
  return null
}

/**
 * Count one wrong password against the account and report it. Returns null so a
 * provider can `return registerInvalidPassword(...)`, preserving the existing
 * "null means CredentialsSignin" contract, unless this attempt applied the lock.
 */
async function registerInvalidPassword(
  principal: LockoutPrincipal,
  context: AuthAttemptContext,
): Promise<null> {
  const result = await registerFailedLogin(principal)
  context.audited = true

  await recordAuthAuditEvent({
    ...auditIdentity(context),
    action: "AUTH_LOGIN_FAILURE",
    success: false,
    reason: "invalid_password",
    details: { failedAttempts: result.attempts, threshold: result.threshold },
  })

  if (result.lockedNow) {
    await recordLockoutApplied(context, result.lockoutUntil, result.threshold)
  }
  return null
}

/**
 * Count a rejected OTP against the same account budget. The MFA module applies
 * its own verification cooldown, but a second factor under brute force is
 * exactly what the account lockout exists to stop, so both apply.
 */
async function registerInvalidMfa(
  principal: LockoutPrincipal,
  context: AuthAttemptContext,
  message: string,
): Promise<never> {
  const result = await registerFailedLogin(principal)
  context.audited = true

  await recordAuthAuditEvent({
    ...auditIdentity(context),
    action: "AUTH_MFA_FAILURE",
    success: false,
    reason: "mfa_invalid",
    details: { failedAttempts: result.attempts, threshold: result.threshold },
  })

  if (result.lockedNow) {
    await recordLockoutApplied(context, result.lockoutUntil, result.threshold)
  }
  throw new Error(message)
}

// Surfaced to the login page so it can explain that the tenant restricts login
// to its own network. Raised only after the password has already been verified,
// so it never reveals anything to an unauthenticated caller.
const NETWORK_RESTRICTED_ERROR = "NETWORK_RESTRICTED"

// Reuses the existing sanitized transport error: an unreadable policy is a
// temporary backend failure, not a decision about this principal.
const NETWORK_UNAVAILABLE_ERROR = "AUTH_DATABASE_ERROR"

/**
 * Maps the sentinel errors the providers throw onto the closed reason set.
 * An error absent from this map is an unexpected failure, recorded with its
 * message rather than being forced into a reason that would misreport it.
 */
const AUTH_FAILURE_REASONS: Record<string, AuthFailureReason> = {
  ORGANIZATION_INACTIVE: "organization_inactive",
  BRANCH_INACTIVE: "branch_inactive",
  USER_INACTIVE: "user_inactive",
  MFA_REQUIRED: "mfa_required",
  [NETWORK_RESTRICTED_ERROR]: "network_restricted",
  [NETWORK_UNAVAILABLE_ERROR]: "network_unavailable",
  [ACCOUNT_LOCKED_ERROR]: "account_locked",
}

type SessionDatabaseValidation = "valid" | "invalid" | "unavailable"

type SessionDbUser = {
  isActive: boolean
  deletedAt: Date | null
  sessionVersion: number
  organizationId: number | null
  branchId: number | null
  role: string | null
  orgStatus: string | null
  branchStatus: string | null
}

function assignTokenToSessionUser(session: any, token: any): void {
  Object.assign(session.user, {
    id: token.sub,
    role: token.role,
    organizationId: token.organizationId,
    branchId: token.branchId,
    fullName: token.fullName,
    username: token.username,
    isEmployee: token.isEmployee,
    employeeId: token.employeeId,
    mustChangePassword: token.mustChangePassword ?? false,
  })
}

async function loadSessionDbUser(
  userId: string,
  isEmployee: boolean,
): Promise<SessionDbUser | null> {
  if (isEmployee) {
    if (!/^emp_[1-9]\d*$/.test(userId)) return null
    const numericId = Number.parseInt(userId.slice(4), 10)
    const [employee] = await db
      .select({
        isActive: employeeCredentials.isActive,
        deletedAt: sql<Date | null>`NULL`,
        sessionVersion: employeeCredentials.sessionVersion,
        organizationId: employeeCredentials.organizationId,
        branchId: employeeCredentials.branchId,
        role: sql<string>`'EMPLOYEE'`,
        orgStatus: organizations.status,
        branchStatus: branches.status,
      })
      .from(employeeCredentials)
      .leftJoin(
        organizations,
        eq(employeeCredentials.organizationId, organizations.id),
      )
      .leftJoin(branches, eq(employeeCredentials.branchId, branches.id))
      .where(eq(employeeCredentials.id, numericId))
      .limit(1)
    return employee as SessionDbUser | null
  }

  const [user] = await db
    .select({
      isActive: users.isActive,
      deletedAt: users.deletedAt,
      sessionVersion: users.sessionVersion,
      organizationId: users.organizationId,
      branchId: users.branchId,
      role: roles.name,
      orgStatus: organizations.status,
      branchStatus: branches.status,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .leftJoin(organizations, eq(users.organizationId, organizations.id))
    .leftJoin(branches, eq(users.branchId, branches.id))
    .where(eq(users.id, userId))
    .limit(1)
  return user as SessionDbUser | null
}

function invalidSessionReason(
  dbUser: SessionDbUser | null,
  token: any,
  isEmployee: boolean,
  tokenOrgId: number | null,
  tokenBranchId: number | null,
): string | null {
  if (!dbUser || !dbUser.isActive || (dbUser.deletedAt && !isEmployee) || dbUser.sessionVersion !== token.sessionVersion) {
    return "Status/Version mismatch"
  }
  if (dbUser.organizationId !== tokenOrgId) return "Organization assignment changed"
  if (dbUser.branchId !== tokenBranchId) return "Branch assignment changed"
  if (dbUser.role !== token.role) return "Role assignment changed"
  if (tokenOrgId && dbUser.orgStatus?.toLowerCase() !== 'active') return "Org deactivated"
  if (tokenBranchId && dbUser.branchStatus?.toLowerCase() !== 'active') return "Branch deactivated"
  return null
}

/**
 * Enforce a tenant's private-network restriction during sign-in.
 *
 * Called after the password has been verified and after the account/org/branch
 * status checks, matching how ORGANIZATION_INACTIVE and BRANCH_INACTIVE behave:
 * an anonymous caller learns nothing, and an MFA code is never sent to someone
 * who could not complete the login anyway.
 */
async function assertLoginNetworkAccess(
  role: string,
  organizationId: number | null,
): Promise<void> {
  const decision = await evaluateNetworkAccess({
    role,
    organizationId,
    clientIp: await resolveRequestClientIp(),
  })

  if (decision === "denied") throw new Error(NETWORK_RESTRICTED_ERROR)
  if (decision === "unavailable") throw new Error(NETWORK_UNAVAILABLE_ERROR)
}

/**
 * Re-check the restriction for an already-issued token so moving off the
 * tenant's network ends the session rather than merely blocking the next login.
 *
 * Intentionally outside the Redis session-validation cache, which is keyed by
 * user and would otherwise mask an address change for the whole TTL.
 */
async function evaluateSessionNetworkAccess(token: any): Promise<NetworkAccessDecision> {
  return evaluateNetworkAccess({
    role: typeof token.role === "string" ? token.role : null,
    organizationId: tokenScopeId(token.organizationId),
    clientIp: await resolveRequestClientIp(),
  })
}

/**
 * Revoke a session the server has decided to reject. A failed revocation is
 * reported as unavailable rather than success, so a rejected session is never
 * reported as cleanly ended while its registry record is still live.
 */
async function revokeRejectedSession(token: any): Promise<"revoked" | "unavailable"> {
  try {
    await revokeAuthSessionFromToken(token)
    return "revoked"
  } catch (error) {
    console.error("[Auth] Session revocation after identity rejection failed:", error)
    return "unavailable"
  }
}

function tokenScopeId(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function registryIdentityFromToken(
  token: Record<string, unknown>,
): SessionRegistryIdentity | null {
  const policy = readSessionPolicyClaims(token)
  if (
    !policy ||
    typeof token.sessionId !== "string" ||
    typeof token.sub !== "string"
  ) {
    return null
  }

  return {
    sessionId: token.sessionId,
    subjectId: token.sub,
    organizationId: tokenScopeId(token.organizationId),
    sessionStartedAt: policy.sessionStartedAt,
    sessionAbsoluteExpiresAt: policy.sessionAbsoluteExpiresAt,
  }
}

async function validateSessionTokenAgainstDatabase(
  token: any,
): Promise<SessionDatabaseValidation> {
  try {
    const userId = token.sub as string
    if (!userId || typeof userId !== "string") return "invalid"

    const isEmployee = token.isEmployee === true
    const tokenOrgId = tokenScopeId(token.organizationId)
    const tokenBranchId = tokenScopeId(token.branchId)
    const tokenRole = typeof token.role === "string" ? token.role : null
    const tokenSessionVersion = typeof token.sessionVersion === "number" ? token.sessionVersion : null
    if (!tokenRole || tokenSessionVersion === null) return "invalid"

    const cachedValidation = await getSessionValidationCache(userId)
    if (
      cachedValidation &&
      cachedValidation.sv === tokenSessionVersion &&
      cachedValidation.org === tokenOrgId &&
      cachedValidation.br === tokenBranchId &&
      cachedValidation.role === tokenRole
    ) {
      return "valid"
    }

    const dbUser = await loadSessionDbUser(userId, isEmployee)
    const invalidReason = invalidSessionReason(dbUser, token, isEmployee, tokenOrgId, tokenBranchId)
    if (invalidReason) {
      console.log(`[Auth] Invalidating session for user ${userId}: ${invalidReason}`)
      return "invalid"
    }

    await setSessionValidationCache(userId, {
      sv: tokenSessionVersion,
      org: tokenOrgId,
      br: tokenBranchId,
      role: tokenRole,
    })
    return "valid"
  } catch (error) {
    console.error("[Auth] Session validation error:", error)
    return "unavailable"
  }
}

async function registerAuthenticatedSessionToken(token: any, user: any) {
  token.role = user.role
  token.organizationId = user.organizationId
  token.branchId = user.branchId
  token.fullName = user.fullName
  token.username = user.username
  token.isEmployee = user.isEmployee
  token.employeeId = user.employeeId
  token.sessionVersion = user.sessionVersion
  token.mustChangePassword = user.mustChangePassword ?? false

  const idleTimeoutMinutes = await resolveSessionIdleTimeoutMinutes(
    token.organizationId,
  )
  const policy = issueSessionPolicyClaims(Date.now(), idleTimeoutMinutes)
  const sessionId = randomUUID()
  if (typeof token.sub !== "string" || token.sub.length === 0) {
    throw new TypeError("Authenticated principal is missing a subject")
  }

  token.sessionId = sessionId
  Object.assign(token, policy)
  await createAuthSessionRecord({
    sessionId,
    subjectId: token.sub,
    organizationId: tokenScopeId(token.organizationId),
    claims: policy,
  })
  token[SESSION_REGISTRY_STATUS_FIELD] = "valid"
  return token
}

async function rejectActivityAndRevoke(token: any): Promise<boolean> {
  if (await revokeRejectedSession(token) === "revoked") {
    token.sessionInvalidReason = "invalid_policy"
  } else {
    token[SESSION_REGISTRY_STATUS_FIELD] = "unavailable"
  }
  return true
}

async function activityIdentityRejected(token: any): Promise<boolean> {
  // A session that left the tenant's network must not renew its idle deadline.
  const networkAccess = await evaluateSessionNetworkAccess(token)
  if (networkAccess === "unavailable") {
    token[SESSION_REGISTRY_STATUS_FIELD] = "unavailable"
    return true
  }
  if (networkAccess === "denied") return rejectActivityAndRevoke(token)

  const databaseValidation = await validateSessionTokenAgainstDatabase(token)
  if (databaseValidation === "valid") return false
  if (databaseValidation === "unavailable") {
    token[SESSION_REGISTRY_STATUS_FIELD] = "unavailable"
    return true
  }

  return rejectActivityAndRevoke(token)
}

async function refreshRegisteredSessionToken(
  token: any,
  trigger: string | undefined,
  session: unknown,
) {
  // Missing/malformed policy claims identify a pre-deployment or invalid
  // token. Never grant such a token a fresh lifetime during migration.
  const now = Date.now()
  const existingExpirationReason = getSessionNonIdleExpirationReason(token, now)
  if (existingExpirationReason) {
    token.sessionInvalidReason = existingExpirationReason
    return token
  }

  const registryIdentity = registryIdentityFromToken(token)
  if (!registryIdentity) {
    token.sessionInvalidReason = "invalid_policy"
    return token
  }

  const recordActivity =
    trigger === "update" && isSessionActivityUpdate(session)
  // A transient or deterministic identity-validation failure must never mint
  // a later idle deadline.
  if (recordActivity && await activityIdentityRejected(token)) return token

  const idleTimeoutMinutes = await resolveSessionIdleTimeoutMinutes(
    token.organizationId,
    token.sessionIdleTimeoutMinutes,
  )
  const signedPolicy = readSessionPolicyClaims(token)
  if (!signedPolicy) {
    token.sessionInvalidReason = "invalid_policy"
    return token
  }

  // A policy increase may extend only a session that is still live under its
  // previously signed timeout. A decrease applies immediately.
  const validationIdleTimeoutMinutes = Math.min(
    signedPolicy.sessionIdleTimeoutMinutes,
    idleTimeoutMinutes,
  )
  const registryResult = recordActivity
    ? await advanceAuthSessionRecord(
        registryIdentity,
        validationIdleTimeoutMinutes,
        now,
      )
    : await validateAuthSessionRecord(
        registryIdentity,
        validationIdleTimeoutMinutes,
        now,
      )

  if (registryResult.kind === "unavailable") {
    console.error(
      "[Auth] Session registry validation unavailable:",
      registryResult.error,
    )
    token[SESSION_REGISTRY_STATUS_FIELD] = "unavailable"
    return token
  }
  if (registryResult.kind === "invalid") {
    token.sessionInvalidReason = registryResult.reason
    return token
  }

  delete token.sessionInvalidReason
  Object.assign(token, registryResult.claims, {
    // Passive reads do not write a repair cookie. Explicit activity can safely
    // adopt a relaxed policy only after atomically passing the old timeout.
    sessionIdleTimeoutMinutes: recordActivity
      ? idleTimeoutMinutes
      : validationIdleTimeoutMinutes,
  })
  token[SESSION_REGISTRY_STATUS_FIELD] = "valid"
  return token
}

function isActiveStatus(status: string | null | undefined): boolean {
  return status?.toLowerCase() === "active"
}

/**
 * Reject a principal whose tenant scope is no longer active.
 *
 * The statuses are read alongside the account rather than afterwards, but they
 * are still evaluated only after the password has been verified, in the same
 * order as before: an anonymous caller learns nothing new, because the response
 * for an unauthenticated attempt is identical either way.
 */
function assertTenantScopeActive(scope: {
  organizationId: number | null
  organizationStatus: string | null
  branchId: number | null
  branchStatus: string | null
}): void {
  if (scope.organizationId && !isActiveStatus(scope.organizationStatus)) {
    throw new Error("ORGANIZATION_INACTIVE")
  }

  if (scope.branchId && !isActiveStatus(scope.branchStatus)) {
    throw new Error("BRANCH_INACTIVE")
  }
}

/**
 * Resolve a staff account, its tenant scope status and its role in one query.
 *
 * `lower(email)` is matched against the `users_email_lower_idx` functional
 * index so the OR can be planned as a bitmap of two index scans instead of a
 * sequential scan of every user.
 *
 * Email only resolves an account created in OneFlowe itself. An account
 * mirrored from another system (`external_source` set) must be named by its
 * username, because such a person holds one account per role — one to place
 * orders, one to approve them — behind a single shared email address. Matching
 * that email would pick whichever row the index reached first and drop the
 * person into an arbitrary one of their two portals. Accounts created through
 * the portal leave `external_source` null and are unaffected.
 */
async function loadStaffLoginRecord(username: string) {
  const [record] = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      hash: users.passwordHash,
      organizationId: users.organizationId,
      branchId: users.branchId,
      fullName: users.fullName,
      mfaEnabled: users.mfaEnabled,
      isActive: users.isActive,
      sessionVersion: users.sessionVersion,
      mustChangePassword: users.mustChangePassword,
      failedLoginAttempts: users.failedLoginAttempts,
      lockoutUntil: users.lockoutUntil,
      organizationStatus: organizations.status,
      branchStatus: branches.status,
      roleName: roles.name,
    })
    .from(users)
    .leftJoin(organizations, eq(users.organizationId, organizations.id))
    .leftJoin(branches, eq(users.branchId, branches.id))
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      or(
        eq(users.username, username),
        and(sql`lower(${users.email}) = ${username}`, isNull(users.externalSource)),
      ),
      isNull(users.deletedAt),
    ))
    .limit(1)

  return record
}

async function authorizeStaffPassword(
  username: string,
  password: string,
  context: AuthAttemptContext,
): Promise<any> {
  const u = await loadStaffLoginRecord(username)
  if (!u) return null

  const lockoutPrincipal: LockoutPrincipal = { kind: "user", id: u.id }
  context.subjectId = u.id
  context.email = u.email
  context.organizationId = u.organizationId
  context.branchId = u.branchId

  await assertAccountNotLocked(lockoutPrincipal, u, context)

  const ok = await verifyPassword(password, u.hash)
  if (!ok) return registerInvalidPassword(lockoutPrincipal, context)

  // Check organization and branch status
  assertTenantScopeActive(u)

  // Check user status
  if (!u.isActive) {
    throw new Error('USER_INACTIVE')
  }

  const roleName = u.roleName || "BRANCH_ADMIN"
  context.role = roleName

  // Checked before the MFA branch so a restricted user never triggers an
  // OTP they could not complete a login with.
  await assertLoginNetworkAccess(roleName, u.organizationId)

  // Check if MFA is enabled for this user
  if (u.mfaEnabled) {
    // Return special error to trigger MFA flow
    // Cooldown will be checked when sending OTP, not during initial login
    throw new Error("MFA_REQUIRED")
  }

  // A completed authentication ends the brute-force run against this
  // account, so the counters must not persist into the next attempt.
  await clearFailedLogins(lockoutPrincipal)

  // Clear daily count after successful login (for non-MFA users)
  await clearDailyCount(u.id)

  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: roleName,
    organizationId: u.organizationId,
    branchId: u.branchId,
    fullName: u.fullName,
    isEmployee: false,
    sessionVersion: u.sessionVersion,
    mustChangePassword: u.mustChangePassword,
  } as any
}

async function authorizeStaffMfa(
  username: string,
  password: string,
  otp: string,
  context: AuthAttemptContext,
): Promise<any> {
  // Verify credentials first
  const u = await loadStaffLoginRecord(username)
  if (!u) return null

  const lockoutPrincipal: LockoutPrincipal = { kind: "user", id: u.id }
  context.subjectId = u.id
  context.email = u.email
  context.organizationId = u.organizationId
  context.branchId = u.branchId

  await assertAccountNotLocked(lockoutPrincipal, u, context)

  const ok = await verifyPassword(password, u.hash)
  if (!ok) return registerInvalidPassword(lockoutPrincipal, context)

  // Check organization and branch status
  assertTenantScopeActive(u)

  // Check user status
  if (!u.isActive) {
    throw new Error('USER_INACTIVE')
  }

  if (!u.mfaEnabled) return rejectWithReason(context, "mfa_not_enrolled")

  const roleName = u.roleName || "BRANCH_ADMIN"
  context.role = roleName

  // Checked before the OTP is consumed so a restricted user cannot burn
  // a valid code on a login that will be refused anyway.
  await assertLoginNetworkAccess(roleName, u.organizationId)

  // Verify OTP
  const mfaResult = await verifyOTP(u.id, otp, 'LOGIN')
  if (!mfaResult.success) {
    await registerInvalidMfa(lockoutPrincipal, context, mfaResult.message)
  }

  await clearFailedLogins(lockoutPrincipal)

  // Clear daily count after successful login
  await clearDailyCount(u.id)

  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: roleName,
    organizationId: u.organizationId,
    branchId: u.branchId,
    fullName: u.fullName,
    isEmployee: false,
    sessionVersion: u.sessionVersion,
    mustChangePassword: u.mustChangePassword,
  } as any
}

/**
 * Resolve an employee account together with its tenant scope status.
 *
 * `lower(email)` is matched against the `employee_creds_email_lower_idx`
 * functional index, for the same reason as the staff lookup.
 */
async function loadEmployeeLoginRecord(username: string) {
  const [record] = await db
    .select({
      employee: employeeCredentials,
      organizationStatus: organizations.status,
      branchStatus: branches.status,
    })
    .from(employeeCredentials)
    .leftJoin(
      organizations,
      eq(employeeCredentials.organizationId, organizations.id),
    )
    .leftJoin(branches, eq(employeeCredentials.branchId, branches.id))
    .where(or(eq(employeeCredentials.username, username), sql`lower(${employeeCredentials.email}) = ${username}`))
    .limit(1)

  return record
}

async function authorizeEmployeePassword(
  username: string,
  password: string,
  context: AuthAttemptContext,
): Promise<any> {
  const record = await loadEmployeeLoginRecord(username)

  if (!record) {
    return null
  }

  const emp = record.employee
  const lockoutPrincipal: LockoutPrincipal = { kind: "employee", id: emp.id }
  context.subjectId = `emp_${emp.id}`
  context.email = emp.email
  context.role = "EMPLOYEE"
  context.organizationId = emp.organizationId
  context.branchId = emp.branchId

  await assertAccountNotLocked(lockoutPrincipal, emp, context)

  const passwordMatch = await compare(password, emp.passwordHash)
  if (!passwordMatch) {
    return registerInvalidPassword(lockoutPrincipal, context)
  }

  // Check organization and branch status
  assertTenantScopeActive({
    organizationId: emp.organizationId,
    organizationStatus: record.organizationStatus,
    branchId: emp.branchId,
    branchStatus: record.branchStatus,
  })

  // Check employee status (already filtered by isActive in WHERE, but explicit check for clarity)
  if (!emp.isActive) {
    throw new Error('USER_INACTIVE')
  }

  // Checked before the MFA branch so a restricted employee never triggers
  // an OTP they could not complete a login with.
  await assertLoginNetworkAccess("EMPLOYEE", emp.organizationId)

  // Check if MFA is enabled
  if (emp.mfaEnabled) {
    throw new Error("MFA_REQUIRED")
  }

  await clearFailedLogins(lockoutPrincipal)

  return {
    id: `emp_${emp.id}`,
    email: emp.email,
    username: emp.username,
    role: "EMPLOYEE",
    organizationId: emp.organizationId,
    branchId: emp.branchId,
    fullName: `${emp.firstName} ${emp.lastName}`.trim(),
    isEmployee: true,
    employeeId: emp.id,
    sessionVersion: emp.sessionVersion
  } as any
}

async function authorizeEmployeeMfa(
  username: string,
  password: string,
  otp: string,
  context: AuthAttemptContext,
): Promise<any> {
  const record = await loadEmployeeLoginRecord(username)

  if (!record) return null

  const emp = record.employee
  const lockoutPrincipal: LockoutPrincipal = { kind: "employee", id: emp.id }
  context.subjectId = `emp_${emp.id}`
  context.email = emp.email
  context.role = "EMPLOYEE"
  context.organizationId = emp.organizationId
  context.branchId = emp.branchId

  await assertAccountNotLocked(lockoutPrincipal, emp, context)

  const passwordMatch = await compare(password, emp.passwordHash)
  if (!passwordMatch) return registerInvalidPassword(lockoutPrincipal, context)

  // Check organization and branch status
  assertTenantScopeActive({
    organizationId: emp.organizationId,
    organizationStatus: record.organizationStatus,
    branchId: emp.branchId,
    branchStatus: record.branchStatus,
  })

  // Check employee status
  if (!emp.isActive) {
    throw new Error('USER_INACTIVE')
  }

  if (!emp.mfaEnabled || !emp.mfaSecret) {
    return rejectWithReason(context, "mfa_not_enrolled")
  }

  // Checked before the OTP is consumed so a restricted employee cannot
  // burn a valid code on a login that will be refused anyway.
  await assertLoginNetworkAccess("EMPLOYEE", emp.organizationId)

  // Verify OTP for employee
  const mfaResult = await verifyOTP(`emp_${emp.id}`, otp, 'LOGIN')
  if (!mfaResult.success) {
    await registerInvalidMfa(lockoutPrincipal, context, mfaResult.message)
  }

  await clearFailedLogins(lockoutPrincipal)

  return {
    id: `emp_${emp.id}`,
    email: emp.email,
    username: emp.username,
    role: "EMPLOYEE",
    organizationId: emp.organizationId,
    branchId: emp.branchId,
    fullName: `${emp.firstName} ${emp.lastName}`.trim(),
    isEmployee: true,
    employeeId: emp.id,
    sessionVersion: emp.sessionVersion
  } as any
}

export const authOptions: NextAuthOptions = {
  secret: env.NEXTAUTH_SECRET,
  useSecureCookies: env.NODE_ENV === "production",
  session: {
    strategy: "jwt",
    // NextAuth's maxAge remains a defense-in-depth cookie/JWT bound. The
    // immutable absolute and idle deadlines below are enforced independently,
    // because NextAuth refreshes its standard expiry on every session read.
    maxAge: SESSION_ABSOLUTE_TIMEOUT_SECONDS,
  },
  cookies: {
    sessionToken: {
      name: env.NODE_ENV === "production"
        ? "__Secure-next-auth.session-token"
        : "next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
    callbackUrl: {
      name: env.NODE_ENV === "production"
        ? "__Secure-next-auth.callback-url"
        : "next-auth.callback-url",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
    csrfToken: {
      name: env.NODE_ENV === "production"
        ? "__Host-next-auth.csrf-token"
        : "next-auth.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: env.NODE_ENV === "production",
      },
    },
  },
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        if (!username || !password) return null

        return auditedAuthorize("credentials", username, (context) =>
          authorizeStaffPassword(username, password, context),
        )
      },
    }),
    Credentials({
      id: "mfa-credentials",
      name: "mfa-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
        otp: { label: "OTP Code", type: "text" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        const otp = String(credentials?.otp || "")

        if (!username || !password || !otp) return null

        return auditedAuthorize("mfa-credentials", username, (context) =>
          authorizeStaffMfa(username, password, otp, context),
        )
      },
    }),
    // Employee Portal Login
    Credentials({
      id: "employee-credentials",
      name: "employee-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        if (!username || !password) return null

        return auditedAuthorize("employee-credentials", username, (context) =>
          authorizeEmployeePassword(username, password, context),
        )
      },
    }),
    // Employee MFA Login
    Credentials({
      id: "employee-mfa-credentials",
      name: "employee-mfa-credentials",
      credentials: {
        username: { label: "Username or Email", type: "text" },
        password: { label: "Password", type: "password" },
        otp: { label: "OTP Code", type: "text" },
      },
      async authorize(credentials) {
        const username = String(credentials?.username || "").trim().toLowerCase()
        const password = String(credentials?.password || "")
        const otp = String(credentials?.otp || "")

        if (!username || !password || !otp) return null

        return auditedAuthorize("employee-mfa-credentials", username, (context) =>
          authorizeEmployeeMfa(username, password, otp, context),
        )
      },
    }),
  ],
  callbacks: {
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`

      try {
        const parsed = new URL(url)
        return parsed.origin === new URL(baseUrl).origin ? parsed.toString() : baseUrl
      } catch {
        return baseUrl
      }
    },
    async jwt({ token, user, trigger, session }) {
      delete token[SESSION_REGISTRY_STATUS_FIELD]
      return user
        ? registerAuthenticatedSessionToken(token, user)
        : refreshRegisteredSessionToken(token, trigger, session)
    },
    async session({ session, token }) {
      if (token[SESSION_REGISTRY_STATUS_FIELD] === "unavailable") {
        return sessionValidationUnavailablePayload() as any
      }

      const expirationReason = getSessionNonIdleExpirationReason(token)
      if (expirationReason) {
        console.log("[Auth] Rejecting expired session", {
          userId: token.sub,
          reason: expirationReason,
        })
        return null as any
      }

      if (token[SESSION_REGISTRY_STATUS_FIELD] !== "valid") {
        return null as any
      }

      if (!session.user) return null as any

      const policy = readSessionPolicyClaims(token)
      const effectiveExpiresAt = getEffectiveSessionExpiresAt(token)
      if (!policy || !effectiveExpiresAt) return null as any

      assignTokenToSessionUser(session, token)
      session.expires = new Date(effectiveExpiresAt).toISOString()
      ;(session as any).idleTimeoutMinutes =
        policy.sessionIdleTimeoutMinutes

      // Checked on every session read so a tenant's restriction also ends
      // sessions that leave its network, not just new sign-ins. The policy
      // itself is cached, so this normally costs no database round-trip.
      const networkAccess = await evaluateSessionNetworkAccess(token)
      if (networkAccess === "unavailable") {
        return sessionValidationUnavailablePayload() as any
      }
      if (networkAccess === "denied") {
        return await revokeRejectedSession(token) === "revoked"
          ? (null as any)
          : (sessionValidationUnavailablePayload() as any)
      }

      const databaseValidation =
        await validateSessionTokenAgainstDatabase(token)
      if (databaseValidation === "unavailable") {
        return sessionValidationUnavailablePayload() as any
      }
      if (databaseValidation !== "valid") {
        return await revokeRejectedSession(token) === "revoked"
          ? (null as any)
          : (sessionValidationUnavailablePayload() as any)
      }
      return session
    },
  },
  pages: {
    signIn: "/login",
  },
}
