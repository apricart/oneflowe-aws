import { ok } from "@/lib/api"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { loadScopedGroups } from "@/lib/server/group-order-portal"

export const dynamic = "force-dynamic"

/**
 * The groups this Group Order Portal user may raise orders for, each with the
 * branches of that group that are actually in their scope.
 *
 * Ordering is scoped to one group per submission, so this is the first step of
 * the wizard. The list is derived from the user's own assignments on the
 * server; nothing about the requested scope comes from the client.
 */
export async function GET() {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const groups = await loadScopedGroups(actor.scope.userId, actor.organizationId)

  return ok({
    items: groups,
    // A single group needs no choosing; the UI skips straight to the branches.
    autoSelectGroupId: groups.length === 1 ? groups[0].id : undefined,
  })
}
