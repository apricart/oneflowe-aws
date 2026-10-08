import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { listWarehouseOrders } from "@/lib/server/warehouse-orders"
import { parseWarehouseOrderListQuery } from "@/lib/warehouse-orders"

export const dynamic = "force-dynamic"

/**
 * The warehouse's queue: approved orders at the branches assigned to this user,
 * open or recently delivered, with prices and invoice figures. The branch reach
 * is re-read on every request (`lib/server/warehouse-scope.ts`); a user with
 * none sees an empty list. See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const parsed = parseWarehouseOrderListQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    const page = await listWarehouseOrders(user.id, parsed.value, new Date())
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
