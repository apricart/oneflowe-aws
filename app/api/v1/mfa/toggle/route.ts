import { NextRequest } from "next/server"
import { ok,error,requireApiRole,readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { enableMFA,disableMFA } from "@/lib/mfa"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { MFA_SELF_SERVICE_ROLES } from "@/lib/server/mfa-self-service-access"

export async function POST(req: NextRequest) {
  const err = await requireApiRole(MFA_SELF_SERVICE_ROLES)
  if (err) return err

  try {
    const body = await readJson<any>(req)
    if (!body) return error("Invalid request body", 400)

    const { action } = body // 'enable' or 'disable'

    const scope = await getRequestScope()

    if (!scope?.userId) {
      return error("User not authenticated", 401)
    }

    // Turning the second factor on or off goes to the authentication trail
    // (`system_logs`) rather than `audit_logs`: it is a change to an
    // authentication control and belongs beside the sign-ins it governs, where a
    // reviewer looking at an account's security history will find it.
    if (action === 'enable') {
      // For enabling MFA, we don't need OTP verification since the user is already authenticated
      // and accessing the settings page proves their identity

      const result = await enableMFA(scope.userId)
      await recordAuthAuditEvent({
        action: "AUTH_MFA_ENABLED",
        subjectId: scope.userId,
        role: scope.role,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        success: true,
        details: { selfService: true },
      })
      return ok({
        message: result.message,
        mfaEnabled: true
      })
    }

    else if (action === 'disable') {
      // For disabling MFA, we don't need OTP verification since the user is already authenticated
      // and accessing the settings page proves their identity

      const result = await disableMFA(scope.userId)
      await recordAuthAuditEvent({
        action: "AUTH_MFA_DISABLED",
        subjectId: scope.userId,
        role: scope.role,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        success: true,
        details: { selfService: true },
      })
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
