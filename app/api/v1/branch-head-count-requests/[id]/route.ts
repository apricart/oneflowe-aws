import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { HEAD_COUNT_DECISION_ROLES } from "@/lib/branch-head-count-access"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { decideHeadCountRequest } from "@/lib/server/branch-head-count-requests"
import { resolveHeadCountApproverScope } from "@/lib/server/branch-head-count-scope"
import {
  branchHeadCountDecisionSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

/**
 * PATCH /api/v1/branch-head-count-requests/[id] — Head Office approves or
 * rejects one request. An approval writes the figure to the branch in the same
 * transaction (`decideHeadCountRequest`), which also writes the audit row.
 *
 * Head Office alone. Another tenant's request is 404 — the fence is in the
 * `FOR UPDATE` — and a decided one is 409, so a retried approval cannot apply
 * twice.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authError = await requireApiRole(HEAD_COUNT_DECISION_ROLES)
    if (authError) return authError

    const scope = await resolveHeadCountApproverScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const { id } = await params
    // Digits only before parsing: "1abc" must not decide request 1.
    if (!/^\d+$/.test(id)) return error("Invalid head count request id", 400)
    const requestId = Number.parseInt(id, 10)
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return error("Invalid head count request id", 400)
    }

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsed = branchHeadCountDecisionSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await decideHeadCountRequest({
      requestId,
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      actorRole: scope.role,
      decision: parsed.data.decision,
      reason: parsed.data.reason ?? null,
    })
    if (!outcome.ok) return error(outcome.message, outcome.status)

    // The branch list is cached; an approval changed a branch row.
    if (outcome.status === "approved") await invalidateByPrefix("branches")

    return ok({
      id: outcome.requestId,
      status: outcome.status,
      branchId: outcome.branchId,
      headCount: outcome.headCount,
    })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "decide branch head count request")
    return error(message, status)
  }
}
