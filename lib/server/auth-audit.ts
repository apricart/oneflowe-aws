import "server-only"

import { headers } from "next/headers"
import { systemLogs } from "@/db/schema"
import { db } from "@/lib/db"
import { resolveRequestClientIp } from "@/lib/server/request-ip"

/**
 * Durable authentication audit trail.
 *
 * The application already writes `system_logs` for business operations, but the
 * authentication path produced only console output, which is neither queryable
 * nor retained. PCI DSS 10.2.1.1-10.2.1.5, SOC 2 CC7.2 and ISO 27001 A.8.15 all
 * require login attempts to be recorded, so these events go to the same table.
 *
 * `system_logs.user_id` is a plain varchar rather than a foreign key, which is
 * what makes it usable here: an authentication event may reference an employee
 * principal (`emp_42`) or no known account at all.
 */

export const AUTH_AUDIT_RESOURCE = "auth"

export type AuthAuditAction =
  | "AUTH_LOGIN_SUCCESS"
  | "AUTH_LOGIN_FAILURE"
  | "AUTH_MFA_CHALLENGE"
  | "AUTH_MFA_FAILURE"
  | "AUTH_MFA_VERIFIED"
  // Turning the second factor on or off is a change to a security control, not
  // a use of one. Both are recorded because disabling MFA is among the first
  // things someone holding a stolen session would do.
  | "AUTH_MFA_ENABLED"
  | "AUTH_MFA_DISABLED"
  | "AUTH_ACCOUNT_LOCKED"
  | "AUTH_LOCKOUT_BLOCKED"
  | "AUTH_LOCKOUT_CLEARED"
  | "AUTH_SESSION_REVOKED"
  // Self-service password change and the emailed proof that precedes it.
  | "AUTH_EMAIL_VERIFICATION_SENT"
  | "AUTH_EMAIL_VERIFIED"
  | "AUTH_EMAIL_VERIFICATION_FAILURE"
  | "AUTH_PASSWORD_CHANGED"
  | "AUTH_PASSWORD_CHANGE_FAILURE"
  // Public self-service recovery. Request failures intentionally do not reveal
  // whether the typed identifier exists, but the durable audit still records
  // the attempt and every subsequent challenge outcome.
  | "AUTH_PASSWORD_RESET_REQUESTED"
  | "AUTH_PASSWORD_RESET_VERIFIED"
  | "AUTH_PASSWORD_RESET_COMPLETED"
  | "AUTH_PASSWORD_RESET_FAILURE"
  // The public join page proving an applicant's address before its form
  // (plans/OF-JOIN-email-otp-verification.md). No account exists yet, so
  // these carry the organization and the challenge id, never the address.
  | "AUTH_JOIN_EMAIL_CODE_SENT"
  | "AUTH_JOIN_EMAIL_VERIFIED"
  | "AUTH_JOIN_EMAIL_VERIFICATION_FAILURE"
  // Written by `scripts/force-password-rotation.ts`, one row per account.
  | "AUTH_PASSWORD_ROTATION_FORCED"
  | "AUTH_PASSWORD_ROTATION_REVERSED"

/**
 * Why an attempt did not produce a session. Kept as a closed set so the audit
 * trail stays aggregatable, and so no free-text database error can reach it.
 */
export type AuthFailureReason =
  | "unknown_account"
  | "invalid_password"
  | "user_inactive"
  | "organization_inactive"
  | "branch_inactive"
  | "network_restricted"
  | "network_unavailable"
  | "account_locked"
  | "mfa_required"
  | "mfa_invalid"
  | "mfa_not_enrolled"
  | "email_unroutable"
  | "email_verification_required"
  // The token named a session that is revoked, or another account's.
  | "session_invalid"
  | "password_unchanged"
  | "reset_challenge_invalid"
  | "reset_token_invalid"
  | "password_reset_unavailable"
  | "join_email_challenge_invalid"
  | "join_email_delivery_failed"

export type AuthAuditEvent = {
  action: AuthAuditAction
  /** Resolved principal id when known: a user UUID or an `emp_<id>` string. */
  subjectId?: string | null
  /** The identifier as typed, so repeated attempts on one account correlate. */
  attemptedIdentifier?: string | null
  email?: string | null
  role?: string | null
  organizationId?: number | null
  branchId?: number | null
  success: boolean
  reason?: AuthFailureReason
  /** Free-form detail for a failure with no place in the closed reason set. */
  errorMessage?: string | null
  provider?: string
  details?: Record<string, unknown>
}

// Long enough to preserve any real username, short enough that a pasted secret
// or a hostile payload cannot bloat the row. The column itself allows 255.
const MAX_IDENTIFIER_LENGTH = 128
const MAX_USER_AGENT_LENGTH = 512

function truncate(value: string | null | undefined, limit: number): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/**
 * Only `system_logs.organization_id` and `branch_id` carry foreign keys. A
 * failed attempt frequently has no verified tenant, and a stale or hostile
 * value would abort the insert, so anything non-positive becomes null.
 */
function auditScopeId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null
  }
  return value
}

async function resolveUserAgent(): Promise<string | null> {
  try {
    const headerList = await headers()
    return truncate(headerList.get("user-agent"), MAX_USER_AGENT_LENGTH)
  } catch {
    // Outside a request scope there is no user agent to record.
    return null
  }
}

/**
 * Write one authentication event.
 *
 * Deliberately best-effort: a failure to record must not deny a legitimate
 * login or mask the authentication decision itself. A failed write is reported
 * loudly to the process log so alerting can catch a persistently broken trail,
 * because silently losing audit records is the outcome worth detecting.
 *
 * Never receives or stores a password, an OTP, or a session token.
 */
export async function recordAuthAuditEvent(event: AuthAuditEvent): Promise<void> {
  try {
    const [clientIp, userAgent] = await Promise.all([
      resolveRequestClientIp(),
      resolveUserAgent(),
    ])

    await db.insert(systemLogs).values({
      userId: truncate(event.subjectId, MAX_IDENTIFIER_LENGTH),
      userRole: truncate(event.role, 64),
      userEmail: truncate(event.email, 255),
      organizationId: auditScopeId(event.organizationId),
      branchId: auditScopeId(event.branchId),
      action: event.action,
      resourceType: AUTH_AUDIT_RESOURCE,
      resourceId: truncate(event.attemptedIdentifier, MAX_IDENTIFIER_LENGTH),
      details: {
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...event.details,
      },
      ipAddress: truncate(clientIp, 64),
      userAgent,
      success: event.success,
      errorMessage: truncate(event.errorMessage, 512) ?? event.reason ?? null,
    })
  } catch (error) {
    console.error("[AuthAudit] Failed to record authentication event", {
      action: event.action,
      reason: event.reason,
      error,
    })
  }
}
