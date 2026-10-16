import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import {
  MAX_HEAD_COUNT_REQUEST_PAGE,
  isHeadCountRequestStatus,
} from "@/lib/branch-head-count"
import {
  HEAD_COUNT_REQUEST_READ_ROLES,
  HEAD_COUNT_REQUEST_ROLES,
} from "@/lib/branch-head-count-access"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isOrganizationViewer } from "@/lib/viewer-access"
import {
  countPendingHeadCountRequests,
  createHeadCountRequest,
  listHeadCountRequestableBranches,
  listHeadCountRequests,
  type HeadCountRequestListScope,
} from "@/lib/server/branch-head-count-requests"
import {
  resolveHeadCountApproverScope,
  resolveHeadCountRequesterScope,
} from "@/lib/server/branch-head-count-scope"
import {
  branchHeadCountRequestCreateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

type ReadableScope = {
  ok: true
  organizationId: number
  branches: HeadCountRequestListScope
  requestableBranchIds: number[]
  canDecide: boolean
}

/**
 * What this caller may read, from the session. Head Office reads its tenant;
 * a requester reads its own branches. A `branchId` on the query string only
 * ever narrows: intersected with a requester's set, and inside Head Office's
 * tenant predicate, which is still applied.
 */
async function resolveReadableScope(
  branchIdParam: string | null,
): Promise<ReadableScope | { ok: false; response: Response }> {
  let requested: number | null = null
  if (branchIdParam !== null) {
    if (!/^\d+$/.test(branchIdParam)) return { ok: false, response: error("Invalid branch id", 400) }
    requested = Number.parseInt(branchIdParam, 10)
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      return { ok: false, response: error("Invalid branch id", 400) }
    }
  }

  // An organization-wide Viewer reads the tenant's queue as Head Office does and
  // decides nothing: `canDecide` stays false, and the PATCH refuses the role.
  const caller = await getRequestScope()
  if (caller && isOrganizationViewer(caller)) {
    return {
      ok: true,
      organizationId: Number(caller.organizationId),
      branches: requested === null ? { scope: "tenant" } : { scope: "branches", branchIds: [requested] },
      requestableBranchIds: [],
      canDecide: false,
    }
  }

  const approver = await resolveHeadCountApproverScope()
  if (approver.ok) {
    return {
      ok: true,
      organizationId: approver.organizationId,
      branches: requested === null ? { scope: "tenant" } : { scope: "branches", branchIds: [requested] },
      // Head Office decides requests and sets the figure directly; it raises none.
      requestableBranchIds: [],
      canDecide: true,
    }
  }

  const requester = await resolveHeadCountRequesterScope()
  if (!requester.ok) return requester

  return {
    ok: true,
    organizationId: requester.organizationId,
    branches: {
      scope: "branches",
      branchIds: requested === null
        ? requester.branchIds
        : requester.branchIds.filter((id) => id === requested),
    },
    requestableBranchIds: requester.branchIds,
    canDecide: false,
  }
}

/**
 * GET /api/v1/branch-head-count-requests — the head-count requests at the
 * branches this caller reaches, newest first, bounded at
 * `MAX_HEAD_COUNT_REQUEST_PAGE`.
 */
export async function GET(req: NextRequest) {
  try {
    const authError = await requireApiRole(HEAD_COUNT_REQUEST_READ_ROLES, { viewerReadsAsHeadOffice: true })
    if (authError) return authError

    const { searchParams } = new URL(req.url)
    const scope = await resolveReadableScope(searchParams.get("branchId"))
    if (!scope.ok) return scope.response

    const statusParam = searchParams.get("status")
    if (statusParam !== null && !isHeadCountRequestStatus(statusParam)) {
      return error("Unknown status filter", 400)
    }

    const limitParam = Number(searchParams.get("limit"))
    const limit = Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_HEAD_COUNT_REQUEST_PAGE)
      : MAX_HEAD_COUNT_REQUEST_PAGE

    const [items, requestableBranches] = await Promise.all([
      listHeadCountRequests({
        organizationId: scope.organizationId,
        branches: scope.branches,
        status: statusParam ?? undefined,
        limit,
      }),
      listHeadCountRequestableBranches({
        organizationId: scope.organizationId,
        branchIds: scope.requestableBranchIds,
      }),
    ])

    const pendingCount = scope.canDecide
      ? await countPendingHeadCountRequests(scope.organizationId)
      : items.filter((item) => item.status === "pending").length

    return ok({ items, pendingCount, requestableBranches, canDecide: scope.canDecide })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "list branch head count requests")
    return error(message, status)
  }
}

/**
 * POST /api/v1/branch-head-count-requests — a Branch Admin or Group User asks
 * Head Office to set a branch's head count.
 *
 * The branch must be in the caller's own resolved set (403 otherwise, before
 * anything is read). The row is always `pending`; the audit row is written by
 * `createHeadCountRequest` in the same transaction.
 */
export async function POST(req: NextRequest) {
  try {
    const authError = await requireApiRole(HEAD_COUNT_REQUEST_ROLES)
    if (authError) return authError

    const scope = await resolveHeadCountRequesterScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsed = branchHeadCountRequestCreateSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    if (!scope.branchIds.includes(input.branchId)) {
      return error("You are not assigned to that branch", 403)
    }

    const outcome = await createHeadCountRequest({
      organizationId: scope.organizationId,
      branchId: input.branchId,
      requestedByUserId: scope.actorUserId,
      requestedByRole: scope.role,
      headCount: input.headCount,
      reason: input.reason ?? null,
    })
    if (!outcome.ok) return error(outcome.message, outcome.status)

    return ok({ request: outcome.request }, { status: 201 })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "request branch head count")
    return error(message, status)
  }
}
