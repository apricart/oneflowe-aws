import { NextRequest } from "next/server"
import { ok, error, readJson } from "@/lib/api"
import { verifyOTP } from "@/lib/mfa"
import { createHash } from "node:crypto"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { recordAuthAuditEvent, type AuthFailureReason } from "@/lib/server/auth-audit"

/**
 * Record the attempt. The caller's reply is unchanged: every refusal here
 * already answers "Invalid or expired OTP code" whether the account is unknown,
 * has no second factor, or simply got the code wrong — the trail is where those
 * are told apart, not the response.
 */
async function recordVerification(
  identifier: string,
  outcome: {
    subjectId?: string | null
    email?: string | null
    success: boolean
    reason?: AuthFailureReason
    remainingAttempts?: number | null
  },
) {
  await recordAuthAuditEvent({
    action: outcome.success ? "AUTH_MFA_VERIFIED" : "AUTH_MFA_FAILURE",
    attemptedIdentifier: identifier,
    subjectId: outcome.subjectId ?? null,
    email: outcome.email ?? null,
    success: outcome.success,
    reason: outcome.reason,
    details: { stage: "login", remainingAttempts: outcome.remainingAttempts ?? null },
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<any>(req)
    if (!body) return error("Invalid request body", 400)

    const { username, code, type = 'LOGIN' } = body
    if (!username || !code) {
      return error("Username or email and code are required", 400)
    }
    const identifier = String(username).trim().toLowerCase()
    const clientIdentifier = await getClientIdentifier()
    const accountIdentifier = `account:${createHash("sha256").update(identifier).digest("hex").slice(0, 32)}`
    const [clientLimit, accountLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "otpVerify"),
      checkRateLimit(accountIdentifier, "otpVerify"),
    ])
    if (!clientLimit.allowed || !accountLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, accountLimit.resetIn))
    }

    if (code.length !== 6) {
      return error("Please enter a valid 6-digit OTP code", 400)
    }

    const { db } = await import("@/lib/db")
    const { users, employeeCredentials } = await import("@/db/schema")
    const { eq, and, isNull, sql, or } = await import("drizzle-orm")

    // 1. Try Users table
    let [user]: any[] = await db
      .select({
        id: users.id,
        email: users.email,
        mfaEnabled: users.mfaEnabled
      })
      .from(users)
      .where(and(or(eq(users.username, identifier), sql`lower(${users.email}) = ${identifier}`), isNull(users.deletedAt)))
      .limit(1)

    // 2. Try Employee Credentials table
    if (!user) {
      const [emp] = await db
        .select({
          id: employeeCredentials.id,
          email: employeeCredentials.email,
          mfaEnabled: employeeCredentials.mfaEnabled
        })
        .from(employeeCredentials)
        .where(or(eq(employeeCredentials.username, identifier), sql`lower(${employeeCredentials.email}) = ${identifier}`))
        .limit(1)
      
      if (emp) {
        user = { ...emp, id: `emp_${emp.id}` } as any
      }
    }

    if (!user) {
      await recordVerification(identifier, { success: false, reason: "unknown_account" })
      return error("Invalid or expired OTP code", 400)
    }

    if (!user.mfaEnabled) {
      await recordVerification(identifier, {
        subjectId: user.id,
        email: user.email,
        success: false,
        reason: "mfa_not_enrolled",
      })
      return error("Invalid or expired OTP code", 400)
    }

    const result = await verifyOTP(user.id, code, type)
    await recordVerification(identifier, {
      subjectId: user.id,
      email: user.email,
      success: result.success,
      reason: result.success ? undefined : "mfa_invalid",
      remainingAttempts: result.remainingAttempts ?? null,
    })

    if (result.success) {
      return ok({
        message: result.message,
        verified: true,
        userId: user.id
      })
    } else {
      return error(result.message + (result.remainingAttempts !== undefined ? ` (${result.remainingAttempts} attempts remaining)` : ''), 400)
    }

  } catch (err) {
    console.error("Error verifying OTP:", err)
    return error("Failed to verify OTP", 500)
  }
}
