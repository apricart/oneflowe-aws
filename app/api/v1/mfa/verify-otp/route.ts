import { NextRequest } from "next/server"
import { ok, error, requireApiRole, readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { verifyOTP } from "@/lib/mfa"
import { withRateLimit } from "@/lib/rate-limiter"

export async function POST(req: NextRequest) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (err) return err

  try {
    const body = await readJson<any>(req)
    if (!body) return error("Invalid request body", 400)

    const { code, type = 'LOGIN' } = body

    if (!code || code.length !== 6) {
      return error("Please enter a valid 6-digit OTP code", 400)
    }

    const scope = await getRequestScope()
    if (!scope?.userId) {
      return error("User not authenticated", 401)
    }

    const rateLimit = await withRateLimit("otpVerify", scope.userId)
    if (rateLimit) return rateLimit

    const result = await verifyOTP(scope.userId, code, type)

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
