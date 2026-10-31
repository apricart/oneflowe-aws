import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { recordGoodsReceipt } from "@/lib/server/procurement"
import { caughtResponse, failureResponse, json, procurementActor, routeId } from "@/lib/server/procurement-route"
import { goodsReceiptSchema } from "@/lib/server/procurement-validation"
import { loadWarehouseMemberships } from "@/lib/server/warehouse-scope"

/**
 * The warehouse records what arrived against an approved purchase order of one
 * of its own warehouses, within the over-delivery allowance; the goods go on
 * that warehouse's shelf in the same transaction (`RECORD_GOODS_RECEIPT`).
 * The membership is re-read under FOR SHARE inside the write, so Super Admin
 * removing the operator waits for it. See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)
    const id = routeId((await props.params).id)
    if (id === null) return error("Not found", 404)
    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = goodsReceiptSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await recordGoodsReceipt({
      purchaseOrderId: id,
      ...parsed.data,
      resolveAllowedWarehouseIds: (tx) => loadWarehouseMemberships(tx, user.id, { lock: true }),
      actor: procurementActor(user),
    })
    return failureResponse(outcome) ?? json(outcome, 201)
  } catch (caught) {
    return caughtResponse(caught, "POST /api/v1/warehouse/procurement/purchase-orders/[id]/receipts")
  }
}
