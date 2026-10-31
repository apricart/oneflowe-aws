import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { CUSTOMER_RETURN_STATUSES } from "@/lib/procurement"
import { CUSTOMER_RETURN_ADMIN_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { listCustomerReturns, recordCustomerReturn } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { customerReturnCreateSchema } from "@/lib/server/procurement-validation"

/**
 * Every warehouse's customer returns, for Super Admin, who may also record one
 * (audited `RECORD_CUSTOMER_RETURN`). The warehouse records its own, and the
 * executive decides its warehouses', on their own routes.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...CUSTOMER_RETURN_ADMIN_ROLES])
    if (roleError) return roleError
    const status = new URL(req.url).searchParams.get("status") ?? undefined
    if (status && !(CUSTOMER_RETURN_STATUSES as readonly string[]).includes(status)) return error("Unknown status", 400)
    return json({ items: await listCustomerReturns(db, { warehouseIds: null, status }) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/returns")
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole([...CUSTOMER_RETURN_ADMIN_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = customerReturnCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await recordCustomerReturn({ ...parsed.data, allowedWarehouseIds: null, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/returns")
  }
}
