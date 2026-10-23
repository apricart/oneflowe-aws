import type { ReactNode } from "react"

import { Sidebar } from "@/components/shell/sidebar"
import { Topbar } from "@/components/shell/topbar"
import { PreloadData } from "@/components/preload-data"
import { AppContextProvider } from "@/components/context/app-context"
import { OrgBranchProvider } from "@/components/context/org-branch-context"
import { Toaster } from "@/components/ui/toaster"
import { SessionGuard } from "@/components/shell/session-guard"
import { RoleRenameNotice } from "@/components/shell/role-rename-notice"
import { UnpaidInvoiceAlerts } from "@/components/payment-control/unpaid-invoice-alerts"

/**
 * The portal chrome — sidebar, topbar, and the providers the two depend on.
 *
 * Extracted from `app/(portal)/layout.tsx` because `/support` needs the same
 * chrome for the roles that have a sidebar everywhere else, and a second copy
 * of it would drift. The layouts keep their own session handling; this is the
 * frame only.
 *
 * Callers are responsible for having established a valid session first — this
 * renders `SessionGuard`, which watches an existing one, and does not itself
 * authenticate.
 */
export function PortalShell({
  children,
  preload = true,
}: Readonly<{
  children: ReactNode
  /**
   * Warm the caches the portal's data-heavy pages read. Off for areas that
   * read none of it — `/support` has no use for a prefetched order, user and
   * branch list, and firing those requests from it is waste.
   */
  preload?: boolean
}>) {
  return (
    <AppContextProvider>
      <OrgBranchProvider>
        <SessionGuard>
          <div className="min-h-svh w-full flex bg-background dark:bg-slate-950">
            {preload ? <PreloadData /> : null}
            <Sidebar />
            <div className="min-w-0 flex-1 grid grid-rows-[auto_1fr] bg-background dark:bg-slate-950">
              <Topbar />
              <main className="min-w-0 p-4 bg-background dark:bg-slate-950">
                <UnpaidInvoiceAlerts />
                {children}
              </main>
            </div>
          </div>
          <Toaster />
          <RoleRenameNotice />
        </SessionGuard>
      </OrgBranchProvider>
    </AppContextProvider>
  )
}
