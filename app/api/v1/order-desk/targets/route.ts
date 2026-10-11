import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadOrderDeskTargets } from "@/lib/server/order-desk-scope"

/**
 * The organizations and branches this Order Desk user may order for: managed
 * organizations it is assigned to, active, with their active branches. Names
 * only — no prices, no figures. Read from the database on every request, so a
 * grant Super Admin withdraws disappears on the next load.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET() {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("search", user.id)
    if (rateLimit) return rateLimit

    const items = await loadOrderDeskTargets(user.id)
    return NextResponse.json({ items }, { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/targets")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
