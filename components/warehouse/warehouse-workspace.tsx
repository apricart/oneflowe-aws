"use client"

import { useSession } from "next-auth/react"
import { Warehouse } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { WarehouseOrders } from "@/components/warehouse/warehouse-orders"
import { WarehouseStock } from "@/components/warehouse/warehouse-stock"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { WAREHOUSE_LABEL } from "@/lib/warehouse-access"

const warehouseTimeline = (orderId: number) => `/api/v1/warehouse/orders/${orderId}/timeline`

/**
 * The warehouse's workspace: its order queue, its workload against the
 * delivery SLA, and stock — under a header of its own, outside the admin shell.
 * Every call made from here is on the role's allowlist (`lib/warehouse-access.ts`).
 */
export function WarehouseWorkspace() {
  const { data: session } = useSession()
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:bg-slate-900/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-lime-600 text-white shadow-sm">
              <Warehouse className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</h1>
              <p className="truncate text-xs text-muted-foreground">Warehouse — picking, dispatch and delivery</p>
            </div>
          </div>
          <OrderPortalProfileMenu
            name={user?.fullName || user?.name || user?.email || WAREHOUSE_LABEL}
            email={user?.email}
            role={WAREHOUSE_LABEL}
          />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Tabs defaultValue="orders" className="space-y-6">
          <TabsList>
            <TabsTrigger value="orders">Orders</TabsTrigger>
            <TabsTrigger value="workload">Workload</TabsTrigger>
            <TabsTrigger value="stock">Stock</TabsTrigger>
          </TabsList>
          <TabsContent value="orders">
            <WarehouseOrders />
          </TabsContent>
          <TabsContent value="workload">
            <DeliveryDashboard dashboardEndpoint="/api/v1/warehouse/workload" timelineEndpoint={warehouseTimeline} />
          </TabsContent>
          <TabsContent value="stock">
            <WarehouseStock />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
