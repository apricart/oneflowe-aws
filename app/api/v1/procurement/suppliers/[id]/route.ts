import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { PROCUREMENT_MANAGE_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { updateSupplier } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { supplierUpdateSchema } from "@/lib/server/procurement-validation"

/**
 * Edit a supplier or switch it inactive (Procurement, Super Admin; audited
 * `UPDATE_PROCUREMENT_SUPPLIER`). An inactive supplier keeps its history and
 * takes no new purchase order. See plans/OF-PROCUREMENT-purchasing.md.
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

    const parsed = supplierUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await updateSupplier(id, { ...parsed.data, actor: procurementActor(user) })
    if (outcome.kind === "duplicate") return json({ error: "A supplier with that name already exists." }, 409)
    return failureResponse(outcome) ?? json({ supplier: outcome.supplier })
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/procurement/suppliers/[id]")
  }
}
