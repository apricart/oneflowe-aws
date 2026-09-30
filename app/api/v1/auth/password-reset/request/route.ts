import { after } from "next/server"
import { z } from "zod"

import { error, ok, readJson } from "@/lib/api"
import { logError } from "@/lib/global-logger"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import {
  PASSWORD_RESET_CODE_VALIDITY_MINUTES,
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_REQUEST_MIN_RESPONSE_MS,
  passwordResetIdentifierDigest,
  requestPasswordReset,
} from "@/lib/server/password-reset"
import { validationMessage } from "@/lib/server/mutation-validation"

const bodySchema = z.object({
  identifier: z.string().trim().min(1, "Username or email is required").max(255),
}).strict()

async function waitUntilElapsed(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = startedAt + minimumMs - Date.now()
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

/**
 * Starts public account recovery without revealing whether the identifier is
 * present, active, unique, routable, or successfully delivered — by content or
 * by timing. The email goes out after the response, and the response itself is
 * held to a floor that covers the extra queries a real account costs.
 */
export async function POST(req: Request) {
  const startedAt = Date.now()
  try {
    const parsed = bodySchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const clientIdentifier = await getClientIdentifier()
    const accountIdentifier =
      `password-reset-request:${passwordResetIdentifierDigest(parsed.data.identifier).slice(0, 40)}`
    const [clientLimit, accountLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "otpSend"),
      checkRateLimit(accountIdentifier, "otpSend"),
    ])
    if (!clientLimit.allowed || !accountLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, accountLimit.resetIn))
    }

    const { challengeId, afterResponse } = await requestPasswordReset(parsed.data.identifier)
    after(afterResponse)
    await waitUntilElapsed(startedAt, PASSWORD_RESET_REQUEST_MIN_RESPONSE_MS)
    return ok(
      {
        challengeId,
        message: PASSWORD_RESET_REQUEST_MESSAGE,
        validForMinutes: PASSWORD_RESET_CODE_VALIDITY_MINUTES,
      },
      { status: 202 },
    )
  } catch (caughtError) {
    logError(caughtError, "API_PASSWORD_RESET_REQUEST")
    return error("Unable to start password reset. Please try again later.", 500)
  }
}
