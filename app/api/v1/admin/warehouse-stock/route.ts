import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { STOCK_LEDGER_MODE } from "@/lib/stock-ledger-policy"
import {
  WAREHOUSE_STOCK_PAGE_SIZE_MAX,
  countUnassignedOpenOrders,
  listStockWarehouses,
  listWarehouseStock,
} from "@/lib/server/warehouse-stock"
import { isStockLedgerMissing, STOCK_LEDGER_MISSING_MESSAGE } from "@/lib/server/warehouse-stock-errors"
import { WAREHOUSE_STOCK_MANAGER_ROLES } from "@/lib/warehouse-stock-access"

/**
 * One Apricart warehouse's stock — on hand, reserved by open orders, and
 * available — a page of products at a time, for Super Admin.
 * See plans/OF-STOCK-per-warehouse-stock.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }
const SEARCH_MAX_LENGTH = 100

function parsePositiveInt(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback
  if (!/^\d{1,9}$/.test(value)) return null
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
    const page = parsePositiveInt(searchParams.get("page"), 1)
    const pageSize = parsePositiveInt(searchParams.get("pageSize"), 50)
    const requestedWarehouseId = parsePositiveInt(searchParams.get("warehouseId"), 0)
    const search = (searchParams.get("search") ?? "").slice(0, SEARCH_MAX_LENGTH)
    if (page === null || pageSize === null || requestedWarehouseId === null || pageSize > WAREHOUSE_STOCK_PAGE_SIZE_MAX) {
      return error("Invalid page, page size or warehouse", 400)
    }

    const warehouses = await listStockWarehouses(db)
    const warehouse = requestedWarehouseId > 0
      ? warehouses.find((candidate) => candidate.id === requestedWarehouseId)
      : warehouses.find((candidate) => candidate.status === "ACTIVE") ?? warehouses[0]
    if (requestedWarehouseId > 0 && !warehouse) return error("Warehouse not found", 404)

    const [stock, unassigned] = warehouse
      ? await Promise.all([
        listWarehouseStock(db, { warehouseId: warehouse.id, search, page, pageSize }),
        countUnassignedOpenOrders(db),
      ])
      : [{ items: [], total: 0 }, { orders: 0 }]

    return NextResponse.json({
      mode: STOCK_LEDGER_MODE,
      warehouses,
      warehouseId: warehouse?.id ?? null,
      items: stock.items,
      total: stock.total,
      page,
      pageSize,
      unassignedOpenOrders: unassigned.orders,
    }, { headers: NO_STORE })
  } catch (caught) {
    if (isStockLedgerMissing(caught)) return error(STOCK_LEDGER_MISSING_MESSAGE, 503)
    const handled = handleError(caught, "GET /api/v1/admin/warehouse-stock")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}
