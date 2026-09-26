import { NextRequest } from "next/server"
import { ok, error, requireApiRole, readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { verifyOTP } from "@/lib/mfa"
import { withRateLimit } from "@/lib/rate-limiter"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { MFA_SELF_SERVICE_ROLES } from "@/lib/server/mfa-self-service-access"

export async function POST(req: NextRequest) {
  const err = await requireApiRole(MFA_SELF_SERVICE_ROLES)
  if (err) return err

  try {
    const body = await readJson<any>(req)
    if (!body) return error("Invalid request body", 400)

    const { code, type = 'LOGIN' } = body

    if (code?.length !== 6) {
      return error("Please enter a valid 6-digit OTP code", 400)
    }

    const scope = await getRequestScope()
    if (!scope?.userId) {
      return error("User not authenticated", 401)
    }

    const rateLimit = await withRateLimit("otpVerify", scope.userId)
    if (rateLimit) return rateLimit

    const result = await verifyOTP(scope.userId, code, type)

    // A failed second factor is the single most useful authentication row there
    // is, so it is recorded with the same weight as a success. The submitted
    // code is never included.
    await recordAuthAuditEvent({
      action: result.success ? "AUTH_MFA_VERIFIED" : "AUTH_MFA_FAILURE",
      subjectId: scope.userId,
      role: scope.role,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      success: result.success,
      reason: result.success ? undefined : "mfa_invalid",
      details: { type, remainingAttempts: result.remainingAttempts ?? null, selfService: true },
    })

    if (result.success) {
      return ok({
        message: result.message,
        verified: true
      })
    } else {
      return error(result.message + (result.remainingAttempts !== undefined ? ` (${result.remainingAttempts} attempts remaining)` : ''), 400)
    }

  } catch (err) {
    console.error("Error verifying OTP:", err)
    return error("Failed to verify OTP", 500)
  }
}
