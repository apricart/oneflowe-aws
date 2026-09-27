import { NextRequest } from "next/server"
import { ok, error, readJson } from "@/lib/api"
import { generateAndSendOTP } from "@/lib/mfa"
import { createHash } from "node:crypto"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { recordAuthAuditEvent, type AuthFailureReason } from "@/lib/server/auth-audit"

const genericResponse = () => ok({
  message: "If MFA is enabled for this account, a verification code has been sent.",
})

/**
 * Record the challenge, then answer identically whatever happened.
 *
 * The response must not distinguish an unknown account from one without MFA
 * from a code actually sent — that difference is an account-enumeration oracle,
 * which `genericResponse` exists to close. The *trail* may and should
 * distinguish them: a burst of `unknown_account` challenges from one address is
 * precisely the probe a reviewer needs to see, and it is invisible if only the
 * successful sends are kept.
 */
async function recordChallenge(
  identifier: string,
  outcome: { subjectId?: string | null; email?: string | null; success: boolean; reason?: AuthFailureReason },
) {
  await recordAuthAuditEvent({
    action: "AUTH_MFA_CHALLENGE",
    attemptedIdentifier: identifier,
    subjectId: outcome.subjectId ?? null,
    email: outcome.email ?? null,
    success: outcome.success,
    reason: outcome.reason,
    details: { stage: "login" },
  })
  return genericResponse()
}

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<any>(req)

    if (!body) return error("Invalid request body", 400)

    const { username, type = 'LOGIN' } = body
    if (!username) {
      return error("Username or email is required", 400)
    }
    if (type !== "LOGIN") {
      return error("Unsupported MFA request type", 400)
    }
    const identifier = String(username).trim().toLowerCase()
    const clientIdentifier = await getClientIdentifier()
    const accountIdentifier = `account:${createHash("sha256").update(identifier).digest("hex").slice(0, 32)}`
    const [clientLimit, accountLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "otpSend"),
      checkRateLimit(accountIdentifier, "otpSend"),
    ])
    if (!clientLimit.allowed || !accountLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, accountLimit.resetIn))
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
          email: employeeCredentials.email, // Use email as target for sending OTP
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
      return recordChallenge(identifier, { success: false, reason: "unknown_account" })
    }

    if (!user.mfaEnabled) {
      return recordChallenge(identifier, {
        subjectId: user.id,
        email: user.email,
        success: false,
        reason: "mfa_not_enrolled",
      })
    }

    const result = await generateAndSendOTP(user.id, user.email, type)
    if (!result.success) {
      console.warn("[MFA] Login OTP request was not completed", {
        account: accountIdentifier,
      })
    }
    return recordChallenge(identifier, {
      subjectId: user.id,
      email: user.email,
      success: result.success,
      reason: result.success ? undefined : "email_unroutable",
    })

  } catch (err) {
    console.error("Error sending OTP:", err)
    return genericResponse()
  }
}
