import { ok } from "@/lib/api"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import {
  currentBudgetPeriod,
  loadBranchBudgetSummaries,
} from "@/lib/server/group-branch-budgets"
import { loadScopedBranches } from "@/lib/server/group-order-portal"
import { isOrganizationBudgetEnabled } from "@/lib/server/organization-budget-policy"

export const dynamic = "force-dynamic"

/**
 * This month's money budget for each location the signed-in Group Order Portal
 * user may order for — remaining against total, so a requester can see what a
 * branch has left before building a cart for it.
 *
 * The branch set comes from the user's own assignments on the server; nothing
 * about it is accepted from the client, so this cannot be used to read the
 * budget of a branch the user was not given. It is a read: no budget row is
 * created, and no other role reaches it — `requireGroupOrderPortal` admits
 * GROUP_ORDER_PORTAL alone, leaving `/api/v1/budgets` and every other role's
 * budget path exactly as they were.
 */
export async function GET() {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const period = currentBudgetPeriod()

  // A tenant with budget allocation off has no budget to report; the
  // storefront hides its budget panel on this flag.
  if (!await isOrganizationBudgetEnabled(actor.organizationId)) {
    return ok({ items: [], period, budgetsEnabled: false })
  }

  // Fail closed: no assigned branches means there is no budget to report.
  const scopedBranches = await loadScopedBranches(actor.scope.userId, actor.organizationId)
  if (scopedBranches.length === 0) return ok({ items: [], period })

  const items = await loadBranchBudgetSummaries({
    organizationId: actor.organizationId,
    branchIds: scopedBranches.map((branch) => branch.id),
    period,
  })

  return ok({ items, period, budgetsEnabled: true })
}
