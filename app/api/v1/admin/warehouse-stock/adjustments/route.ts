import { NextResponse } from "next/server"

import { error, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage, warehouseStockAdjustmentSchema } from "@/lib/server/mutation-validation"
import { adjustWarehouseStock } from "@/lib/server/warehouse-stock"
import { isStockLedgerMissing, STOCK_LEDGER_MISSING_MESSAGE } from "@/lib/server/warehouse-stock-errors"
import { WAREHOUSE_STOCK_MANAGER_ROLES } from "@/lib/warehouse-stock-access"

/**
 * Super Admin sets, adds to or takes from one warehouse's on-hand figure for
 * one product, with a reason. One transaction writes the figure, the
 * `stock_movements` row and the audit row (`ADJUST_WAREHOUSE_STOCK`).
 * See plans/OF-STOCK-per-warehouse-stock.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole([...WAREHOUSE_STOCK_MANAGER_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const rateLimited = await withRateLimit("write", user.id)
    if (rateLimited) return rateLimited

    const parsed = warehouseStockAdjustmentSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const outcome = await db.transaction((tx) => adjustWarehouseStock(tx, {
      ...parsed.data,
      actor: { id: user.id, role: user.role, email: user.email },
    }))

    switch (outcome.kind) {
      case "warehouse-not-found":
        return error("Warehouse not found", 404)
      case "product-not-found":
        return error("Product not found", 404)
      case "refused":
        return error(outcome.error, 400)
      case "adjusted":
        return NextResponse.json({
          message: "Stock updated",
          item: { onHandBefore: outcome.onHandBefore, onHandAfter: outcome.onHandAfter, movementId: outcome.movementId },
        }, { headers: NO_STORE })
    }
  } catch (caught) {
    if (isStockLedgerMissing(caught)) return error(STOCK_LEDGER_MISSING_MESSAGE, 503)
    const handled = handleError(caught, "POST /api/v1/admin/warehouse-stock/adjustments")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
