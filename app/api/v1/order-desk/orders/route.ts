import { NextRequest, NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { parseDeskOrderListQuery } from "@/lib/order-desk-query"
import { withRateLimit } from "@/lib/rate-limiter"
import { listDeskOrders } from "@/lib/server/order-desk-orders"

/**
 * The Order Desk's order list: orders the desk entered, at branches this desk
 * user currently reaches. Paginated and bounded. The organization and branch
 * filters only narrow that set; they can never reach past it.
 *
 * Creating an order is `POST /api/v1/orders`, the one creation path every role
 * shares, so its budget, stock and pricing rules are not restated here.
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

    const query = parseDeskOrderListQuery(req.nextUrl.searchParams)
    if (!query.ok) return NextResponse.json({ error: query.error }, { status: 400 })

    const page = await listDeskOrders(user.id, query.value)
    return NextResponse.json(page, { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/orders")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
