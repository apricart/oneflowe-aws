import { z } from "zod"

import { error, ok, readJson } from "@/lib/api"
import { logError } from "@/lib/global-logger"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import {
  PASSWORD_RESET_INVALID_CODE_MESSAGE,
  passwordResetIdentifierDigest,
  verifyPasswordResetCode,
} from "@/lib/server/password-reset"
import { validationMessage } from "@/lib/server/mutation-validation"

const bodySchema = z.object({
  challengeId: z.uuid("Invalid password reset request"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email"),
}).strict()

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const clientIdentifier = await getClientIdentifier()
    const challengeIdentifier =
      `password-reset-verify:${passwordResetIdentifierDigest(parsed.data.challengeId).slice(0, 40)}`
    const [clientLimit, challengeLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "otpVerify"),
      checkRateLimit(challengeIdentifier, "otpVerify"),
    ])
    if (!clientLimit.allowed || !challengeLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, challengeLimit.resetIn))
    }

    // One message for every rejection. A decoy challenge from an unknown
    // account must be indistinguishable from a real one with a wrong code.
    const outcome = await verifyPasswordResetCode(parsed.data.challengeId, parsed.data.code)
    if (outcome.kind === "rejected") {
      return error(PASSWORD_RESET_INVALID_CODE_MESSAGE, 400)
    }

    return ok({
      verified: true,
      resetToken: outcome.resetToken,
      validForSeconds: outcome.validForSeconds,
    })
  } catch (caughtError) {
    logError(caughtError, "API_PASSWORD_RESET_VERIFY")
    return error("Unable to verify the code. Please try again later.", 500)
  }
}
