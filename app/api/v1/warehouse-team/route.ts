import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadWarehouseTeam } from "@/lib/server/warehouse-team"

/**
 * Super Admin's list of warehouse accounts, the branches each one serves, and
 * every branch that can be assigned. Super Admin only — the warehouse itself
 * is refused here by the role check and, before that, by its proxy allowlist.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("search", user.id)
    if (rateLimit) return rateLimit

    return NextResponse.json(await loadWarehouseTeam(), { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/warehouse-team")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
