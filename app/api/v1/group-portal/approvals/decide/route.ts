import { type NextRequest } from "next/server"

import { error, ok, readJson } from "@/lib/api"
import { getCurrentUser, type RequestScope } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { requireGroupApprover } from "@/lib/server/group-order-access"
import {
  approveOrder,
  orderDecisionErrorResponse,
  rejectOrder,
  type OrderDecisionOutcome,
} from "@/lib/server/order-decision-service"
import { attemptImmediateOrderEmailDelivery } from "@/lib/server/order-notifications"
import { groupOrderDecisionSchema, validationMessage } from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

type DecisionResult = {
  orderId: number
  ok: boolean
  status: "approved" | "rejected" | "failed"
  message?: string
  /** Returned once, for approvals only, so the approver can pass it on. */
  approvalToken?: string
}

function toResult(orderId: number, outcome: OrderDecisionOutcome, decision: "approve" | "reject"): DecisionResult {
  if (outcome.kind === "approved") {
    return { orderId, ok: true, status: "approved", approvalToken: outcome.approvalToken }
  }
  if (outcome.kind === "rejected") {
    return { orderId, ok: true, status: "rejected" }
  }

  const failure = orderDecisionErrorResponse(outcome, decision)
  return {
    orderId,
    ok: false,
    status: "failed",
    message: failure?.message ?? "Decision could not be completed",
  }
}

/**
 * Decide each requested order in turn.
 *
 * Sequential by design: each decision moves budget and stock ledgers, and
 * ordering the work keeps lock acquisition predictable under concurrency. One
 * order failing never rolls back the ones that succeeded.
 */
async function runDecisions(
  orderIds: number[],
  decision: "approve" | "reject",
  scope: RequestScope,
  user: { id: string; email?: string | null; role: string },
  reason: string | undefined,
): Promise<{ results: DecisionResult[]; eventKeys: string[] }> {
  const results: DecisionResult[] = []
  const eventKeys: string[] = []

  for (const orderId of orderIds) {
    const outcome = decision === "approve"
      ? await approveOrder({ orderId, scope, user })
      : await rejectOrder({ orderId, scope, user, reason: reason as string })

    if (outcome.kind === "approved" || outcome.kind === "rejected") {
      eventKeys.push(...outcome.eventKeys)
    }
    results.push(toResult(orderId, outcome, decision))
  }

  return { results, eventKeys }
}

function decisionSummary(
  decision: "approve" | "reject",
  succeeded: number,
  total: number,
): string {
  const verb = decision === "approve" ? "approved" : "rejected"
  if (succeeded === total) {
    return `${succeeded} order${succeeded === 1 ? "" : "s"} ${verb}`
  }
  return `${succeeded} of ${total} orders ${verb}`
}

/**
 * Decide one order, or every order in a group order, in a single request.
 *
 * Each id is decided independently, in its own transaction, through the same
 * `approveOrder` / `rejectOrder` service the single-order routes use. That
 * means authorization is re-evaluated per order against the caller's live
 * branch scope: an id belonging to a branch this approver does not cover, or to
 * another tenant, simply comes back as a failed row rather than being written.
 *
 * A partially applicable selection still does the work it legitimately can —
 * the response reports the outcome of every id.
 */
export async function POST(req: NextRequest) {
  const { actor, response } = await requireGroupApprover()
  if (response) return response

  const user = await getCurrentUser()
  if (!user || user.id !== actor.scope.userId || user.role !== actor.scope.role) {
    return error("Unauthorized", 401)
  }

  const rateLimited = await withRateLimit("order", actor.scope.userId)
  if (rateLimited) return rateLimited

  const parsed = groupOrderDecisionSchema.safeParse(await readJson(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)

  const { decision, orderIds, reason } = parsed.data
  if (decision === "reject" && !reason) {
    return error("A reason is required to reject orders", 400)
  }

  const { results, eventKeys } = await runDecisions(
    orderIds,
    decision,
    actor.scope,
    user,
    reason,
  )

  // One batched flush rather than a delivery attempt per order.
  if (eventKeys.length > 0) await attemptImmediateOrderEmailDelivery(eventKeys)

  const succeeded = results.filter((result) => result.ok).length

  return ok({
    message: decisionSummary(decision, succeeded, results.length),
    decision,
    succeeded,
    failed: results.length - succeeded,
    results,
  })
}
