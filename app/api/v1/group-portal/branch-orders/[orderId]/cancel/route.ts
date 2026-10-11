import { NextResponse } from "next/server"

import { error, readJson } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { GROUP_ORDER_NOT_PENDING_MESSAGE } from "@/lib/group-order-cancel"
import { withRateLimit } from "@/lib/rate-limiter"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { cancelGroupBranchOrder } from "@/lib/server/group-order-cancel"
import { groupOrderCancelSchema, validationMessage } from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

/**
 * Cancel one branch order of a group order while it is still waiting for
 * approval (`plans/OF-GROUP-cancel-pending-group-orders.md`).
 *
 * Group Order Portal only, for a group order at a branch in the caller's live
 * assignments. Anything outside that reach — another tenant, an unassigned
 * branch, an order that is not a group order — is 404. An order already
 * approved (or past it) is 409. Its budget hold, quantity hold and stock are
 * released in the same transaction; the audit row and the raiser's notice are
 * written by `lib/server/group-order-cancel.ts`.
 */
export async function POST(req: Request, props: { params: Promise<{ orderId: string }> }) {
  try {
    const { actor, response } = await requireGroupOrderPortal()
    if (response) return response

    const rateLimited = await withRateLimit("write", actor.scope.userId)
    if (rateLimited) return rateLimited

    const { orderId: rawId } = await props.params
    const orderId = /^\d+$/.test(rawId) ? Number(rawId) : Number.NaN
    if (!Number.isSafeInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)

    const parsed = groupOrderCancelSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const user = await getCurrentUser()
    const outcome = await cancelGroupBranchOrder({
      orderId,
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
        return NextResponse.json({ message: "Order cancelled", order: outcome.order })
      case "not-found":
        return error("Order not found", 404)
      case "not-pending":
        return NextResponse.json({ error: GROUP_ORDER_NOT_PENDING_MESSAGE, status: outcome.status }, { status: 409 })
      case "conflict":
        return error("The order was changed by another request; reload and try again", 409)
    }
  } catch (caught) {
    const handled = handleError(caught, "POST /api/v1/group-portal/branch-orders/[orderId]/cancel")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
