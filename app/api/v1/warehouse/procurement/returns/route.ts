import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { listCustomerReturns, recordCustomerReturn } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { customerReturnCreateSchema } from "@/lib/server/procurement-validation"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"

/**
 * Customer returns at the warehouses this account works: it reads them and
 * records new ones (audited `RECORD_CUSTOMER_RETURN`), naming an order only
 * from those it works. A warehouse executive or Super Admin decides them.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    return json({ items: await listCustomerReturns(db, { warehouseIds }) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/warehouse/procurement/returns")
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = customerReturnCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const warehouseIds = await loadWarehouseMemberships(db, user.id)
    const outcome = await recordCustomerReturn({ ...parsed.data, allowedWarehouseIds: warehouseIds, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/warehouse/procurement/returns")
  }
}
