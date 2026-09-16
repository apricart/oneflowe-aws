import { NextResponse } from "next/server"

import { ok, error } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import { sendEmailVerificationCode } from "@/lib/server/email-verification"

/**
 * Send a verification code to the address on the caller's own account.
 *
 * The session is the only identifier — nothing in the body — so there is
 * nothing to enumerate. Reachable by a session that still owes a password
 * change (`lib/password-change-pending.ts`).
 */

export const EMAIL_UNROUTABLE_CODE = "EMAIL_UNROUTABLE"

export async function POST() {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser) return error("Unauthorized", 401)
    if (currentUser.id.startsWith("emp_")) {
      return error("Not applicable for employee accounts", 400)
    }

    const rateLimit = await withRateLimit("otpSend", currentUser.id)
    if (rateLimit) return rateLimit

    const outcome = await sendEmailVerificationCode(currentUser.id)
    switch (outcome.kind) {
      case "sent":
        return ok({ sent: true, emailHint: outcome.emailHint, validForMinutes: outcome.validForMinutes })
      case "unroutable":
        return NextResponse.json(
          {
            error: "Your account has no reachable email address on file. Contact your administrator to have it corrected before you can continue.",
            code: EMAIL_UNROUTABLE_CODE,
            emailHint: outcome.emailHint,
          },
          { status: 409 },
        )
      case "throttled": {
        const retryAfterSeconds = outcome.cooldownUntil
          ? Math.max(1, Math.ceil((outcome.cooldownUntil.getTime() - Date.now()) / 1000))
          : 60
        return NextResponse.json(
          { error: outcome.message, retryAfterSeconds },
          { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
        )
      }
      case "failed":
        return error(outcome.message, 400)
      case "not_found":
        return error("User not found", 404)
    }
  } catch (err) {
    logError(err, "API_EMAIL_VERIFICATION_SEND")
    return error("Failed to send verification code", 500)
  }
}
