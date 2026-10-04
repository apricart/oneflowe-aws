import { NextResponse, type NextRequest } from "next/server"

import { applyActivityReach, resolveActivityLogReach } from "@/lib/activity-log-access"
import { parseActivityLogRequest } from "@/lib/activity-log-request"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadActivityPage } from "@/lib/server/activity-log-queries"

/**
 * `GET /api/v1/activity-logs` — the merged administrative trail.
 *
 * One read across `audit_logs`, `system_logs` and `group_audit_logs`, newest
 * first, keyset-paginated. Two readers (`lib/activity-log-access.ts`):
 *
 * * Super Admin reads every tenant.
 * * Head Office reads its own organization — fenced in every branch of the
 *   union to the organization on its `users` row, with anyone outside the
 *   tenant anonymised. See `plans/OF-AUDIT-head-office-activity-log.md`.
 *
 * Every other role is refused.
 *
 * Reading this is not itself audited. No read in this application is, and a
 * write on this path would make the newest page of the trail mostly the
 * reader's own searches. Recorded as a deliberate decision in
 * `plans/OF-AUDIT-admin-activity-log.md`.
 */
export async function GET(req: NextRequest) {
  try {
    // Enumerable and expensive: three tables, a free-text term and a date
    // window. `search` rather than `api` because that is what this is.
    const scope = await getRequestScope()
    const limited = await withRateLimit("search", scope?.userId)
    if (limited) return limited

    // The reach comes from the server-resolved scope — the organization is
    // re-read from the `users` row — never from anything in the request.
    const access = resolveActivityLogReach(scope)
    if (!access.ok) {
      return NextResponse.json({ error: access.failure.message }, { status: access.failure.status })
    }

    const parsed = parseActivityLogRequest(new URL(req.url).searchParams)
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) },
        { status: 400 },
      )
    }

    const fenced = applyActivityReach(parsed.filters, access.reach)
    if (!fenced.ok) {
      return NextResponse.json({ error: fenced.failure.message }, { status: fenced.failure.status })
    }

    const page = await loadActivityPage(fenced.filters)

    return NextResponse.json(page, {
      // A per-reader view of a security trail must never be held by a shared
      // cache, and a stale page of an audit log is worse than a slow one.
      headers: { "Cache-Control": "private, no-store, max-age=0" },
    })
  } catch (error) {
    const friendly = handleError(error, "ACTIVITY_LOG_READ")
    return NextResponse.json({ error: friendly.message }, { status: friendly.status })
  }
}
