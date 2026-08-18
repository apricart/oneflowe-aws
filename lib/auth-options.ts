import type { NextAuthOptions } from "next-auth"
import { randomUUID } from "node:crypto"
import Credentials from "next-auth/providers/credentials"
import { db } from "@/lib/db"
import { users,roles,employeeCredentials,organizations,branches } from "@/db/schema"
import { eq,and,isNull,sql,or } from "drizzle-orm"
import { verifyPassword } from "@/lib/password"
import { verifyOTP,clearDailyCount } from "@/lib/mfa"
import { compare } from "bcryptjs"
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

const SESSION_REGISTRY_STATUS_FIELD = "sessionRegistryStatus"

// Surfaced to the login page so it can explain that the tenant restricts login
// to its own network. Raised only after the password has already been verified,
// so it never reveals anything to an unauthenticated caller.
const NETWORK_RESTRICTED_ERROR = "NETWORK_RESTRICTED"

// Reuses the existing sanitized transport error: an unreadable policy is a
// temporary backend failure, not a decision about this principal.
const NETWORK_UNAVAILABLE_ERROR = "AUTH_DATABASE_ERROR"

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

        const [u] = await db
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
            hash: users.passwordHash,
            roleId: users.roleId,
            organizationId: users.organizationId,
            branchId: users.branchId,
            fullName: users.fullName,
            mfaEnabled: users.mfaEnabled,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(and(or(eq(users.username, username), sql`lower(${users.email}) = ${username}`), isNull(users.deletedAt)))
        if (!u) return null

        const ok = await verifyPassword(password, u.hash)
        if (!ok) return null

        // Check organization status
        if (u.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, u.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (u.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, u.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check user status
        if (!u.isActive) {
          throw new Error('USER_INACTIVE')
        }

        const [r] = await db.select().from(roles).where(eq(roles.id, u.roleId))
        const roleName = r?.name || "BRANCH_ADMIN"

        // Checked before the MFA branch so a restricted user never triggers an
        // OTP they could not complete a login with.
        await assertLoginNetworkAccess(roleName, u.organizationId)

        // Check if MFA is enabled for this user
        if (u.mfaEnabled) {
          // Return special error to trigger MFA flow
          // Cooldown will be checked when sending OTP, not during initial login
          throw new Error("MFA_REQUIRED")
        }

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

        // Verify credentials first
        const [u] = await db
          .select({
            id: users.id,
            username: users.username,
            email: users.email,
            hash: users.passwordHash,
            roleId: users.roleId,
            organizationId: users.organizationId,
            branchId: users.branchId,
            fullName: users.fullName,
            mfaEnabled: users.mfaEnabled,
            isActive: users.isActive,
            sessionVersion: users.sessionVersion,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(and(or(eq(users.username, username), sql`lower(${users.email}) = ${username}`), isNull(users.deletedAt)))
        if (!u) return null

        const ok = await verifyPassword(password, u.hash)
        if (!ok) return null

        // Check organization status
        if (u.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, u.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (u.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, u.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check user status
        if (!u.isActive) {
          throw new Error('USER_INACTIVE')
        }

        if (!u.mfaEnabled) return null

        const [r] = await db.select().from(roles).where(eq(roles.id, u.roleId))
        const roleName = r?.name || "BRANCH_ADMIN"

        // Checked before the OTP is consumed so a restricted user cannot burn
        // a valid code on a login that will be refused anyway.
        await assertLoginNetworkAccess(roleName, u.organizationId)

        // Verify OTP
        const mfaResult = await verifyOTP(u.id, otp, 'LOGIN')
        if (!mfaResult.success) {
          throw new Error(mfaResult.message)
        }

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
        if (!username || !password) {
          return null
        }

        const [emp] = await db
          .select()
          .from(employeeCredentials)
          .where(or(eq(employeeCredentials.username, username), sql`lower(${employeeCredentials.email}) = ${username}`))

        if (!emp) {
          return null
        }



        const passwordMatch = await compare(password, emp.passwordHash)
        if (!passwordMatch) {
          return null
        }

        // Check organization status
        if (emp.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, emp.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (emp.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, emp.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

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

        const [emp] = await db
          .select()
          .from(employeeCredentials)
          .where(or(eq(employeeCredentials.username, username), sql`lower(${employeeCredentials.email}) = ${username}`))

        if (!emp) return null

        const passwordMatch = await compare(password, emp.passwordHash)
        if (!passwordMatch) return null

        // Check organization status
        if (emp.organizationId) {
          const [org] = await db
            .select({ status: organizations.status })
            .from(organizations)
            .where(eq(organizations.id, emp.organizationId))
            .limit(1)

          if (!org || org.status?.toLowerCase() !== 'active') {
            throw new Error('ORGANIZATION_INACTIVE')
          }
        }

        // Check branch status
        if (emp.branchId) {
          const [branch] = await db
            .select({ status: branches.status })
            .from(branches)
            .where(eq(branches.id, emp.branchId))
            .limit(1)

          if (!branch || branch.status?.toLowerCase() !== 'active') {
            throw new Error('BRANCH_INACTIVE')
          }
        }

        // Check employee status
        if (!emp.isActive) {
          throw new Error('USER_INACTIVE')
        }

        if (!emp.mfaEnabled || !emp.mfaSecret) return null

        // Checked before the OTP is consumed so a restricted employee cannot
        // burn a valid code on a login that will be refused anyway.
        await assertLoginNetworkAccess("EMPLOYEE", emp.organizationId)

        // Verify OTP for employee
        const mfaResult = await verifyOTP(`emp_${emp.id}`, otp, 'LOGIN')
        if (!mfaResult.success) {
          throw new Error(mfaResult.message)
        }

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
