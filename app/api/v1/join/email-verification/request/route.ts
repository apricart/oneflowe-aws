import { createHash } from "node:crypto"

import { NextResponse } from "next/server"

import { error, ok, readJson } from "@/lib/api"
import { handleError } from "@/lib/error-handler"
import {
  JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE,
  JOIN_EMAIL_DAILY_LIMIT_MESSAGE,
  UNKNOWN_JOIN_CODE_MESSAGE,
  joinEmailDomainRefusal,
} from "@/lib/organization-join"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"
import { issueJoinEmailCode, joinEmailDigest } from "@/lib/server/join-email-verification"
import { joinEmailCodeRequestSchema, validationMessage } from "@/lib/server/mutation-validation"
import { resolveOrganizationByJoinCode } from "@/lib/server/organization-join"
import { normalizeEmail } from "@/lib/user-uniqueness"

const ONE_DAY_SECONDS = 24 * 60 * 60

/**
 * POST /api/v1/join/email-verification/request — email a code to the address
 * an applicant wants to join with (plans/OF-JOIN-email-otp-verification.md).
 *
 * **Deliberately unauthenticated**, like the rest of the join flow. It sends a
 * mail and writes one challenge row of digests; it creates no account and no
 * request.
 *
 *   1. **Validation** — `.strict()`; the join code and the address, nothing else.
 *   2. **Rate limiting** — on the caller and on the code (the `login` budget,
 *      as the other public join routes), and on the address (`otpSend`), so
 *      neither one address nor one leaked code can be used to flood a mailbox.
 *   3. **Tenant from the code**, never from the body.
 *   4. **The organization's email domain**, read on this request: only an
 *      address the submit would accept is ever sent a code.
 *
 * It never asks whether the address already has an account or a waiting
 * request, so its answer cannot be used to find out. That is decided at submit.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)

    const parsed = joinEmailCodeRequestSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const { code } = parsed.data
    const email = normalizeEmail(parsed.data.email)

    const clientIdentifier = await getClientIdentifier()
    const codeIdentifier = `join-email-code:${createHash("sha256").update(code).digest("hex").slice(0, 32)}`
    const addressIdentifier = `join-email-address:${joinEmailDigest(email).slice(0, 40)}`
    const [clientLimit, codeLimit, addressLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "login"),
      checkRateLimit(codeIdentifier, "login"),
      checkRateLimit(addressIdentifier, "otpSend"),
    ])
    if (!clientLimit.allowed || !codeLimit.allowed || !addressLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, codeLimit.resetIn, addressLimit.resetIn))
    }

    const organization = await resolveOrganizationByJoinCode(code)
    if (!organization) return error(UNKNOWN_JOIN_CODE_MESSAGE, 404)

    const domainRefusal = joinEmailDomainRefusal(email, organization.emailDomain)
    if (domainRefusal) return error(domainRefusal.message, domainRefusal.status)

    const outcome = await issueJoinEmailCode({ organizationId: organization.organizationId, email })
    if (outcome.kind === "daily_limit") {
      return NextResponse.json(
        { error: JOIN_EMAIL_DAILY_LIMIT_MESSAGE },
        { status: 429, headers: { "Retry-After": String(ONE_DAY_SECONDS) } },
      )
    }
    // A constant, safe message; `error()` would replace any 5xx text with a
    // generic one, and the applicant needs to know to try again.
    if (outcome.kind === "delivery_failed") {
      return NextResponse.json({ error: JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE }, { status: 503 })
    }

    return ok(
      { challengeId: outcome.challengeId, validForMinutes: outcome.validForMinutes },
      { status: 202 },
    )
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "join email code request")
    return error(message, status)
  }
}
