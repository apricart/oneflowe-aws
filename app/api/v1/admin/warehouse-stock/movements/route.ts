import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { listStockMovements } from "@/lib/server/warehouse-stock"
import { isStockLedgerMissing, STOCK_LEDGER_MISSING_MESSAGE } from "@/lib/server/warehouse-stock-errors"
import { WAREHOUSE_STOCK_MANAGER_ROLES } from "@/lib/warehouse-stock-access"

/**
 * The latest changes to one warehouse's figure for one product — openings,
 * Super Admin's adjustments, and orders issued at In Process — for Super Admin.
 * See plans/OF-STOCK-per-warehouse-stock.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

function parseId(value: string | null): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null
  const parsed = Number(value)
  return parsed > 0 ? parsed : null
}

export async function GET(req: Request) {
  try {
    const roleError = await requireApiRole([...WAREHOUSE_STOCK_MANAGER_ROLES])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const { searchParams } = new URL(req.url)
    const warehouseId = parseId(searchParams.get("warehouseId"))
    const globalProductId = parseId(searchParams.get("globalProductId"))
    if (warehouseId === null || globalProductId === null) return error("warehouseId and globalProductId are required", 400)

    const items = await listStockMovements(db, { warehouseId, globalProductId })
    return NextResponse.json({ items }, { headers: NO_STORE })
  } catch (caught) {
    if (isStockLedgerMissing(caught)) return error(STOCK_LEDGER_MISSING_MESSAGE, 503)
    const handled = handleError(caught, "GET /api/v1/admin/warehouse-stock/movements")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
