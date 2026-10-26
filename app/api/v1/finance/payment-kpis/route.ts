import { error, ok, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { FINANCE_KPI_ROLES, FINANCE_ORGANIZATION_MAX } from "@/lib/finance-access"
import type { Role } from "@/lib/rbac"
import { parseRequestedOrganizationIds } from "@/lib/server/analytics-scope"
import { loadPaymentKpis } from "@/lib/server/finance-payment-kpis"
import { resolveFinanceReadScope } from "@/lib/server/finance-scope"

/**
 * GET /api/v1/finance/payment-kpis — paid and unpaid orders, collection rate,
 * aging and a per-organization breakdown (plans/OF-FINANCE-finance-role.md).
 * Super Admin reads any organization (all when none is named); Finance only
 * its assigned ones, and naming another is 403.
 */
export async function GET(req: Request) {
  const roleError = await requireApiRole([...FINANCE_KPI_ROLES] as Role[])
  if (roleError) return roleError

  const user = await getCurrentUser()
  if (!user) return error("Unauthorized", 401)

  const { searchParams } = new URL(req.url)
  const requestedOrganizationIds = parseRequestedOrganizationIds({
    organizationIds: searchParams.get("organizationIds"),
    organizationId: searchParams.get("organizationId"),
  })
  if (requestedOrganizationIds.length > FINANCE_ORGANIZATION_MAX) return error("Too many organizations", 400)

  const startParam = searchParams.get("startDate")
  const endParam = searchParams.get("endDate")
  const startDate = (startParam ? parseStartDateParam(startParam) : null) ?? null
  const endDate = (endParam ? parseEndDateParam(endParam) : null) ?? null
  if ((startParam && !startDate) || (endParam && !endDate)) return error("Invalid date range", 400)
  if (startDate && endDate && startDate > endDate) return error("Start date must be before end date", 400)

  const financeScope = await resolveFinanceReadScope({ role: user.role, userId: user.id, requestedOrganizationIds })
  if (financeScope && !financeScope.ok) return error(financeScope.error, financeScope.status)

  const organizationIds = financeScope
    ? financeScope.organizationIds
    : (requestedOrganizationIds.length > 0 ? requestedOrganizationIds : null)

  const kpis = await loadPaymentKpis({ organizationIds, startDate, endDate })
  return ok(kpis, { headers: { "Cache-Control": "private, no-store, max-age=0" } })
}
