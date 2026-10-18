"use client"

import { LifeBuoy } from "lucide-react"
import { useSession } from "next-auth/react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { APRICART_SUPPORT_LABEL } from "@/lib/apricart-support-access"

/**
 * The bar above the support pages for an Apricart Support agent.
 *
 * Support is the agent's whole workspace, so there is no sidebar to return to
 * and no "back to dashboard" link to offer; this bar carries the one thing the
 * agent still needs from a shell — the profile menu, to reset a password and
 * sign out. Presentation only: what the agent may read is decided by
 * `lib/support-access.ts` on the endpoints.
 */
export function ApricartSupportHeader() {
  const { data: session } = useSession()
  const user = session?.user as { name?: string | null; fullName?: string | null; email?: string | null } | undefined

  return (
    <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
            <LifeBuoy className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</p>
            <p className="truncate text-xs text-muted-foreground">Support queue</p>
          </div>
        </div>
        <OrderPortalProfileMenu
          name={user?.fullName || user?.name || user?.email || APRICART_SUPPORT_LABEL}
          email={user?.email}
          role={APRICART_SUPPORT_LABEL}
        />
      </div>
    </header>
  )
}
