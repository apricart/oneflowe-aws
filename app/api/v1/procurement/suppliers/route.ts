import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { PROCUREMENT_MANAGE_ROLES, PROCUREMENT_READ_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { createSupplier, listSuppliers } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { supplierCreateSchema } from "@/lib/server/procurement-validation"

/**
 * Apricart's suppliers. Read by Procurement, Super Admin and Finance; created
 * by Procurement and Super Admin (audited `CREATE_PROCUREMENT_SUPPLIER`).
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    return json({ items: await listSuppliers(db) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/suppliers")
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

    const parsed = supplierCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await createSupplier({ ...parsed.data, actor: procurementActor(user) })
    if (outcome.kind === "duplicate") return json({ error: "A supplier with that name already exists." }, 409)
    return failureResponse(outcome) ?? json({ supplier: outcome.supplier }, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/suppliers")
  }
}
