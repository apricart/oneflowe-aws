import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadDeskTeam } from "@/lib/server/order-desk-team"

/**
 * Super Admin's Desk team screen: every Order Desk user with the reach granted
 * to them, and the managed organizations (with branches) that can be granted.
 * Super Admin only — the desk itself is refused here by the role check and,
 * before that, by the proxy's desk allowlist.
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

    return NextResponse.json(await loadDeskTeam(), { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/order-desk/team")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
