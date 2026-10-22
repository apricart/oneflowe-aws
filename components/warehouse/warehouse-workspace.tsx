"use client"

import { useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { useSession } from "next-auth/react"
import { ChevronDown, ChevronUp, ClipboardList, LayoutDashboard, Package, Warehouse } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { WarehouseGroupProducts } from "@/components/warehouse/catalog/warehouse-group-products"
import { WarehouseOrganizationProducts } from "@/components/warehouse/catalog/warehouse-organization-products"
import { WarehouseProductRequests } from "@/components/warehouse/catalog/warehouse-product-requests"
import { WarehouseTaxonomy } from "@/components/warehouse/catalog/warehouse-taxonomy"
import { WarehouseCatalog } from "@/components/warehouse/warehouse-catalog"
import { WarehouseNotificationBell } from "@/components/warehouse/warehouse-notification-bell"
import { WarehouseOrders } from "@/components/warehouse/warehouse-orders"
import { WarehouseSupportLink } from "@/components/warehouse/warehouse-support-link"
import { WAREHOUSE_LABEL } from "@/lib/warehouse-access"
import { cn } from "@/lib/utils"

const ProductPriceHistoryView = dynamic(() => import("@/components/inventory/product-price-history-view"), { ssr: false })

const warehouseTimeline = (orderId: number) => `/api/v1/warehouse/orders/${orderId}/timeline`

/** Every lucide icon shares this component type. */
type LucideIcon = typeof Package

/**
 * The Product Catalog submenu, in Super Admin's order and with its labels
 * (`components/shell/sidebar.tsx`). Every view is read-only.
 * `catalog` keeps its old key, so a saved `#catalog` link opens Global Products.
 */
export const CATALOG_SECTIONS = [
  { key: "catalog", label: "Global Products" },
  { key: "catalog-price-history", label: "Product Price History" },
  { key: "catalog-organization-products", label: "Organization Products" },
  { key: "catalog-group-products", label: "Group Products" },
  { key: "catalog-categories", label: "Categories" },
  { key: "catalog-subcategories", label: "Subcategories" },
  { key: "catalog-product-requests", label: "Product Requests" },
] as const

type CatalogSection = (typeof CATALOG_SECTIONS)[number]["key"]
type Section = "dashboard" | "orders" | CatalogSection

const TOP_SECTIONS: ReadonlyArray<{ key: Exclude<Section, CatalogSection>; label: string; icon: LucideIcon }> = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "orders", label: "Orders", icon: ClipboardList },
]

const ALL_SECTION_KEYS: readonly string[] = [...TOP_SECTIONS.map((section) => section.key), ...CATALOG_SECTIONS.map((section) => section.key)]

/** Links saved before the Workload section was renamed Dashboard still open it. */
const LEGACY_SECTION_HASHES: Readonly<Record<string, Section>> = { workload: "dashboard" }

function sectionFromHash(hash: string): Section | null {
  const raw = hash.replace(/^#/, "")
  const key = LEGACY_SECTION_HASHES[raw] ?? raw
  return ALL_SECTION_KEYS.includes(key) ? (key as Section) : null
}

const isCatalogSection = (section: Section): section is CatalogSection => section === "catalog" || section.startsWith("catalog-")

function navItemClass(active: boolean) {
  return cn(
    "relative flex w-full shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
    active
      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white",
  )
}

/**
 * The warehouse's workspace: its dashboard of the workload against the
 * delivery SLA (the landing section), its order queue, and the whole product
 * catalogue — every menu Super Admin has, view only
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md) — and a link to the support
 * queue of its branches, under a header of its own,
 * outside the admin shell. The chosen section is kept in the URL hash, so a
 * refresh or a shared link opens the same one; it never reaches the server.
 * Every call made from here is on the role's allowlist (`lib/warehouse-access.ts`).
 */
export function WarehouseWorkspace() {
  const { data: session } = useSession()
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined
  const [section, setSection] = useState<Section>("dashboard")
  const [catalogOpen, setCatalogOpen] = useState(false)

  useEffect(() => {
    const open = () => {
      const fromHash = sectionFromHash(window.location.hash)
      if (!fromHash) return
      setSection(fromHash)
      if (isCatalogSection(fromHash)) setCatalogOpen(true)
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

  const catalogActive = isCatalogSection(section)

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
        <aside className="border-b bg-white dark:bg-slate-900 md:sticky md:top-16 md:h-[calc(100vh-4rem)] md:w-60 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
          <nav aria-label="Warehouse" className="flex flex-col gap-1 p-2 md:p-3">
            {TOP_SECTIONS.map((item) => {
              const active = item.key === section
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => choose(item.key)}
                  aria-current={active ? "page" : undefined}
                  className={navItemClass(active)}
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
            <button
              type="button"
              onClick={() => setCatalogOpen((current) => !current)}
              aria-expanded={catalogOpen}
              aria-controls="warehouse-catalog-menu"
              className={cn(navItemClass(false), catalogActive && "text-blue-700 dark:text-blue-300")}
            >
              <Package size={18} aria-hidden="true" className={catalogActive ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500"} />
              <span className="flex-1">Product Catalog</span>
              {catalogOpen
                ? <ChevronUp className="h-4 w-4 text-slate-400" aria-hidden="true" />
                : <ChevronDown className="h-4 w-4 text-slate-400" aria-hidden="true" />}
            </button>
            {catalogOpen && (
              <ul id="warehouse-catalog-menu" aria-label="Product Catalog" className="ml-5 space-y-0.5 border-l border-slate-200 pl-3 dark:border-slate-700">
                {CATALOG_SECTIONS.map((item) => {
                  const active = item.key === section
                  return (
                    <li key={item.key}>
                      <button
                        type="button"
                        onClick={() => choose(item.key)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                          active
                            ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800",
                        )}
                      >
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", active ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600")} aria-hidden="true" />
                        {item.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {/* The support queue of the branches it serves, in the shared support
                area (plans/OF-WAREHOUSE-support-queue.md). */}
            <WarehouseSupportLink className={navItemClass(false)} />
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6">
          <div className="mx-auto max-w-7xl">
            {section === "dashboard" && (
              <DeliveryDashboard dashboardEndpoint="/api/v1/warehouse/workload" timelineEndpoint={warehouseTimeline} warehouseOrderIdTools />
            )}
            {section === "orders" && <WarehouseOrders />}
            {section === "catalog" && <WarehouseCatalog />}
            {section === "catalog-price-history" && (
              <ProductPriceHistoryView role="WAREHOUSE" endpoint="/api/v1/warehouse/catalog/price-history" />
            )}
            {section === "catalog-organization-products" && <WarehouseOrganizationProducts />}
            {section === "catalog-group-products" && <WarehouseGroupProducts />}
            {section === "catalog-categories" && <WarehouseTaxonomy level="category" />}
            {section === "catalog-subcategories" && <WarehouseTaxonomy level="subcategory" />}
            {section === "catalog-product-requests" && <WarehouseProductRequests />}
          </div>
        </main>
      </div>
    </div>
  )
}
