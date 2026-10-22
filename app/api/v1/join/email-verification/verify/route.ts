import { createHash } from "node:crypto"

import { error, ok, readJson } from "@/lib/api"
import { handleError } from "@/lib/error-handler"
import { JOIN_EMAIL_CODE_INVALID_MESSAGE } from "@/lib/organization-join"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { verifyJoinEmailCode } from "@/lib/server/join-email-verification"
import { joinEmailCodeVerifySchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * POST /api/v1/join/email-verification/verify — the emailed code back, for a
 * single-use proof the join submit spends (plans/OF-JOIN-email-otp-verification.md).
 *
 * **Deliberately unauthenticated.** Rate limited on the caller and on the
 * challenge; the challenge itself is spent after five wrong codes. Every
 * rejection — wrong, expired, spent, or a challenge that never existed — is
 * the same 400 with no attempt count, so the answer says only "no".
 */
export async function POST(req: Request) {
  try {
    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)

    const parsed = joinEmailCodeVerifySchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const { challengeId, otp } = parsed.data

    const clientIdentifier = await getClientIdentifier()
    const challengeIdentifier = `join-email-verify:${createHash("sha256").update(challengeId).digest("hex").slice(0, 32)}`
    const [clientLimit, challengeLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "login"),
      checkRateLimit(challengeIdentifier, "otpVerify"),
    ])
    if (!clientLimit.allowed || !challengeLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, challengeLimit.resetIn))
    }

    const outcome = await verifyJoinEmailCode(challengeId, otp)
    if (outcome.kind === "rejected") return error(JOIN_EMAIL_CODE_INVALID_MESSAGE, 400)

    return ok({ proof: outcome.proof, validForSeconds: outcome.validForSeconds })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "join email code verify")
    return error(message, status)
  }
}
