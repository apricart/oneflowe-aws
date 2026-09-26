import { NextResponse, type NextRequest } from "next/server"

import { activityLogAccessFailure } from "@/lib/activity-log-access"
import { parseActivityLogRequest } from "@/lib/activity-log-request"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadActivityPage } from "@/lib/server/activity-log-queries"

/**
 * `GET /api/v1/activity-logs` — the merged administrative trail.
 *
 * One read across `audit_logs`, `system_logs` and `group_audit_logs`, newest
 * first, keyset-paginated. Super Admin only, and not narrowed to a tenant: the
 * trail records action taken against every organization, including by Head
 * Office, so `lib/activity-log-access.ts` refuses every other role outright
 * rather than handing anyone a scoped view of their own audit.
 *
 * Reading this is not itself audited. No read in this application is, and a
 * write on this path would make the newest page of the trail mostly the
 * reader's own searches. Recorded as a deliberate decision in
 * `plans/OF-AUDIT-admin-activity-log.md`.
 *
 * Replaces nothing: `/api/v1/audit-logs`, which the deleted
 * `components/admin/audit-log-viewer.tsx` called, never existed.
 */
export async function GET(req: NextRequest) {
  try {
    // Enumerable and expensive: three tables, a free-text term and a date
    // window. `search` rather than `api` because that is what this is.
    const scope = await getRequestScope()
    const limited = await withRateLimit("search", scope?.userId)
    if (limited) return limited

    const denied = activityLogAccessFailure(scope?.role)
    if (denied) {
      return NextResponse.json({ error: denied.message }, { status: denied.status })
    }

    const parsed = parseActivityLogRequest(new URL(req.url).searchParams)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) },
        { status: 400 },
      )
    }

    const page = await loadActivityPage(parsed.filters)

    return NextResponse.json(page, {
      // A per-administrator view of a security trail must never be held by a
      // shared cache, and a stale page of an audit log is worse than a slow one.
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    })
  } catch (error) {
    const friendly = handleError(error, "ACTIVITY_LOG_READ")
    return NextResponse.json({ error: friendly.message }, { status: friendly.status })
  }
}
