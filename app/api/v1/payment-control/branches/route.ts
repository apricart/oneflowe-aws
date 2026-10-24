import { NextRequest } from "next/server"

import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { orderingBlockBranchesQuerySchema } from "@/lib/ordering-block-branches"
import { canUseOrderingBlocksPage } from "@/lib/ordering-blocks-access"
import { validationMessage } from "@/lib/server/mutation-validation"
import { loadOrderingBlockBranches } from "@/lib/server/ordering-block-branches"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * GET /api/v1/payment-control/branches?filter=&search=&page=&pageSize=
 *
 * Head Office's Ordering Blocks page: every active branch of its own
 * organization against the unpaid-invoice block, with each branch's latest
 * exception (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md).
 * Head Office only; the organization is the session's and there is no
 * parameter that names one. With the organization's block switched off the
 * answer is `{ enabled: false }` and nothing is listed — which is also how
 * the side menu decides whether to offer the page. Nothing is written.
 */
export async function GET(req: NextRequest) {
  const denied = await requireApiRole(["HEAD_OFFICE"])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Unauthorized", 401)
    if (!canUseOrderingBlocksPage(scope.role)) return error("Forbidden", 403)
    if (!scope.organizationId) return error("Organization context required", 400)

    const params = Object.fromEntries(new URL(req.url).searchParams)
    const parsed = orderingBlockBranchesQuerySchema.safeParse(params)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const view = await loadOrderingBlockBranches(db, {
      organizationId: scope.organizationId,
      query: parsed.data,
      now: new Date(),
    })
    return ok(view, NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "PAYMENT_CONTROL_BRANCH_LIST")
    return error("Unable to load ordering blocks", 500)
  }
}
