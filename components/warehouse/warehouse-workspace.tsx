"use client"

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { ClipboardList, LayoutDashboard, Package, Warehouse } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { WarehouseCatalog } from "@/components/warehouse/warehouse-catalog"
import { WarehouseNotificationBell } from "@/components/warehouse/warehouse-notification-bell"
import { WarehouseOrders } from "@/components/warehouse/warehouse-orders"
import { WAREHOUSE_LABEL } from "@/lib/warehouse-access"
import { cn } from "@/lib/utils"

const warehouseTimeline = (orderId: number) => `/api/v1/warehouse/orders/${orderId}/timeline`

type Section = "dashboard" | "orders" | "catalog"

/** Every lucide icon shares this component type. */
type LucideIcon = typeof Package

const SECTIONS: ReadonlyArray<{ key: Section; label: string; icon: LucideIcon }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "orders", label: "Orders", icon: ClipboardList },
  { key: "catalog", label: "Product Catalog", icon: Package },
]

/** Links saved before the Workload section was renamed Dashboard still open it. */
const LEGACY_SECTION_HASHES: Readonly<Record<string, Section>> = { workload: "dashboard" }

function sectionFromHash(hash: string): Section | null {
  const raw = hash.replace(/^#/, "")
  const key = LEGACY_SECTION_HASHES[raw] ?? raw
  return SECTIONS.some((section) => section.key === key) ? (key as Section) : null
}

/**
 * The warehouse's workspace: its dashboard of the workload against the
 * delivery SLA (the landing section), its order queue, and the product catalogue, view only and without prices —
 * under a header of its own, outside the admin shell, with a side menu between
 * the three. The chosen section is kept in the URL hash, so a refresh or a
 * shared link opens the same one; it never reaches the server.
 * Every call made from here is on the role's allowlist (`lib/warehouse-access.ts`).
 */
export function WarehouseWorkspace() {
  const { data: session } = useSession()
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined
  const [section, setSection] = useState<Section>("dashboard")

  useEffect(() => {
    const open = () => {
      const fromHash = sectionFromHash(window.location.hash)
      if (!fromHash) return
      setSection(fromHash)
      window.history.replaceState(null, "", `#${fromHash}`)
    }
    open()
    // A link inside the page (a notification's "Open order queue") changes the
    // hash without reloading; follow it.
    window.addEventListener("hashchange", open)
    return () => window.removeEventListener("hashchange", open)
  }, [])

  const choose = (next: Section) => {
    setSection(next)
    window.history.replaceState(null, "", `#${next}`)
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:bg-slate-900/95">
        <div className="flex h-16 items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-lime-600 text-white shadow-sm">
              <Warehouse className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</h1>
              <p className="truncate text-xs text-muted-foreground">Warehouse — picking, dispatch and delivery</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <WarehouseNotificationBell />
            <OrderPortalProfileMenu
              name={user?.fullName || user?.name || user?.email || WAREHOUSE_LABEL}
              email={user?.email}
              role={WAREHOUSE_LABEL}
            />
          </div>
        </div>
      </header>
      <div className="md:flex">
        <aside className="border-b bg-white dark:bg-slate-900 md:sticky md:top-16 md:h-[calc(100vh-4rem)] md:w-56 md:shrink-0 md:border-b-0 md:border-r">
          <nav aria-label="Warehouse" className="flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3">
            {SECTIONS.map((item) => {
              const active = item.key === section
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => choose(item.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                    active
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
                  )}
                >
                  {active && <span className="absolute bottom-2 left-0 top-2 hidden w-1 rounded-r-full bg-blue-600 dark:bg-blue-400 md:block" aria-hidden="true" />}
                  <item.icon
                    size={18}
                    aria-hidden="true"
                    className={active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500"}
                  />
                  {item.label}
                </button>
              )
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6">
          <div className="mx-auto max-w-7xl">
            {section === "dashboard" && (
              <DeliveryDashboard dashboardEndpoint="/api/v1/warehouse/workload" timelineEndpoint={warehouseTimeline} />
            )}
            {section === "orders" && <WarehouseOrders />}
            {section === "catalog" && <WarehouseCatalog />}
          </div>
        </main>
      </div>
    </div>
  )
}
