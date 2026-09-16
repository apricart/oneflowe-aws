import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import { authSessions, roles, sessions, users } from "@/db/schema"
import { db } from "@/lib/db"
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { evaluateLockout, registerFailedLogin } from "@/lib/server/auth-lockout"
import { EMAIL_VERIFICATION_VALIDITY_SECONDS } from "@/lib/server/email-verification"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"

/**
 * A person setting their own password.
 *
 * Three things have to be true, and they are checked in this order so that
 * nothing is spent before the request is known to be good:
 *
 * 1. The session entered an emailed code in the last ten minutes
 *    (`auth_sessions.email_verified_at`, written by
 *    `lib/server/email-verification.ts`). Checked first without consuming
 *    it, so a mistyped current password does not cost a fresh code.
 * 2. The current password is right. A wrong one counts against the account's
 *    lockout budget exactly like a failed sign-in: this is the one place a
 *    live session can still guess at the password.
 * 3. The new password meets the policy and differs from the current one — a
 *    rotation that keeps the handout password has rotated nothing.
 *
 * Then, in one transaction: the proof is consumed with a predicate that
 * re-checks its freshness (the check in step 1 is advisory; this is the
 * control), the hash is written, `must_change_password` cleared,
 * `password_changed_at` stamped, `session_version` bumped so every token of
 * the account — this one included — is refused from the next request, and
 * the physical session rows dropped. A failure anywhere leaves the proof in
 * place and the password as it was.
 */

export type PasswordChangeInput = {
  userId: string
  sessionId: string
  currentPassword: string
  newPassword: string
}

export type PasswordChangeOutcome =
  | { kind: "changed"; forced: boolean }
  | { kind: "verification_required" }
  | { kind: "locked"; retryAfterSeconds: number }
  | { kind: "invalid_current_password" }
  | { kind: "password_unchanged" }
  | { kind: "invalid_password"; errors: string[] }
  | { kind: "not_found" }

type AccountRow = {
  id: string
  email: string
  username: string | null
  role: string | null
  organizationId: number | null
  branchId: number | null
  passwordHash: string
  sessionVersion: number
  mustChangePassword: boolean
  lockoutUntil: Date | null
}

const PROOF_FRESH = sql`${authSessions.emailVerifiedAt} >= now() - make_interval(secs => ${EMAIL_VERIFICATION_VALIDITY_SECONDS})`

async function loadAccount(userId: string): Promise<AccountRow | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
      passwordHash: users.passwordHash,
      sessionVersion: users.sessionVersion,
      mustChangePassword: users.mustChangePassword,
      lockoutUntil: users.lockoutUntil,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt), eq(users.isActive, true)))
    .limit(1)
  return row ?? null
}

async function hasFreshProof(sessionId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(
      eq(authSessions.id, sessionId),
      eq(authSessions.subjectId, userId),
      isNull(authSessions.revokedAt),
      PROOF_FRESH,
    ))
    .limit(1)
  return Boolean(row)
}

export async function changeOwnPassword(input: PasswordChangeInput): Promise<PasswordChangeOutcome> {
  const account = await loadAccount(input.userId)
  if (!account) return { kind: "not_found" }

  const audit = {
    subjectId: account.id,
    email: account.email,
    role: account.role,
    organizationId: account.organizationId,
    branchId: account.branchId,
  }
  const refuse = async (
    reason: "email_verification_required" | "account_locked" | "invalid_password" | "password_unchanged",
  ): Promise<void> => {
    await recordAuthAuditEvent({
      action: "AUTH_PASSWORD_CHANGE_FAILURE",
      ...audit,
      success: false,
      reason,
      details: { forced: account.mustChangePassword },
    })
  }

  if (!(await hasFreshProof(input.sessionId, account.id))) {
    await refuse("email_verification_required")
    return { kind: "verification_required" }
  }

  const lockout = evaluateLockout(account)
  if (lockout.locked) {
    await refuse("account_locked")
    return { kind: "locked", retryAfterSeconds: lockout.retryAfterSeconds }
  }

  if (!(await verifyPassword(input.currentPassword, account.passwordHash))) {
    await registerFailedLogin({ kind: "user", id: account.id })
    await refuse("invalid_password")
    return { kind: "invalid_current_password" }
  }

  const policy = validatePassword(input.newPassword)
  if (!policy.valid) return { kind: "invalid_password", errors: policy.errors }

  if (await verifyPassword(input.newPassword, account.passwordHash)) {
    await refuse("password_unchanged")
    return { kind: "password_unchanged" }
  }

  const passwordHash = await hashPassword(input.newPassword)

  const changed = await db.transaction(async (tx) => {
    // The control: consumed and re-checked in one statement. A proof that
    // expired since the advisory check, or was consumed by a concurrent
    // request, leaves no row and nothing below runs.
    const [proof] = await tx
      .update(authSessions)
      .set({ emailVerifiedAt: null })
      .where(and(
        eq(authSessions.id, input.sessionId),
        eq(authSessions.subjectId, account.id),
        isNull(authSessions.revokedAt),
        PROOF_FRESH,
      ))
      .returning({ id: authSessions.id })
    if (!proof) return false

    const [updated] = await tx
      .update(users)
      .set({
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: sql`now()`,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        // A completed password change releases any brute-force lockout
        // counters left over from failed attempts against the old password.
        failedLoginAttempts: 0,
        lockoutUntil: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(users.id, account.id), isNull(users.deletedAt)))
      .returning({ id: users.id })
    if (!updated) throw new Error("Account vanished during password change")

    // Physical sessions go too, so every device is signed out.
    await tx.delete(sessions).where(eq(sessions.userId, account.id))
    return true
  })

  if (!changed) {
    await refuse("email_verification_required")
    return { kind: "verification_required" }
  }

  // Drop the cached session-validation result so the sessionVersion bump
  // takes effect on the next session check across all devices.
  await invalidateSessionValidationCache(account.id)

  await recordAuthAuditEvent({
    action: "AUTH_PASSWORD_CHANGED",
    ...audit,
    success: true,
    details: { forced: account.mustChangePassword, emailVerified: true },
  })
  return { kind: "changed", forced: account.mustChangePassword }
}
