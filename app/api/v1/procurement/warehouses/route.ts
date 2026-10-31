import { requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { PROCUREMENT_READ_ROLES } from "@/lib/procurement-access"
import { caughtResponse, json } from "@/lib/server/procurement-route"
import { listStockWarehouses } from "@/lib/server/warehouse-stock"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * Apricart's warehouses for the purchasing pickers, and whether goods can be
 * received yet (receipts need per-warehouse stock). See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_READ_ROLES])
    if (roleError) return roleError
    return json({ items: await listStockWarehouses(db), stockLedgerOn: usesWarehouseStock() })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/warehouses")
  }
}
