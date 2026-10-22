import { NextRequest, NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { parseDeskCatalogueQuery } from "@/lib/order-desk-catalogue-query"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadOrderDeskCatalogue } from "@/lib/server/order-desk-catalogue"
import { isOrderDeskTarget } from "@/lib/server/order-desk-scope"

/**
 * The products an Order Desk user may order for one branch: every active
 * Apricart product, a page at a time, each labelled with whether the branch
 * carries it and, if so, its catalogue price there
 * (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md).
 *
 * The branch is named in the query string and checked against the desk user's
 * reach before anything is read; a branch it does not reach is 403, whatever
 * organization the query names. A product never confers reach.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET(req: NextRequest) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("search", user.id)
    if (rateLimit) return rateLimit

    const parsed = parseDeskCatalogueQuery(req.nextUrl.searchParams)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const { organizationId, branchId } = parsed.value

    if (!await isOrderDeskTarget(db, { userId: user.id, organizationId, branchId })) {
      return NextResponse.json({ error: "You are not assigned to order for this branch" }, { status: 403 })
    }

    const page = await loadOrderDeskCatalogue({ organizationId, branchId }, parsed.value)
    return NextResponse.json(page, { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/catalogue")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
