import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { GOODS_RECEIPT_ADMIN_ROLES } from "@/lib/procurement-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { recordGoodsReceipt } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { goodsReceiptSchema } from "@/lib/server/procurement-validation"

/**
 * Super Admin records a goods receipt against any approved purchase order
 * (the warehouse records its own on `/api/v1/warehouse/procurement/...`). The
 * receipt, the PO's received quantities, the stock movement and the audit row
 * (`RECORD_GOODS_RECEIPT`) are one transaction. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...GOODS_RECEIPT_ADMIN_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = goodsReceiptSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await recordGoodsReceipt({ purchaseOrderId: id, ...parsed.data, resolveAllowedWarehouseIds: null, actor: procurementActor(user) })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/procurement/purchase-orders/[id]/receipts")
  }
}
