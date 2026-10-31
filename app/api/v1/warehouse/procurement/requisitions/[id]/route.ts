import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { decideRequisition } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { requisitionDecisionSchema } from "@/lib/server/procurement-validation"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"

/**
 * The warehouse withdraws one of its own warehouses' requisitions while it is
 * still waiting — cancel only; rejecting is Procurement's.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = requisitionDecisionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    if (parsed.data.action !== "cancel") return error("A warehouse may only cancel its own requisition.", 403)

    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    const outcome = await decideRequisition({
      id,
      action: "cancel",
      reason: parsed.data.reason,
      allowedWarehouseIds: warehouseIds,
      actor: procurementActor(user),
    })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/warehouse/procurement/requisitions/[id]")
  }
}
