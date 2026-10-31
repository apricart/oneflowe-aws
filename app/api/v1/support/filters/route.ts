import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isSupportParticipantRole } from "@/lib/support-access"
import { isSupportApricartRole } from "@/lib/support-thread"
import { getSupportFilterOptions } from "@/lib/server/support-threads"
import { supportReaderFromSession, withSupportReach } from "@/lib/server/support-session"

/**
 * The choices behind the queue's organization, branch and group filters.
 *
 * Scoped by `supportScopeCondition`, exactly as the thread list is: every
 * organization, branch and group named here is one the caller already has a
 * thread at. There is no parameter of any kind, so nothing a caller sends can
 * widen it. Ids and names only — no counts, no subjects, no people.
 *
 * Organizations are offered only on Apricart's side, the one side the list
 * route lets narrow by tenant; everyone else reads a single organization.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = await withSupportReach(supportReaderFromSession(session))
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("search", viewer.userId)
    if (rateLimit) return rateLimit

    const options = await getSupportFilterOptions(viewer)

    return NextResponse.json(
      {
        organizations: isSupportApricartRole(viewer.role) ? options.organizations : [],
        branches: options.branches,
        groups: options.groups,
      },
      // An authenticated, tenant-scoped response must never sit in a shared cache.
      { headers: { "Cache-Control": "private, no-store" } },
    )
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/filters")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
