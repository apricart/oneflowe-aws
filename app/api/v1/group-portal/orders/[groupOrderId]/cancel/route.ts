import { NextResponse } from "next/server"

import { error, readJson } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { GROUP_ORDER_NOTHING_TO_CANCEL_MESSAGE } from "@/lib/group-order-cancel"
import { withRateLimit } from "@/lib/rate-limiter"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { cancelPendingGroupSubmission } from "@/lib/server/group-order-cancel"
import { groupOrderCancelSchema, validationMessage } from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

/**
 * Cancel every branch order of one group order that is still waiting for
 * approval (`plans/OF-GROUP-cancel-pending-group-orders.md`).
 *
 * Group Order Portal only, and only for a submission this same user raised in
 * their own tenant — anything else is 404, as on the tokens route. Branch
 * orders already approved (or past it), and any at a branch no longer in the
 * caller's assignments, are kept and reported back. 409 when nothing in the
 * submission is still pending. One transaction: either every pending branch
 * order is cancelled and released, or none is.
 */
export async function POST(req: Request, props: { params: Promise<{ groupOrderId: string }> }) {
  try {
    const { actor, response } = await requireGroupOrderPortal()
    if (response) return response

    const rateLimited = await withRateLimit("write", actor.scope.userId)
    if (rateLimited) return rateLimited

    const { groupOrderId: rawId } = await props.params
    const groupOrderId = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    if (!Number.isSafeInteger(groupOrderId) || groupOrderId <= 0) return error("Invalid group order ID", 400)

    const parsed = groupOrderCancelSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const user = await getCurrentUser()
    const outcome = await cancelPendingGroupSubmission({
      groupOrderId,
      reason: parsed.data.reason,
      actor: {
        userId: actor.scope.userId,
        organizationId: actor.organizationId,
        role: actor.scope.role,
        email: user?.email ?? null,
      },
    })

    switch (outcome.kind) {
      case "cancelled":
        return NextResponse.json({
          message: `${outcome.cancelled.length} pending order${outcome.cancelled.length === 1 ? "" : "s"} cancelled`,
          reference: outcome.reference,
          cancelled: outcome.cancelled,
          kept: outcome.kept,
        })
      case "not-found":
        return error("Group order not found", 404)
      case "nothing-pending":
        return NextResponse.json({ error: GROUP_ORDER_NOTHING_TO_CANCEL_MESSAGE, kept: outcome.kept }, { status: 409 })
      case "conflict":
        return error("An order in this group order was changed by another request; reload and try again", 409)
    }
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/group-portal/orders/[groupOrderId]/cancel")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
