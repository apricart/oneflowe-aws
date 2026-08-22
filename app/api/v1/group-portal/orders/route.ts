import { headers } from "next/headers"
import { type NextRequest } from "next/server"

import { error, ok, readJson } from "@/lib/api"
import { withRateLimit } from "@/lib/rate-limiter"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { createGroupOrder } from "@/lib/server/group-order-creation"
import {
  HISTORY_PAGE_SIZE_DEFAULT,
  HISTORY_PAGE_SIZE_MAX,
  listGroupOrders,
} from "@/lib/server/group-order-history"
import { resolveSubmissionScope } from "@/lib/server/group-order-portal"
import { groupOrderCreateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { resolveRequestClientIp } from "@/lib/server/request-ip"

export const dynamic = "force-dynamic"

// Same contract as the single-branch order endpoint, so clients retry safely.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

function parsePositiveInt(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * The group orders this user submitted, newest first, each with the live status
 * of the branch orders beneath it. Scoped to the caller's own submissions.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const { searchParams } = new URL(req.url)
  const requestedLimit = parsePositiveInt(searchParams.get("limit")) ?? HISTORY_PAGE_SIZE_DEFAULT

  const history = await listGroupOrders({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    page: parsePositiveInt(searchParams.get("page")) ?? 1,
    limit: Math.min(requestedLimit, HISTORY_PAGE_SIZE_MAX),
  })

  return ok(history)
}

/**
 * Submit one group order.
 *
 * The user experiences a single submission; the application records one
 * ordinary order per branch beneath a shared reference. Branches are created
 * independently, so the response reports each branch's outcome and a failure at
 * one branch never discards the orders that succeeded elsewhere.
 */
export async function POST(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const rateLimited = await withRateLimit("order", actor.scope.userId)
  if (rateLimited) return rateLimited

  const idempotencyKey = req.headers.get("idempotency-key")?.trim() || ""
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return error(
      "A valid Idempotency-Key header (8-128 letters, numbers, '.', '_', ':', or '-') is required",
      400,
    )
  }

  const parsed = groupOrderCreateSchema.safeParse(await readJson(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)
  const { groupId, entries, notes } = parsed.data

  // Every branch touched by any entry has to be inside the caller's live scope
  // and inside the selected group before any work begins.
  const requestedBranchIds = [...new Set(entries.flatMap((entry) => entry.branchIds))]
  const { scope, failure } = await resolveSubmissionScope({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    groupId,
    branchIds: requestedBranchIds,
  })
  if (failure) return error(failure.message, failure.status)

  const headerList = await headers()
  try {
    const outcome = await createGroupOrder({
      scope,
      organizationId: actor.organizationId,
      entries,
      notes: notes?.trim() || null,
      idempotencyKey,
      actor: {
        userId: actor.scope.userId,
        role: actor.scope.role,
        ipAddress: (await resolveRequestClientIp()) ?? "unknown",
        userAgent: headerList.get("user-agent"),
      },
    })

    if (!outcome.ok) return error(outcome.message, outcome.status)

    const { submission } = outcome
    return ok({
      message: submission.createdOrderCount === submission.requestedBranchCount
        ? "Group order submitted"
        : "Group order submitted with some branches skipped",
      item: submission,
    }, { status: submission.replayed ? 200 : 201 })
  } catch (submissionError) {
    // Per-branch failures are already reported in the response body, so
    // reaching here means the envelope itself could not be recorded. `error`
    // sanitizes 5xx messages, so nothing internal is returned to the caller.
    console.error("Group order submission failed", submissionError)
    return error("Group order could not be submitted", 500)
  }
}
