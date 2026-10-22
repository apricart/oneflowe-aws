import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { PortalShell } from "@/components/shell/portal-shell"
import { AppContextProvider } from "@/components/context/app-context"
import { SessionGuard } from "@/components/shell/session-guard"
import { RoleRenameNotice } from "@/components/shell/role-rename-notice"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { ApricartSupportHeader } from "@/components/support/apricart-support-header"
import { Toaster } from "@/components/ui/toaster"
import { isApricartSupportRole } from "@/lib/apricart-support-access"
import { getProtectedPageSession } from "@/lib/server/page-session"

export default async function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string } | undefined)?.role
  if (isApricartSupportRole(role)) {
    return (
      <AppContextProvider>
        <SessionGuard>
          <RoleRenameNotice />
          <div className="min-h-svh bg-background dark:bg-slate-950">
            <ApricartSupportHeader subtitle="Orders · view only" />
            <main className="min-w-0">{children}</main>
          </div>
          <Toaster />
        </SessionGuard>
      </AppContextProvider>
    )
  }

  return <PortalShell>{children}</PortalShell>
}
