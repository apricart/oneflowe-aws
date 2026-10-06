"use client"

import { useSession } from "next-auth/react"
import { Gauge } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { DeliveryDashboard } from "@/components/delivery-dashboard/delivery-dashboard"
import { APRICART_EXECUTIVE_LABEL } from "@/lib/apricart-executive-access"

/**
 * The Apricart Executive's workspace: the delivery dashboard under a header of
 * its own. Self-contained, like the Order Desk — every call made from here is
 * on the role's allowlist (`lib/apricart-executive-access.ts`).
 */
export function ExecutiveWorkspace() {
  const { data: session } = useSession()
  const user = session?.user as { fullName?: string; name?: string; email?: string } | undefined

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:bg-slate-900/95">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
              <Gauge className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</h1>
              <p className="truncate text-xs text-muted-foreground">Delivery performance across every client</p>
            </div>
          </div>
          <OrderPortalProfileMenu
            name={user?.fullName || user?.name || user?.email || APRICART_EXECUTIVE_LABEL}
            email={user?.email}
            role={APRICART_EXECUTIVE_LABEL}
          />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <DeliveryDashboard />
      </main>
    </div>
  )
}
