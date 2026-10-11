import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { loadOrderDeskCatalogue } from "@/lib/server/order-desk-catalogue"
import { isOrderDeskTarget } from "@/lib/server/order-desk-scope"

/**
 * The products an Order Desk user may order for one branch, priced through the
 * same ladder the order is created at. The branch is named in the query string
 * and checked against the desk user's reach before anything is read; a branch
 * it does not reach is 403, whatever organization the query names.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

const querySchema = z.object({
  organizationId: z.coerce.number().int().positive(),
  branchId: z.coerce.number().int().positive(),
}).strict()

export async function GET(req: NextRequest) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("search", user.id)
    if (rateLimit) return rateLimit

    const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    const { organizationId, branchId } = parsed.data

    if (!await isOrderDeskTarget(db, { userId: user.id, organizationId, branchId })) {
      return NextResponse.json({ error: "You are not assigned to order for this branch" }, { status: 403 })
    }

    const items = await loadOrderDeskCatalogue({ organizationId, branchId })
    return NextResponse.json({ items }, { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/catalogue")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
