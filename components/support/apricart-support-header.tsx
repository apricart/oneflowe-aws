"use client"

import Link from "next/link"
import { LifeBuoy, Package } from "lucide-react"
import { useSession } from "next-auth/react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import {
  APRICART_SUPPORT_LABEL,
  isApricartSupportRole,
} from "@/lib/apricart-support-access"

/**
 * The bar above the support pages for an Apricart role that has no portal
 * shell: the Apricart Support agent, and the warehouse.
 *
 * Neither mounts the admin shell, whose sidebar, bell and context call
 * endpoints outside their allowlists; this bar carries the one thing they still
 * need from a shell — the profile menu, to reset a password and sign out. The
 * warehouse's way back to its workspace is the page header's back link
 * (`homeHrefForRole`). Presentation only: what either may read is decided by
 * `lib/support-access.ts` on the endpoints.
 */
export function ApricartSupportHeader({
  roleLabel = APRICART_SUPPORT_LABEL,
  subtitle = "Support queue",
}: Readonly<{ roleLabel?: string; subtitle?: string }> = {}) {
  const { data: session } = useSession()
  const user = session?.user as {
    name?: string | null
    fullName?: string | null
    email?: string | null
    role?: string | null
  } | undefined

  return (
    <header className="sticky top-0 z-20 border-b bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-sm">
            <LifeBuoy className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-white">Apricart OneFlowe</p>
            <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {isApricartSupportRole(user?.role) && (
          <nav aria-label="Support workspace" className="ml-auto flex items-center gap-1">
            <Link
              href="/support"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              <LifeBuoy className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Support</span>
            </Link>
            <Link
              href="/orders"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-950 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              <Package className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">Orders</span>
              <span className="hidden rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500 md:inline dark:bg-slate-800 dark:text-slate-400">
                View only
              </span>
            </Link>
          </nav>
        )}
        <OrderPortalProfileMenu
          name={user?.fullName || user?.name || user?.email || roleLabel}
          email={user?.email}
          role={roleLabel}
        />
      </div>
    </header>
  )
}
