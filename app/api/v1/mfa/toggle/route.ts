import { NextRequest } from "next/server"
import { ok,error,requireApiRole,readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { enableMFA,disableMFA } from "@/lib/mfa"

export async function POST(req: NextRequest) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (err) return err

  try {
    const body = await readJson<any>(req)
    if (!body) return error("Invalid request body", 400)

    const { action } = body // 'enable' or 'disable'

    const scope = await getRequestScope()

    if (!scope?.userId) {
      return error("User not authenticated", 401)
    }

    if (action === 'enable') {
      // For enabling MFA, we don't need OTP verification since the user is already authenticated
      // and accessing the settings page proves their identity

      const result = await enableMFA(scope.userId)
      return ok({
        message: result.message,
        mfaEnabled: true
      })
    }

    else if (action === 'disable') {
      // For disabling MFA, we don't need OTP verification since the user is already authenticated
      // and accessing the settings page proves their identity

      const result = await disableMFA(scope.userId)
      return ok({
        message: result.message,
        mfaEnabled: false
      })
    }

    else {
      return error("Invalid action. Use 'enable' or 'disable'", 400)
    }

  } catch (err) {
    console.error("Error toggling MFA:", err)
    return error("Failed to toggle MFA", 500)
  }
}
