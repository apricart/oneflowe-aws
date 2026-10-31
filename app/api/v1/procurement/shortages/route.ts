import { requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { PROCUREMENT_MANAGE_ROLES } from "@/lib/procurement-access"
import { loadShortages } from "@/lib/server/procurement"
import { caughtResponse, json } from "@/lib/server/procurement-route"
import { usesWarehouseStock } from "@/lib/stock-ledger-policy"

/**
 * Where open orders need more than a warehouse's shelf holds, and what is on
 * order to cover it (Procurement, Super Admin). Read-only; no cost.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */

export async function GET() {
  try {
    const roleError = await requireApiRole([...PROCUREMENT_MANAGE_ROLES])
    if (roleError) return roleError
    return json({ items: await loadShortages(db), stockLedgerOn: usesWarehouseStock() })
  } catch (caught) {
    return caughtResponse(caught, "GET /api/v1/procurement/shortages")
  }
}
