import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { runWarehouseOwnershipCheck } from "@/lib/server/warehouse-ownership-check"

/**
 * Whether moving warehouse accounts onto warehouse membership would change
 * what any of them sees: per account, the branches it would lose or gain in
 * each membership mode, open orders whose branch is in no warehouse, and
 * branches no operator works. Super Admin only, read-only, run on demand (it
 * reads every warehouse account's reach three times). The same report as
 * `npm run check:warehouse-ownership`. It names accounts by id and username
 * and branches by id — no order, price or customer data.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2, decision 5).
 */

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("report", user.id)
    if (rateLimit) return rateLimit

    return NextResponse.json(await runWarehouseOwnershipCheck(db), { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/apricart-warehouses/ownership-check")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
