import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import type { Role } from "@/lib/rbac"
import { isOrganizationBudgetEnabled } from "@/lib/server/organization-budget-policy"

export const dynamic = "force-dynamic"

const BUDGET_POLICY_READER_ROLES: Role[] = ["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER"]

/**
 * GET /api/v1/organizations/budget-policy
 *
 * Whether the caller's own organization has budget allocation switched on, so
 * the shell can leave out budget pages that have nothing to show. Presentation
 * only: every budget route and every order path decides from the database on
 * its own.
 *
 * The organization is the session's and nothing else — there is no parameter,
 * so no tenant can learn another tenant's setting. A Super Admin is not pinned
 * to a tenant and its budget pages answer per tenant, so it is told `true`.
 */
export async function GET() {
  // Exactly the roles whose navigation carries budget entries. The ordering
  // roles learn the setting from the budget read they already make.
  const authError = await requireApiRole(BUDGET_POLICY_READER_ROLES)
  if (authError) return authError

  const scope = await getRequestScope()
  if (!scope) return error("Unauthorized", 401)

  const budgetsEnabled = scope.role === "SUPER_ADMIN"
    ? true
    : await isOrganizationBudgetEnabled(scope.organizationId)

  return ok(
    { budgetsEnabled },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  )
}
