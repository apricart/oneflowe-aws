import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { SUPPLIER_INVOICE_DECIDE_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { decideSupplierInvoice } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { supplierInvoiceDecisionSchema } from "@/lib/server/procurement-validation"

/**
 * Approve, reject or mark paid a supplier invoice (Finance, Super Admin). The
 * match is re-run on approval; an invoice that does not match is approved by
 * Super Admin only, with a reason — checked in `decideSupplierInvoice`.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...SUPPLIER_INVOICE_DECIDE_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = supplierInvoiceDecisionSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await decideSupplierInvoice({ id, body: parsed.data, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome)
  } catch (caught) {
    return caughtResponse(caught, "PATCH /api/v1/procurement/supplier-invoices/[id]")
  }
}
