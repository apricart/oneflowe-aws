import "server-only"

import { and, eq, isNull, sql } from "drizzle-orm"

import { authSessions, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { generateAndSendOTP, otpExpiryMinutes, verifyOTP } from "@/lib/mfa"
import { ROLE_TEMPLATES } from "@/lib/permissions"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { isRoutableEmailAddress, maskEmailAddress } from "@/lib/validation/email"

/**
 * Proving that the address on an account reaches the person signed in to it.
 *
 * A code goes to the address on the row; entering it back stamps a proof on
 * the *session* that entered it (`auth_sessions.email_verified_at`), which the
 * password change then consumes (`lib/server/password-change.ts`). The proof
 * is bound to the session so a code entered on one device never authorises a
 * change from another, and it lives ten minutes so a person cannot verify
 * once and change the password a day later from an unattended screen.
 *
 * The code is typed `VERIFY_EMAIL`; `lib/mfa.ts` keeps one active code per
 * account and type, applies the request cooldown, the attempt cap and the
 * daily cap, and reports wrong and expired codes with the same words.
 */

export const EMAIL_VERIFICATION_TYPE = "VERIFY_EMAIL" as const

/** How long a proof authorises a password change once the code is accepted. */
export const EMAIL_VERIFICATION_VALIDITY_SECONDS = 10 * 60

export type SendVerificationOutcome =
  | { kind: "sent"; emailHint: string; validForMinutes: number }
  | { kind: "unroutable"; emailHint: string }
  | { kind: "throttled"; message: string; cooldownUntil: Date | null }
  | { kind: "failed"; message: string }
  | { kind: "not_found" }

export type ConfirmVerificationOutcome =
  | { kind: "verified"; validForSeconds: number }
  | { kind: "rejected"; message: string; remainingAttempts: number | null }
  | { kind: "session_invalid" }

type VerificationSubject = {
  id: string
  email: string
  username: string | null
  role: string | null
  organizationId: number | null
  branchId: number | null
}

async function loadSubject(userId: string): Promise<VerificationSubject | null> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), isNull(users.deletedAt), eq(users.isActive, true)))
    .limit(1)
  return row ?? null
}

/** The words the mail uses for the account the code opens. */
export function accountLabelForRole(role: string | null): string {
  if (!role) return "OneFlowe"
  const template = (ROLE_TEMPLATES as Record<string, { name: string } | undefined>)[role]
  return template?.name ?? role
}

export async function sendEmailVerificationCode(userId: string): Promise<SendVerificationOutcome> {
  const subject = await loadSubject(userId)
  if (!subject) return { kind: "not_found" }

  const emailHint = maskEmailAddress(subject.email)
  const audit = {
    subjectId: subject.id,
    email: subject.email,
    role: subject.role,
    organizationId: subject.organizationId,
    branchId: subject.branchId,
  }

  if (!isRoutableEmailAddress(subject.email)) {
    await recordAuthAuditEvent({
      action: "AUTH_EMAIL_VERIFICATION_FAILURE",
      ...audit,
      success: false,
      reason: "email_unroutable",
    })
    return { kind: "unroutable", emailHint }
  }

  const result = await generateAndSendOTP(subject.id, subject.email, EMAIL_VERIFICATION_TYPE, {
    username: subject.username,
    accountLabel: accountLabelForRole(subject.role),
  })

  if (!result.success) {
    if (result.cooldownUntil) {
      return { kind: "throttled", message: result.message, cooldownUntil: result.cooldownUntil }
    }
    return { kind: "failed", message: result.message }
  }

  await recordAuthAuditEvent({
    action: "AUTH_EMAIL_VERIFICATION_SENT",
    ...audit,
    success: true,
    details: { type: EMAIL_VERIFICATION_TYPE },
  })
  return { kind: "sent", emailHint, validForMinutes: otpExpiryMinutes(EMAIL_VERIFICATION_TYPE) }
}

export async function confirmEmailVerificationCode(
  userId: string,
  sessionId: string,
  code: string,
): Promise<ConfirmVerificationOutcome> {
  const subject = await loadSubject(userId)
  if (!subject) return { kind: "session_invalid" }

  const audit = {
    subjectId: subject.id,
    email: subject.email,
    role: subject.role,
    organizationId: subject.organizationId,
    branchId: subject.branchId,
  }

  const result = await verifyOTP(subject.id, code, EMAIL_VERIFICATION_TYPE)
  if (!result.success) {
    await recordAuthAuditEvent({
      action: "AUTH_EMAIL_VERIFICATION_FAILURE",
      ...audit,
      success: false,
      reason: "mfa_invalid",
      errorMessage: result.message,
    })
    return {
      kind: "rejected",
      message: result.message,
      remainingAttempts: result.remainingAttempts ?? null,
    }
  }

  // The code is spent either way. The proof lands on the session that
  // entered it and nowhere else; a session revoked in the meantime gets none.
  const stamped = await db.transaction(async (tx) => {
    const [session] = await tx
      .update(authSessions)
      .set({ emailVerifiedAt: sql`now()` })
      .where(and(
        eq(authSessions.id, sessionId),
        eq(authSessions.subjectId, subject.id),
        isNull(authSessions.revokedAt),
      ))
      .returning({ id: authSessions.id })
    if (!session) return false

    await tx
      .update(users)
      .set({ emailVerifiedAt: sql`now()` })
      .where(eq(users.id, subject.id))
    return true
  })

  if (!stamped) return { kind: "session_invalid" }

  await recordAuthAuditEvent({
    action: "AUTH_EMAIL_VERIFIED",
    ...audit,
    success: true,
    details: { type: EMAIL_VERIFICATION_TYPE, validForSeconds: EMAIL_VERIFICATION_VALIDITY_SECONDS },
  })
  return { kind: "verified", validForSeconds: EMAIL_VERIFICATION_VALIDITY_SECONDS }
}
