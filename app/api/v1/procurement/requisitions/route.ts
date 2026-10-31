import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { REQUISITION_STATUSES } from "@/lib/procurement"
import { PROCUREMENT_MANAGE_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { createRequisition, listRequisitions } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { requisitionCreateSchema } from "@/lib/server/procurement-validation"

/**
 * Every warehouse's requisitions, for Procurement and Super Admin, who may
 * also raise one for any warehouse. The warehouse raises its own on
 * `/api/v1/warehouse/procurement/requisitions`. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_MANAGE_ROLES])
    if (roleError) return roleError
    const status = new URL(req.url).searchParams.get("status") ?? undefined
    if (status && !(REQUISITION_STATUSES as readonly string[]).includes(status)) return error("Unknown status", 400)
    return json({ items: await listRequisitions(db, { warehouseIds: null, status }) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/requisitions")
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

    const parsed = requisitionCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await createRequisition({ ...parsed.data, allowedWarehouseIds: null, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/requisitions")
  }
}
