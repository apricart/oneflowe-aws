import type { NextRequest } from "next/server"
import { z } from "zod"

import { ok, error, readJson } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import { getCurrentSessionId } from "@/lib/server/current-session"
import { confirmEmailVerificationCode } from "@/lib/server/email-verification"
import { validationMessage } from "@/lib/server/mutation-validation"

/**
 * Enter the code back. On success the proof is stamped on *this* session
 * (`auth_sessions.email_verified_at`) for the password change to consume.
 * Reachable by a session that still owes a password change
 * (`lib/password-change-pending.ts`).
 */

const bodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email"),
}).strict()

export async function POST(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser) return error("Unauthorized", 401)
    if (currentUser.id.startsWith("emp_")) {
      return error("Not applicable for employee accounts", 400)
    }

    const rateLimit = await withRateLimit("otpVerify", currentUser.id)
    if (rateLimit) return rateLimit

    const sessionId = await getCurrentSessionId(req)
    if (!sessionId) return error("Unauthorized", 401)

    const parsed = bodySchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await confirmEmailVerificationCode(currentUser.id, sessionId, parsed.data.code)
    switch (outcome.kind) {
      case "verified":
        return ok({ verified: true, validForSeconds: outcome.validForSeconds })
      case "rejected":
        return error(
          outcome.remainingAttempts === null
            ? outcome.message
            : `${outcome.message} (${outcome.remainingAttempts} attempts remaining)`,
          400,
        )
      case "session_invalid":
        return error("Unauthorized", 401)
    }
  } catch (err) {
    logError(err, "API_EMAIL_VERIFICATION_VERIFY")
    return error("Failed to verify code", 500)
  }
}
