import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { CUSTOMER_RETURN_ADMIN_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { decideCustomerReturn } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { customerReturnDecisionSchema } from "@/lib/server/procurement-validation"

/**
 * Super Admin approves (resaleable goods back on the shelf) or rejects any
 * pending customer return. Audited `APPROVE_/REJECT_CUSTOMER_RETURN`.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...CUSTOMER_RETURN_ADMIN_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = customerReturnDecisionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await decideCustomerReturn({
      id,
      action: parsed.data.action,
      reason: parsed.data.reason,
      resolveAllowedWarehouseIds: null,
      actor: procurementActor(user),
    })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/procurement/returns/[id]")
  }
}
