import { Warehouse } from "lucide-react"

import { WarehouseTeamCard } from "@/components/warehouse/warehouse-team-card"

/**
 * Super Admin's warehouse page: every warehouse account and the branches it
 * serves. The role gate is the layout above.
 */
export default function WarehouseTeamPage() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Warehouse className="h-6 w-6 text-lime-600" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold">Warehouse Team</h1>
          <p className="text-sm text-muted-foreground">
            Apricart warehouse staff, and the branches whose approved orders each one picks, dispatches and delivers.
          </p>
        </div>
      </div>
      <WarehouseTeamCard />
    </div>
  )
}
