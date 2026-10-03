import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { sendJoinDecisionEmail } from "@/lib/email/join-request"
import { handleError } from "@/lib/error-handler"
import { JOIN_REQUEST_MANAGEMENT_ROLES } from "@/lib/organization-join-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { env } from "@/lib/server/env"
import { joinRequestDecisionSchema, validationMessage } from "@/lib/server/mutation-validation"
import { decideJoinRequest } from "@/lib/server/organization-join"
import { writeJoinAudit } from "@/lib/server/organization-join-audit"
import { resolveJoinManagementScope } from "@/lib/server/organization-join-scope"

/**
 * PATCH /api/v1/join-requests/[id] — approve or reject one request.
 *
 * **The only route in the application that turns a join request into a user**,
 * and it admits Head Office alone. Without a call to this endpoint a request
 * stays a row: nobody joins an organization without its head office saying so.
 *
 * The fence is the pair `(id, organizationId-from-session)` in the `WHERE` of
 * the `FOR UPDATE` lock inside `decideJoinRequest`. A request belonging to
 * another tenant is therefore *not found* rather than forbidden — the same
 * answer as one that does not exist, so the id space cannot be enumerated.
 *
 * Replay is handled by that same lock plus the status check: two administrators
 * approving at once produce one user and one 409, and a retried approval of an
 * already-decided request is a 409 rather than a second account.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authError = await requireApiRole(JOIN_REQUEST_MANAGEMENT_ROLES)
    if (authError) return authError

    const scope = await resolveJoinManagementScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const { id } = await params
    // Digits only, before parsing. `Number.parseInt` would read "1.5" and "1abc"
    // as 1 and go on to decide request 1 — a different row than the caller
    // named, on an endpoint that creates an account.
    if (!/^\d+$/.test(id)) return error("Invalid join request id", 400)
    const requestId = Number.parseInt(id, 10)
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return error("Invalid join request id", 400)
    }

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsed = joinRequestDecisionSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    const outcome = await decideJoinRequest({
      requestId,
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      decision: input.decision,
      reason: input.reason ?? null,
      // Picked field by field rather than spread, so a future schema addition
      // cannot become an applied update by accident.
      overrides: {
        role: input.role,
        branchId: input.branchId,
        groupIds: input.groupIds,
        branchIds: input.branchIds,
        budgetAllocationEnabled: input.budgetAllocationEnabled,
      },
    })

    if (!outcome.ok) return error(outcome.message, outcome.status)

    await writeJoinAudit({
      action: outcome.decision === "approve"
        ? "APPROVE_ORGANIZATION_JOIN_REQUEST"
        : "REJECT_ORGANIZATION_JOIN_REQUEST",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      entityId: String(outcome.requestId),
      metadata: {
        createdUserId: outcome.createdUserId,
        grantedRole: outcome.role,
        username: outcome.username,
        reasonGiven: Boolean(input.reason),
        overridden: input.role !== undefined
          || input.branchId !== undefined
          || input.groupIds !== undefined
          || input.branchIds !== undefined,
        budgetAllocationEnabled: input.budgetAllocationEnabled === true,
      },
    })

    // Non-blocking: the decision is committed, and a mail failure must not make
    // Head Office believe it did not happen.
    void sendJoinDecisionEmail({
      to: outcome.email,
      firstName: outcome.firstName,
      username: outcome.username,
      organizationName: outcome.organizationName,
      approved: outcome.decision === "approve",
      loginUrl: new URL("/login", env.NEXTAUTH_URL).toString(),
    }).catch((emailError) => {
      console.error("[JOIN_REQUESTS] Failed to send the decision email:", emailError)
    })

    return ok({
      id: outcome.requestId,
      status: outcome.decision === "approve" ? "approved" : "rejected",
      createdUserId: outcome.createdUserId,
    })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "decide join request")
    return error(message, status)
  }
}
