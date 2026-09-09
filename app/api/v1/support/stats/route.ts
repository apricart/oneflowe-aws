import { NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isSupportParticipantRole } from "@/lib/support-access"
import { getSupportThreadStats } from "@/lib/server/support-threads"
import { supportViewerFromSession } from "@/lib/server/support-session"

/**
 * The figures above the support queue.
 *
 * Scoped by `supportScopeCondition`, exactly as the thread list is, so every
 * count covers the threads this caller could open and no more. There is no
 * parameter of any kind — not a tenant, not a filter — so there is nothing a
 * caller could send to widen it, and Apricart's totals differ from a branch
 * administrator's only because their scope does.
 *
 * Aggregates only. No subject, no message and no name is returned, so a tile
 * cannot disclose a thread its reader could not already open.
 */
export async function GET() {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportViewerFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("search", viewer.userId)
    if (rateLimit) return rateLimit

    const stats = await getSupportThreadStats(viewer)

    // An authenticated, tenant-scoped response must never sit in a shared cache.
    return NextResponse.json(stats, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/stats")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
