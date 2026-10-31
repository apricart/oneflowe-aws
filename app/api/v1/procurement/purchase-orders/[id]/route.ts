import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { PROCUREMENT_MANAGE_ROLES, PROCUREMENT_READ_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { actOnPurchaseOrder, loadPurchaseOrder } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { purchaseOrderActionSchema } from "@/lib/server/procurement-validation"

/**
 * One purchase order: its lines and costs, receipts and invoices (Procurement,
 * Super Admin, Finance), and every change to it — edit, submit, withdraw,
 * cancel, close short (Procurement, Super Admin), approve and reject (Super
 * Admin only, checked again in `actOnPurchaseOrder`). Each change names the
 * `updatedAt` it saw. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const order = await loadPurchaseOrder(db, id)
    return order ? json({ order }) : error("Not found", 404)
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/purchase-orders/[id]")
  }
}

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

    const parsed = purchaseOrderActionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await actOnPurchaseOrder({ id, body: parsed.data, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/procurement/purchase-orders/[id]")
  }
}
