import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { decideCustomerReturn, loadExecutiveWarehouseIds } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { customerReturnDecisionSchema } from "@/lib/server/procurement-validation"

/**
 * An Apricart Executive approves or rejects a pending customer return at a
 * warehouse it is an executive member of. The membership is re-read under
 * FOR SHARE inside the deciding transaction; any other return is 404.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["APRICART_EXECUTIVE"])
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
      resolveAllowedWarehouseIds: (tx) => loadExecutiveWarehouseIds(tx, user.id, { lock: true }),
      actor: procurementActor(user),
    })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/executive/returns/[id]")
  }
}
