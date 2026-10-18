"use client"

import Link from "next/link"
import { Building2, Cloud, CloudOff, Layers, LifeBuoy, Loader2, Menu, ShoppingBag } from "lucide-react"

import { OrderPortalProfileMenu } from "@/components/auth/order-portal-profile-menu"
import { Button } from "@/components/ui/button"
import { formatPKR } from "@/lib/utils"

import type { DraftSaveState } from "./use-storefront-draft"

/**
 * Where the working order stands with the server, in the one place the user
 * already looks. Saving happens on a debounce, so without this the only signal
 * that work is safe would be a refresh.
 */
function DraftSaveIndicator({ state }: Readonly<{ state: DraftSaveState }>) {
  if (state === "idle") return null

  if (state === "saving") {
    return (
      <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving…
      </span>
    )
  }
  if (state === "saved") {
    return (
      <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground md:flex">
        <Cloud className="h-3 w-3" />
        Saved
      </span>
    )
  }
  return (
    <span role="status" className="hidden items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400 md:flex">
      <CloudOff className="h-3 w-3" />
      Not saved
    </span>
  )
}

/**
 * The storefront's masthead: who is ordering, what they are ordering for, and
 * the cart.
 *
 * The single-branch portal names one branch here. This one names the group and
 * how many of its locations are ticked, because that pair is what decides both
 * the catalogue below and how many orders a submission creates.
 */
export function StorefrontHeader({
  userName,
  userEmail,
  userRole,
  organizationName,
  groupName,
  locationCount,
  cartCount,
  combinedCents,
  saveState,
  cartDisabled = false,
  onOpenCart,
  onOpenMenu,
}: Readonly<{
  userName: string
  userEmail?: string | null
  userRole?: string | null
  organizationName: string
  groupName: string | null
  locationCount: number
  cartCount: number
  combinedCents: number
  saveState: DraftSaveState
  /** Set while the review screen is open, which holds edits the cart cannot show. */
  cartDisabled?: boolean
  onOpenCart: () => void
  onOpenMenu: () => void
}>) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="shrink-0 lg:hidden"
            aria-label="Open groups and locations"
            onClick={onOpenMenu}
          >
            <Menu className="h-4 w-4" />
          </Button>

          <div
            className="hidden shrink-0 rounded-xl p-2 shadow-sm sm:block"
            style={{
              background:
                "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 35%), transparent 60%), var(--color-brand-primary)",
            }}
          >
            <ShoppingBag className="h-5 w-5 text-white" />
          </div>

          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-slate-900 dark:text-white sm:text-2xl">
              Group Order Initiator Portal
            </h1>
            <div className="space-y-0.5 text-xs text-muted-foreground">
              <p className="truncate">Welcome, {userName}</p>
              <div className="flex flex-wrap items-center gap-2 opacity-75">
                <span className="flex items-center gap-1">
                  <Building2 className="h-3 w-3" />
                  {organizationName}
                </span>
                <span className="text-[10px] opacity-40">•</span>
                <span className="flex items-center gap-1">
                  <Layers className="h-3 w-3" />
                  {groupName ?? "No group selected"}
                </span>
                <span className="text-[10px] opacity-40">•</span>
                <span>
                  {locationCount} {locationCount === 1 ? "location" : "locations"}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <DraftSaveIndicator state={saveState} />

          {cartCount > 0 && (
            <div className="hidden min-w-[180px] items-center gap-3 rounded-lg bg-slate-100/80 px-3 py-2 shadow-sm dark:bg-slate-800/80 md:flex">
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                style={{
                  background:
                    "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 35%), transparent 60%), var(--color-brand-primary)",
                }}
              >
                <ShoppingBag className="h-4 w-4 text-white" />
              </div>
              <div className="text-sm">
                <p className="font-semibold text-slate-900 dark:text-white">
                  {formatPKR(combinedCents / 100)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  across {locationCount} {locationCount === 1 ? "location" : "locations"}
                </p>
              </div>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={cartDisabled}
            title={cartDisabled ? "Your cart is being reviewed below" : "Open cart"}
            onClick={onOpenCart}
          >
            <ShoppingBag className="h-4 w-4" />
            <span className="font-semibold">{cartCount}</span>
          </Button>

          <Button
            asChild
            variant="ghost"
            size="icon"
            title="Support - raise a query with Apricart"
            aria-label="Support"
          >
            <Link href="/support">
              <LifeBuoy className="h-4 w-4" />
            </Link>
          </Button>

          <OrderPortalProfileMenu name={userName} email={userEmail} role={userRole} />
        </div>
      </div>
    </header>
  )
}
