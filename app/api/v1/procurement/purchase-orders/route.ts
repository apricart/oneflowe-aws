import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { PROCUREMENT_MANAGE_ROLES, PROCUREMENT_READ_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { purchaseOrderCreateSchema, purchaseOrderListQuerySchema } from "@/lib/server/procurement-validation"

/**
 * Purchase orders with their costs. Read by Procurement, Super Admin and
 * Finance; drafted by Procurement and Super Admin (audited
 * `CREATE_PURCHASE_ORDER`). Naming a requisition converts it in the same
 * transaction. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    const query = purchaseOrderListQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
    if (!query.success) return error(validationMessage(query.error), 400)
    return json(await listPurchaseOrders(db, query.data))
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/purchase-orders")
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_MANAGE_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = purchaseOrderCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await createPurchaseOrder({ ...parsed.data, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/purchase-orders")
  }
}
