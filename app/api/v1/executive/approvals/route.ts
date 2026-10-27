import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { parseExecutiveApprovalListQuery } from "@/lib/executive-approval-query"
import { withRateLimit } from "@/lib/rate-limiter"
import { listExecutiveApprovals } from "@/lib/server/executive-approvals"

export const dynamic = "force-dynamic"

/**
 * An Apricart Executive's approval list: Order Desk orders in the
 * organizations Super Admin assigned to them, with the lines and amounts they
 * are approving. The reach is re-read on every request
 * (`lib/server/apricart-executive-scope.ts`); an executive with none sees an
 * empty list. Super Admin reads the same list for every desk order, from
 * Order Desk Team (`loadDeskApprovalReach`, the account re-read too).
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md and
 * plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md.
 */
export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "APRICART_EXECUTIVE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("search", user.id)
    if (rateLimited) return rateLimited

    const parsed = parseExecutiveApprovalListQuery(new URL(req.url).searchParams)
    if (!parsed.ok) return error(parsed.error, 400)

    const page = await listExecutiveApprovals(user.id, parsed.value)
    return NextResponse.json(page, { headers: { "Cache-Control": "private, no-store" } })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/executive/approvals")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
