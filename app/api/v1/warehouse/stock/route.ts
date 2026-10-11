import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { listWarehouseStock } from "@/lib/server/warehouse-stock"
import { parseWarehouseStockQuery } from "@/lib/warehouse-stock"

export const dynamic = "force-dynamic"

/**
 * Available stock, read-only, for the warehouse: every global product's code,
 * name, unit, status and stock quantity. Nothing here writes; stock movements
 * are a later phase (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md).
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const parsed = parseWarehouseStockQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    return NextResponse.json(await listWarehouseStock(parsed.value), { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/stock")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
