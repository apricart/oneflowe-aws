import { NextResponse, type NextRequest } from "next/server"
import { z } from "zod"

import { ok, error, readJson } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import { getCurrentSessionId } from "@/lib/server/current-session"
import { validationMessage } from "@/lib/server/mutation-validation"
import { changeOwnPassword } from "@/lib/server/password-change"

/**
 * A person setting their own password. The rules — emailed proof on this
 * session (while `lib/password-change-policy.ts` requires it), current
 * password, policy, must differ — live in `lib/server/password-change.ts`;
 * this handler authenticates, validates and maps the outcome to a status.
 * Reachable by a session that still owes a password change
 * (`lib/password-change-pending.ts`).
 */

export const EMAIL_VERIFICATION_REQUIRED_CODE = "EMAIL_VERIFICATION_REQUIRED"

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128),
  password: z.string().min(1, "New password is required").max(128),
}).strict()

function refused(message: string, status: number, code: string, headers?: HeadersInit): NextResponse {
  return NextResponse.json({ error: message, code }, { status, headers })
}

export async function POST(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser) return error("Unauthorized", 401)

    // This endpoint is only for users in the users table, not employees
    if (currentUser.id.startsWith("emp_")) {
      return error("Not applicable for employee accounts", 400)
    }

    const rateLimit = await withRateLimit("sensitive", currentUser.id)
    if (rateLimit) return rateLimit

    const sessionId = await getCurrentSessionId(req)
    if (!sessionId) return error("Unauthorized", 401)

    const parsed = bodySchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await changeOwnPassword({
      userId: currentUser.id,
      sessionId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.password,
    })

    switch (outcome.kind) {
      case "changed":
        return ok({ success: true })
      case "verification_required":
        return refused(
          "Verify your email address before changing your password.",
          403,
          EMAIL_VERIFICATION_REQUIRED_CODE,
        )
      case "session_invalid":
        return error("Unauthorized", 401)
      case "locked":
        return refused(
          "Too many failed attempts. Please try again later.",
          423,
          "ACCOUNT_LOCKED",
          { "Retry-After": String(outcome.retryAfterSeconds) },
        )
      case "invalid_current_password":
        return error("The current password is incorrect.", 400)
      case "password_unchanged":
        return error("The new password must be different from your current password.", 400)
      case "invalid_password":
        return error(outcome.errors.join(", "), 400)
      case "not_found":
        return error("User not found", 404)
    }
  } catch (err) {
    logError(err, "API_CHANGE_PASSWORD")
    return error("Failed to change password", 500)
  }
}
