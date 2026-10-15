import { error, ok, requireApiRole } from "@/lib/api"
import { handleError } from "@/lib/error-handler"
import { isJoinRequestStatus } from "@/lib/organization-join"
import { JOIN_REQUEST_MANAGEMENT_ROLES } from "@/lib/organization-join-access"
import {
  countPendingJoinRequests,
  listJoinRequests,
  MAX_JOIN_REQUEST_PAGE,
} from "@/lib/server/organization-join"
import { resolveJoinManagementScope } from "@/lib/server/organization-join-scope"

/**
 * GET /api/v1/join-requests — the tenant's own join queue.
 *
 * Head Office alone, and only ever its own organization: the tenant predicate
 * comes from the session through `resolveJoinManagementScope` and there is no
 * `organizationId` parameter to override it.
 *
 * `status` is the one filter, and it is validated against
 * `JOIN_REQUEST_STATUSES` rather than reaching SQL as a string. The page is
 * bounded at `MAX_JOIN_REQUEST_PAGE` whatever `limit` asks for.
 *
 * The selected columns are fixed in `listJoinRequests`, which deliberately omits
 * `password_hash`, `submitted_ip` and `submitted_user_agent`.
 */
export async function GET(req: Request) {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES, { viewerReadsAsHeadOffice: true })
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const { searchParams } = new URL(req.url)
    const statusParam = searchParams.get("status")
    if (statusParam !== null && !isJoinRequestStatus(statusParam)) {
      return error("Unknown status filter", 400)
    }

    const limitParam = Number(searchParams.get("limit"))
    const limit = Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_JOIN_REQUEST_PAGE)
      : MAX_JOIN_REQUEST_PAGE

    // Counted separately rather than from `items`, which a status filter or the
    // page bound can make an undercount — the badge must not go stale silently.
    const [items, pendingCount] = await Promise.all([
      listJoinRequests({
        organizationId: scope.organizationId,
        status: statusParam ?? undefined,
        limit,
      }),
      countPendingJoinRequests(scope.organizationId),
    ])

    return ok({ items, pendingCount })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "list join requests")
    return error(message, status)
  }
}
