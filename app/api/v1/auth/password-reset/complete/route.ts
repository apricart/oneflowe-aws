import { z } from "zod"

import { error, ok, readJson } from "@/lib/api"
import { logError } from "@/lib/global-logger"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import {
  PASSWORD_RESET_INVALID_TOKEN_MESSAGE,
  completePasswordReset,
  passwordResetIdentifierDigest,
} from "@/lib/server/password-reset"
import { validationMessage } from "@/lib/server/mutation-validation"

const bodySchema = z.object({
  challengeId: z.uuid("Invalid password reset request"),
  resetToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid password reset token"),
  password: z.string().min(1, "New password is required").max(128),
  confirmPassword: z.string().min(1, "Confirm your new password").max(128),
}).strict().refine((input) => input.password === input.confirmPassword, {
  message: "Passwords do not match",
  path: ["confirmPassword"],
})

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const clientIdentifier = await getClientIdentifier()
    const challengeIdentifier =
      `password-reset-complete:${passwordResetIdentifierDigest(parsed.data.challengeId).slice(0, 40)}`
    const [clientLimit, challengeLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "sensitive"),
      checkRateLimit(challengeIdentifier, "sensitive"),
    ])
    if (!clientLimit.allowed || !challengeLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, challengeLimit.resetIn))
    }

    const outcome = await completePasswordReset({
      challengeId: parsed.data.challengeId,
      resetToken: parsed.data.resetToken,
      newPassword: parsed.data.password,
    })
    switch (outcome.kind) {
      case "completed":
        return ok({ success: true, message: "Your password has been reset. Sign in with your new password." })
      case "invalid_token":
        return error(PASSWORD_RESET_INVALID_TOKEN_MESSAGE, 400)
      case "password_unchanged":
        return error("Your new password must be different from your current password.", 400)
      case "invalid_password":
        return error(outcome.errors.join(", "), 400)
    }
  } catch (caughtError) {
    logError(caughtError, "API_PASSWORD_RESET_COMPLETE")
    return error("Unable to reset the password. Please try again later.", 500)
  }
}
