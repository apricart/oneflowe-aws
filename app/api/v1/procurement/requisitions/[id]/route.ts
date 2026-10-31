import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { PROCUREMENT_MANAGE_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { decideRequisition } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { requisitionDecisionSchema } from "@/lib/server/procurement-validation"

/**
 * Reject or cancel a requisition that is still waiting, with a reason
 * (Procurement, Super Admin; audited `DECIDE_PURCHASE_REQUISITION`). Converting
 * one is creating a purchase order that names it. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_MANAGE_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = requisitionDecisionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await decideRequisition({ id, ...parsed.data, allowedWarehouseIds: null, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/procurement/requisitions/[id]")
  }
}
