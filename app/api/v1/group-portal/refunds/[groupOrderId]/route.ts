import { error, ok } from "@/lib/api"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { loadGroupRefundWorkspace } from "@/lib/server/group-order-refunds"

export const dynamic = "force-dynamic"

/**
 * What can still be refunded on one of this user's group orders.
 *
 * The response is the authoritative answer the refund screen is built from:
 * which branch orders are refundable and by how much, and why each of the
 * others is not. A group order that is not this user's own, inside their own
 * tenant, is a 404 — the same answer as one that does not exist, so this cannot
 * be used to probe for other users' group orders.
 */
export async function GET(
  _req: Request,
  props: { params: Promise<{ groupOrderId: string }> },
) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const { groupOrderId } = await props.params
  if (!/^\d+$/.test(groupOrderId)) return error("Invalid group order ID", 400)

  const parsed = Number(groupOrderId)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return error("Invalid group order ID", 400)

  const workspace = await loadGroupRefundWorkspace({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    groupOrderId: parsed,
  })
  if (!workspace) return error("Group order not found", 404)

  return ok({ item: workspace })
}
