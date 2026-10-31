import { Boxes } from "lucide-react"

import { WarehouseStockManager } from "@/components/warehouse/warehouse-stock-manager"

/**
 * Super Admin's stock page: what each Apricart warehouse holds, what open
 * orders have reserved there, and changing a figure with a reason. The role
 * gate is the layout above. See plans/OF-STOCK-per-warehouse-stock.md.
 */
export default function WarehouseStockPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Boxes className="h-6 w-6 text-lime-600" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold">Warehouse Stock</h1>
          <p className="text-sm text-muted-foreground">
            Stock on hand at each Apricart warehouse, what open orders have reserved there, and what customers can still order.
          </p>
        </div>
      </div>
      <WarehouseStockManager />
    </div>
  )
}
