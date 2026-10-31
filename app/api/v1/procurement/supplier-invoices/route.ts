import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { SUPPLIER_INVOICE_STATUSES } from "@/lib/procurement"
import { PROCUREMENT_READ_ROLES, SUPPLIER_INVOICE_RECORD_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { listSupplierInvoices, recordSupplierInvoice } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor } from "@/lib/server/procurement-route"
import { supplierInvoiceCreateSchema } from "@/lib/server/procurement-validation"

/**
 * Supplier invoices and their three-way match. Read and recorded by
 * Procurement, Super Admin and Finance (audited `RECORD_SUPPLIER_INVOICE`).
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    const params = new URL(req.url).searchParams
    const status = params.get("status") ?? undefined
    if (status && !(SUPPLIER_INVOICE_STATUSES as readonly string[]).includes(status)) return error("Unknown status", 400)
    const rawOrderId = params.get("purchaseOrderId")
    const purchaseOrderId = rawOrderId && /^\d{1,9}$/.test(rawOrderId) ? Number(rawOrderId) : undefined
    if (rawOrderId && purchaseOrderId === undefined) return error("purchaseOrderId must be a number", 400)
    return json({ items: await listSupplierInvoices(db, { status, purchaseOrderId }) })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/supplier-invoices")
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole([...SUPPLIER_INVOICE_RECORD_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = supplierInvoiceCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await recordSupplierInvoice({ ...parsed.data, actor: procurementActor(user) })
    if (outcome.kind === "duplicate") return json({ error: "This supplier's invoice with that number is already recorded." }, 409)
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/supplier-invoices")
  }
}
