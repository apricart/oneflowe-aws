import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { logError } from "@/lib/global-logger"
import { loadApprovalLevelCoverage } from "@/lib/server/order-approval-routing"

export const dynamic = "force-dynamic"

/**
 * GET /api/v1/approval-levels/coverage — for each active branch, how many
 * people hold each approval level there
 * (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md, R11).
 *
 * An order is refused when no one at its branch holds its level, so this is
 * how Head Office finds a gap before an order does. Head Office reads its own
 * organization only, taken from its user row; Super Admin names one with
 * `?organizationId=`. An organization not using levels answers
 * `{ active: false }` and nothing else. Counts only — no person is named.
 */
export async function GET(req: Request) {
  const authError = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (authError) return authError

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Invalid session data", 401)

    let organizationId: number | null = scope.organizationId
    if (scope.role === "SUPER_ADMIN") {
      const requested = new URL(req.url).searchParams.get("organizationId") ?? ""
      if (!/^\d{1,9}$/.test(requested) || Number(requested) <= 0) return error("Organization ID is required", 400)
      organizationId = Number(requested)
    }
    if (!organizationId) return error("Organization context required", 403)

    const coverage = await loadApprovalLevelCoverage(organizationId)
    if (!coverage) return error("Organization not found", 404)
    return ok(coverage)
  } catch (caughtError: unknown) {
    logError(caughtError, "APPROVAL_LEVEL_COVERAGE_GET")
    return error("Failed to load approval level coverage", 500)
  }
}
