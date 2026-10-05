"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import { useSWRConfig } from "swr"
import { ClipboardList, Headset, PlusCircle } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeskOrdersTable, DESK_ORDERS_KEY_PREFIX } from "@/components/order-desk/desk-orders-table"
import { NewDeskOrder } from "@/components/order-desk/new-desk-order"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ORDER_DESK_LABEL } from "@/lib/order-desk-access"

/**
 * Apricart's Order Desk: key in an order a customer sent by email or WhatsApp,
 * then follow it to fulfilment.
 *
 * Self-contained, like the group portal: it does not mount the admin shell,
 * whose sidebar and topbar call endpoints a desk session may not reach. Every
 * call made from here is on the desk's allowlist (`lib/order-desk-access.ts`)
 * and each handler re-checks the desk user's reach.
 */
export function OrderDeskWorkspace() {
  const { data: session } = useSession()
  const { mutate } = useSWRConfig()
  const [tab, setTab] = useState("new")
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined

  const showOrders = () => {
    // Anything cached from before the new order was created is stale.
    void mutate((key) => typeof key === "string" && key.startsWith(DESK_ORDERS_KEY_PREFIX))
    setTab("orders")
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:bg-slate-900/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
              <Headset className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-white">Order Desk</h1>
              <p className="truncate text-xs text-muted-foreground">
                Enter orders customers send by email or WhatsApp, then fulfil them once delivered
              </p>
            </div>
          </div>
          <OrderPortalProfileMenu
            name={user?.fullName || user?.name || user?.email || "Order Desk"}
            email={user?.email}
            role={ORDER_DESK_LABEL}
          />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        <Tabs value={tab} onValueChange={setTab} className="gap-6">
          <TabsList className="h-auto w-full justify-start gap-1 rounded-lg bg-white p-1 shadow-sm ring-1 ring-slate-200 sm:w-auto dark:bg-slate-900 dark:ring-slate-800">
            <TabsTrigger
              value="new"
              className="gap-2 px-4 py-2 data-[state=active]:bg-indigo-600 data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <PlusCircle className="h-4 w-4" aria-hidden="true" /> New order
            </TabsTrigger>
            <TabsTrigger
              value="orders"
              className="gap-2 px-4 py-2 data-[state=active]:bg-indigo-600 data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <ClipboardList className="h-4 w-4" aria-hidden="true" /> Orders
            </TabsTrigger>
          </TabsList>
          <TabsContent value="new">
            <NewDeskOrder onViewOrders={showOrders} />
          </TabsContent>
          <TabsContent value="orders">
            <DeskOrdersTable />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
