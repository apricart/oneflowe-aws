import { NextResponse } from "next/server"

import { requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadExecutiveTeam } from "@/lib/server/apricart-executive-team"

/**
 * Super Admin's list of Apricart Executives, with the organizations each one
 * approves Order Desk orders for, and every organization that can be assigned.
 * Super Admin only — the executive and the desk are refused here by the role
 * check and, before that, by their proxy allowlists.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
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

    return NextResponse.json(await loadExecutiveTeam(), { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/apricart-executives")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
