import "server-only"

import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { and, eq, gt, isNull, sql } from "drizzle-orm"

import {
  authSessions,
  branches,
  employeeCredentials,
  organizations,
  passwordResetChallenges,
  roles,
  sessions,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import { sendOTPEmail } from "@/lib/email"
import { logError } from "@/lib/global-logger"
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password"
import { ROLE_TEMPLATES } from "@/lib/permissions"
import { ORDER_PORTAL_NAME } from "@/lib/role-display-names"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { env } from "@/lib/server/env"
import { isRoutableEmailAddress } from "@/lib/validation/email"

export const PASSWORD_RESET_CODE_VALIDITY_MINUTES = 10
export const PASSWORD_RESET_TOKEN_VALIDITY_MINUTES = 10
export const PASSWORD_RESET_MAX_ATTEMPTS = 5
export const PASSWORD_RESET_DAILY_LIMIT = 10

export const PASSWORD_RESET_REQUEST_MESSAGE =
  "If an active account matches that username or email, a verification code has been sent."
export const PASSWORD_RESET_INVALID_CODE_MESSAGE =
  "The code is invalid or expired. Request a new code and try again."
export const PASSWORD_RESET_INVALID_TOKEN_MESSAGE =
  "This password reset has expired. Request a new code and try again."

type ResetSubjectType = "user" | "employee"

type ResetSubject = {
  subjectType: ResetSubjectType
  subjectId: string
  email: string
  username: string | null
  passwordHash: string
  role: string
  organizationId: number | null
  branchId: number | null
  organizationStatus: string | null
  branchStatus: string | null
}

type ResetAuditIdentity = {
  subjectId: string
  email: string
  role: string
  organizationId: number | null
  branchId: number | null
}

/**
 * The floor on how long the public request endpoint takes to answer. Sending
 * the email is already deferred past the response; this also covers the few
 * extra queries a real account costs, so response time is not an oracle.
 */
export const PASSWORD_RESET_REQUEST_MIN_RESPONSE_MS = 700

export type PasswordResetRequestOutcome = {
  challengeId: string
  /**
   * The slow half of the request — delivering the email and writing the audit
   * row. The route runs it after the response is sent. It is present for every
   * outcome, unknown accounts included, so the caller has no branch that
   * differs between them.
   */
  afterResponse: () => Promise<void>
}

/**
 * Deliberately carries no remaining-attempt count. A decoy challenge has no row
 * to count against, so a count shown only for real challenges would tell a
 * caller which usernames exist.
 */
export type VerifyPasswordResetOutcome =
  | { kind: "verified"; resetToken: string; validForSeconds: number }
  | { kind: "rejected" }

export type CompletePasswordResetOutcome =
  | { kind: "completed" }
  | { kind: "invalid_token" }
  | { kind: "password_unchanged" }
  | { kind: "invalid_password"; errors: string[] }

const CODE_VALIDITY_MS = PASSWORD_RESET_CODE_VALIDITY_MINUTES * 60 * 1000
const TOKEN_VALIDITY_MS = PASSWORD_RESET_TOKEN_VALIDITY_MINUTES * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

function normalizedStatusIsActive(value: string | null): boolean {
  return value?.trim().toLowerCase() === "active"
}

function subjectScopeIsActive(subject: ResetSubject): boolean {
  const organizationActive =
    subject.organizationId === null || normalizedStatusIsActive(subject.organizationStatus)
  const branchActive =
    subject.branchId === null || normalizedStatusIsActive(subject.branchStatus)
  return organizationActive && branchActive
}

function auditIdentity(subject: ResetSubject): ResetAuditIdentity {
  return {
    subjectId: subject.subjectId,
    email: subject.email,
    role: subject.role,
    organizationId: subject.organizationId,
    branchId: subject.branchId,
  }
}

function accountLabel(subject: ResetSubject): string {
  if (subject.subjectType === "employee") return `${ORDER_PORTAL_NAME} Employee`
  const template = (ROLE_TEMPLATES as Record<string, { name: string } | undefined>)[subject.role]
  return template?.name ?? subject.role
}

function digest(challengeId: string, purpose: "code" | "token", value: string): string {
  return createHmac("sha256", env.NEXTAUTH_SECRET)
    .update(`oneflowe-password-reset:v1:${purpose}:${challengeId}:${value}`)
    .digest("hex")
}

/** Exported for focused cryptographic contract tests; never accepts a secret from storage. */
export function passwordResetCodeDigest(challengeId: string, code: string): string {
  return digest(challengeId, "code", code)
}

/** Rate-limit identifiers without putting a username or email into Redis keys. */
export function passwordResetIdentifierDigest(identifier: string): string {
  return createHmac("sha256", env.NEXTAUTH_SECRET)
    .update(`oneflowe-password-reset:v1:identifier:${identifier.trim().toLowerCase()}`)
    .digest("hex")
}

function safeDigestEqual(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(candidate)) return false
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"))
}

function userSelection() {
  return {
    id: users.id,
    email: users.email,
    username: users.username,
    passwordHash: users.passwordHash,
    role: roles.name,
    organizationId: users.organizationId,
    branchId: users.branchId,
    organizationStatus: organizations.status,
    branchStatus: branches.status,
  }
}

async function findUsersByIdentifier(identifier: string, byEmail: boolean): Promise<ResetSubject[]> {
  const rows = await db
    .select(userSelection())
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .leftJoin(organizations, eq(users.organizationId, organizations.id))
    .leftJoin(branches, eq(users.branchId, branches.id))
    .where(and(
      byEmail
        ? and(sql`lower(${users.email}) = ${identifier}`, isNull(users.externalSource))
        : eq(users.username, identifier),
      isNull(users.deletedAt),
      eq(users.isActive, true),
    ))
    .limit(2)

  return rows.map((row) => ({
    subjectType: "user" as const,
    subjectId: row.id,
    email: row.email,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role ?? "BRANCH_ADMIN",
    organizationId: row.organizationId,
    branchId: row.branchId,
    organizationStatus: row.organizationStatus,
    branchStatus: row.branchStatus,
  }))
}

async function findEmployeesByIdentifier(identifier: string, byEmail: boolean): Promise<ResetSubject[]> {
  const rows = await db
    .select({
      id: employeeCredentials.id,
      email: employeeCredentials.email,
      username: employeeCredentials.username,
      passwordHash: employeeCredentials.passwordHash,
      organizationId: employeeCredentials.organizationId,
      branchId: employeeCredentials.branchId,
      organizationStatus: organizations.status,
      branchStatus: branches.status,
    })
    .from(employeeCredentials)
    .leftJoin(organizations, eq(employeeCredentials.organizationId, organizations.id))
    .leftJoin(branches, eq(employeeCredentials.branchId, branches.id))
    .where(and(
      byEmail
        ? sql`lower(${employeeCredentials.email}) = ${identifier}`
        : eq(employeeCredentials.username, identifier),
      eq(employeeCredentials.isActive, true),
    ))
    .limit(2)

  return rows.map((row) => ({
    subjectType: "employee" as const,
    subjectId: `emp_${row.id}`,
    email: row.email,
    username: row.username,
    passwordHash: row.passwordHash,
    role: "EMPLOYEE",
    organizationId: row.organizationId,
    branchId: row.branchId,
    organizationStatus: row.organizationStatus,
    branchStatus: row.branchStatus,
  }))
}

/**
 * Match login semantics without making an email shared by multiple accounts
 * pick an arbitrary role. A username tries the staff provider first, exactly
 * like the login page; an email is accepted only when it identifies one active
 * account across both credential stores.
 */
async function resolveSubject(identifierInput: string): Promise<ResetSubject | null> {
  const identifier = identifierInput.trim().toLowerCase()
  const byEmail = identifier.includes("@")

  if (!byEmail) {
    const staff = await findUsersByIdentifier(identifier, false)
    const subject = staff[0] ?? (await findEmployeesByIdentifier(identifier, false))[0] ?? null
    return subject && subjectScopeIsActive(subject) && isRoutableEmailAddress(subject.email)
      ? subject
      : null
  }

  const [staff, employees] = await Promise.all([
    findUsersByIdentifier(identifier, true),
    findEmployeesByIdentifier(identifier, true),
  ])
  const matches = [...staff, ...employees]
    .filter(subjectScopeIsActive)
    .filter((subject) => isRoutableEmailAddress(subject.email))
  return matches.length === 1 ? matches[0] : null
}

async function loadSubject(subjectType: ResetSubjectType, subjectId: string): Promise<ResetSubject | null> {
  if (subjectType === "user") {
    const [row] = await db
      .select(userSelection())
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .leftJoin(organizations, eq(users.organizationId, organizations.id))
      .leftJoin(branches, eq(users.branchId, branches.id))
      .where(and(eq(users.id, subjectId), isNull(users.deletedAt), eq(users.isActive, true)))
      .limit(1)
    if (!row) return null
    return {
      subjectType: "user",
      subjectId: row.id,
      email: row.email,
      username: row.username,
      passwordHash: row.passwordHash,
      role: row.role ?? "BRANCH_ADMIN",
      organizationId: row.organizationId,
      branchId: row.branchId,
      organizationStatus: row.organizationStatus,
      branchStatus: row.branchStatus,
    }
  }

  if (!/^emp_[1-9]\d*$/.test(subjectId)) return null
  const employeeId = Number.parseInt(subjectId.slice(4), 10)
  const [row] = await db
    .select({
      id: employeeCredentials.id,
      email: employeeCredentials.email,
      username: employeeCredentials.username,
      passwordHash: employeeCredentials.passwordHash,
      organizationId: employeeCredentials.organizationId,
      branchId: employeeCredentials.branchId,
      organizationStatus: organizations.status,
      branchStatus: branches.status,
    })
    .from(employeeCredentials)
    .leftJoin(organizations, eq(employeeCredentials.organizationId, organizations.id))
    .leftJoin(branches, eq(employeeCredentials.branchId, branches.id))
    .where(and(eq(employeeCredentials.id, employeeId), eq(employeeCredentials.isActive, true)))
    .limit(1)
  if (!row) return null
  return {
    subjectType: "employee",
    subjectId: `emp_${row.id}`,
    email: row.email,
    username: row.username,
    passwordHash: row.passwordHash,
    role: "EMPLOYEE",
    organizationId: row.organizationId,
    branchId: row.branchId,
    organizationStatus: row.organizationStatus,
    branchStatus: row.branchStatus,
  }
}

async function dailyRequestBudgetAvailable(subject: ResetSubject): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(passwordResetChallenges)
    .where(and(
      eq(passwordResetChallenges.subjectType, subject.subjectType),
      eq(passwordResetChallenges.subjectId, subject.subjectId),
      gt(passwordResetChallenges.createdAt, new Date(Date.now() - ONE_DAY_MS)),
    ))
  return (row?.count ?? 0) < PASSWORD_RESET_DAILY_LIMIT
}

function unavailableOutcome(
  identifier: string,
  subject: ResetSubject | null,
): PasswordResetRequestOutcome {
  return {
    challengeId: randomUUID(),
    afterResponse: () => recordAuthAuditEvent({
      action: "AUTH_PASSWORD_RESET_FAILURE",
      ...(subject ? auditIdentity(subject) : {}),
      attemptedIdentifier: identifier,
      success: false,
      reason: "password_reset_unavailable",
    }),
  }
}

async function deliverPasswordResetCode(input: {
  identifier: string
  subject: ResetSubject
  challengeId: string
  code: string
  expiresAt: Date
}): Promise<void> {
  const { identifier, subject, challengeId, code, expiresAt } = input
  try {
    const delivered = await sendOTPEmail(subject.email, code, "RESET_PASSWORD", {
      validForMinutes: PASSWORD_RESET_CODE_VALIDITY_MINUTES,
      account: {
        username: subject.username,
        accountLabel: accountLabel(subject),
      },
    })

    if (!delivered) {
      // A code nobody received must not stay guessable for its lifetime.
      await db
        .update(passwordResetChallenges)
        .set({ consumedAt: new Date() })
        .where(and(
          eq(passwordResetChallenges.id, challengeId),
          isNull(passwordResetChallenges.consumedAt),
        ))
      await recordAuthAuditEvent({
        action: "AUTH_PASSWORD_RESET_FAILURE",
        ...auditIdentity(subject),
        attemptedIdentifier: identifier,
        success: false,
        reason: "password_reset_unavailable",
        details: { challengeId, delivery: "failed" },
      })
      return
    }

    await recordAuthAuditEvent({
      action: "AUTH_PASSWORD_RESET_REQUESTED",
      ...auditIdentity(subject),
      attemptedIdentifier: identifier,
      success: true,
      details: { challengeId, expiresAt: expiresAt.toISOString() },
    })
  } catch (error) {
    logError(error, "PASSWORD_RESET_DELIVERY", { subjectId: subject.subjectId, challengeId })
  }
}

/**
 * Always returns an opaque id. Callers deliberately receive the same response
 * for unknown, ambiguous, inactive, throttled, unroutable and deliverable
 * accounts, preventing this public endpoint from becoming a directory. The
 * email is sent by `afterResponse`, never before the caller has its answer.
 */
export async function requestPasswordReset(identifier: string): Promise<PasswordResetRequestOutcome> {
  const subject = await resolveSubject(identifier)
  if (!subject || !(await dailyRequestBudgetAvailable(subject))) {
    return unavailableOutcome(identifier, subject)
  }

  const challengeId = randomUUID()
  const code = randomInt(100_000, 1_000_000).toString()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_VALIDITY_MS)

  try {
    await db.transaction(async (tx) => {
      // A resend invalidates every earlier code or verified bearer for this
      // principal. The partial unique index makes the invariant race-safe.
      await tx
        .update(passwordResetChallenges)
        .set({ consumedAt: now })
        .where(and(
          eq(passwordResetChallenges.subjectType, subject.subjectType),
          eq(passwordResetChallenges.subjectId, subject.subjectId),
          isNull(passwordResetChallenges.consumedAt),
        ))

      await tx.insert(passwordResetChallenges).values({
        id: challengeId,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        codeDigest: passwordResetCodeDigest(challengeId, code),
        expiresAt,
        createdAt: now,
      })
    })
  } catch (error) {
    logError(error, "PASSWORD_RESET_ISSUE_CHALLENGE", { subjectId: subject.subjectId })
    return unavailableOutcome(identifier, subject)
  }

  return {
    challengeId,
    afterResponse: () => deliverPasswordResetCode({
      identifier,
      subject,
      challengeId,
      code,
      expiresAt,
    }),
  }
}

/**
 * Counts a wrong guess against a live challenge, consuming it on the last one.
 * Issued for every rejection, decoys included — the guard below makes it a
 * no-op there — so a real challenge costs no extra round trip to reject.
 */
async function rejectCodeAttempt(challengeId: string): Promise<void> {
  await db
    .update(passwordResetChallenges)
    .set({
      attempts: sql`${passwordResetChallenges.attempts} + 1`,
      consumedAt: sql`CASE
        WHEN ${passwordResetChallenges.attempts} + 1 >= ${PASSWORD_RESET_MAX_ATTEMPTS}
          THEN now()
        ELSE ${passwordResetChallenges.consumedAt}
      END`,
    })
    .where(and(
      eq(passwordResetChallenges.id, challengeId),
      isNull(passwordResetChallenges.consumedAt),
      isNull(passwordResetChallenges.verifiedAt),
      gt(passwordResetChallenges.expiresAt, new Date()),
      sql`${passwordResetChallenges.attempts} < ${PASSWORD_RESET_MAX_ATTEMPTS}`,
    ))
}

export async function verifyPasswordResetCode(
  challengeId: string,
  code: string,
): Promise<VerifyPasswordResetOutcome> {
  const [challenge] = await db
    .select()
    .from(passwordResetChallenges)
    .where(eq(passwordResetChallenges.id, challengeId))
    .limit(1)

  const suppliedDigest = passwordResetCodeDigest(challengeId, code)
  const codeMatches = challenge
    ? safeDigestEqual(challenge.codeDigest, suppliedDigest)
    : false

  if (
    !challenge ||
    challenge.consumedAt ||
    challenge.verifiedAt ||
    challenge.expiresAt.getTime() <= Date.now() ||
    challenge.attempts >= PASSWORD_RESET_MAX_ATTEMPTS ||
    !codeMatches
  ) {
    await rejectCodeAttempt(challengeId)
    await recordAuthAuditEvent({
      action: "AUTH_PASSWORD_RESET_FAILURE",
      subjectId: challenge?.subjectId ?? null,
      success: false,
      reason: "reset_challenge_invalid",
      details: { challengeId },
    })
    return { kind: "rejected" }
  }

  const resetToken = randomBytes(32).toString("base64url")
  const resetTokenDigest = digest(challengeId, "token", resetToken)
  const verifiedAt = new Date()
  const resetTokenExpiresAt = new Date(verifiedAt.getTime() + TOKEN_VALIDITY_MS)
  const [verified] = await db
    .update(passwordResetChallenges)
    .set({ verifiedAt, resetTokenDigest, resetTokenExpiresAt })
    .where(and(
      eq(passwordResetChallenges.id, challengeId),
      eq(passwordResetChallenges.codeDigest, suppliedDigest),
      isNull(passwordResetChallenges.consumedAt),
      isNull(passwordResetChallenges.verifiedAt),
      gt(passwordResetChallenges.expiresAt, verifiedAt),
      sql`${passwordResetChallenges.attempts} < ${PASSWORD_RESET_MAX_ATTEMPTS}`,
    ))
    .returning({ subjectId: passwordResetChallenges.subjectId })

  if (!verified) {
    return { kind: "rejected" }
  }

  await recordAuthAuditEvent({
    action: "AUTH_PASSWORD_RESET_VERIFIED",
    subjectId: verified.subjectId,
    success: true,
    details: { challengeId, validForSeconds: TOKEN_VALIDITY_MS / 1000 },
  })
  return {
    kind: "verified",
    resetToken,
    validForSeconds: TOKEN_VALIDITY_MS / 1000,
  }
}

export async function completePasswordReset(input: {
  challengeId: string
  resetToken: string
  newPassword: string
}): Promise<CompletePasswordResetOutcome> {
  const policy = validatePassword(input.newPassword)
  if (!policy.valid) return { kind: "invalid_password", errors: policy.errors }

  const [challenge] = await db
    .select()
    .from(passwordResetChallenges)
    .where(eq(passwordResetChallenges.id, input.challengeId))
    .limit(1)
  const tokenDigest = digest(input.challengeId, "token", input.resetToken)
  if (
    !challenge ||
    challenge.consumedAt ||
    !challenge.verifiedAt ||
    !challenge.resetTokenDigest ||
    !challenge.resetTokenExpiresAt ||
    challenge.resetTokenExpiresAt.getTime() <= Date.now() ||
    !safeDigestEqual(challenge.resetTokenDigest, tokenDigest)
  ) {
    await recordAuthAuditEvent({
      action: "AUTH_PASSWORD_RESET_FAILURE",
      subjectId: challenge?.subjectId ?? null,
      success: false,
      reason: "reset_token_invalid",
      details: { challengeId: input.challengeId },
    })
    return { kind: "invalid_token" }
  }

  const subject = await loadSubject(
    challenge.subjectType as ResetSubjectType,
    challenge.subjectId,
  )
  if (!subject || !subjectScopeIsActive(subject)) return { kind: "invalid_token" }

  if (await verifyPassword(input.newPassword, subject.passwordHash)) {
    await recordAuthAuditEvent({
      action: "AUTH_PASSWORD_RESET_FAILURE",
      ...auditIdentity(subject),
      success: false,
      reason: "password_unchanged",
      details: { challengeId: input.challengeId },
    })
    return { kind: "password_unchanged" }
  }

  const passwordHash = await hashPassword(input.newPassword)
  const now = new Date()
  const completed = await db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(passwordResetChallenges)
      .set({ consumedAt: now })
      .where(and(
        eq(passwordResetChallenges.id, input.challengeId),
        eq(passwordResetChallenges.subjectType, subject.subjectType),
        eq(passwordResetChallenges.subjectId, subject.subjectId),
        eq(passwordResetChallenges.resetTokenDigest, tokenDigest),
        isNull(passwordResetChallenges.consumedAt),
        gt(passwordResetChallenges.resetTokenExpiresAt, now),
      ))
      .returning({ id: passwordResetChallenges.id })
    if (!consumed) return false

    if (subject.subjectType === "user") {
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
          sessionVersion: sql`${users.sessionVersion} + 1`,
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          lockoutUntil: null,
          updatedAt: now,
        })
        .where(and(eq(users.id, subject.subjectId), isNull(users.deletedAt), eq(users.isActive, true)))
        .returning({ id: users.id })
      if (!updated) throw new Error("Password reset subject is no longer active")

      // The legacy session table has no revocation column. Expiring rows keeps
      // its audit history while making them unusable immediately.
      await tx.update(sessions).set({ expiresAt: now }).where(and(
        eq(sessions.userId, subject.subjectId),
        gt(sessions.expiresAt, now),
      ))
    } else {
      const employeeId = Number.parseInt(subject.subjectId.slice(4), 10)
      const [updated] = await tx
        .update(employeeCredentials)
        .set({
          passwordHash,
          sessionVersion: sql`${employeeCredentials.sessionVersion} + 1`,
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          lockoutUntil: null,
          updatedAt: now,
        })
        .where(and(eq(employeeCredentials.id, employeeId), eq(employeeCredentials.isActive, true)))
        .returning({ id: employeeCredentials.id })
      if (!updated) throw new Error("Password reset employee is no longer active")
    }

    await tx
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(
        eq(authSessions.subjectId, subject.subjectId),
        isNull(authSessions.revokedAt),
      ))
    return true
  })

  if (!completed) return { kind: "invalid_token" }
  await invalidateSessionValidationCache(subject.subjectId)
  await recordAuthAuditEvent({
    action: "AUTH_PASSWORD_RESET_COMPLETED",
    ...auditIdentity(subject),
    success: true,
    details: { challengeId: input.challengeId, sessionsRevoked: true },
  })
  return { kind: "completed" }
}
