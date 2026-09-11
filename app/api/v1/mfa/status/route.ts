import { NextRequest } from "next/server"
import { ok, error, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { isMFAEnabled } from "@/lib/mfa"
import { MFA_SELF_SERVICE_ROLES } from "@/lib/server/mfa-self-service-access"

export async function GET(req: NextRequest) {
  const err = await requireApiRole(MFA_SELF_SERVICE_ROLES)
  if (err) return err

  try {
    const scope = await getRequestScope()
    if (!scope?.userId) {
      return error("User not authenticated", 401)
    }

    const enabled = await isMFAEnabled(scope.userId)

    return ok({
      mfaEnabled: enabled,
      message: enabled ? "MFA is enabled" : "MFA is disabled"
    })

  } catch (err) {
    console.error("Error checking MFA status:", err)
    return error("Failed to check MFA status", 500)
  }
}
