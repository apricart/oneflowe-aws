import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { PortalShell } from "@/components/shell/portal-shell"
import { RoleRenameNotice } from "@/components/shell/role-rename-notice"
import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { ApricartSupportHeader } from "@/components/support/apricart-support-header"
import { isApricartSupportRole } from "@/lib/apricart-support-access"
import { getProtectedPageSession } from "@/lib/server/page-session"
import { supportUsesPortalShell } from "@/lib/support-shell"

/**
 * The support area is shared by every role, so the shell is chosen per role
 * rather than fixed.
 *
 * An `ORDER_PORTAL` or `GROUP_ORDER_PORTAL` user reaching support from `/shop`
 * or `/group-portal` gets the minimal shell — they have no sidebar anywhere
 * else and must not find themselves inside the administrator's navigation, the
 * same arrangement `/invoices` has for the same reason. Everyone the sidebar
 * already builds a menu for keeps that menu here, so clicking *Support* does
 * not strip the navigation out from under them.
 *
 * `lib/support-shell.ts` states the rule; this reads the role from the session
 * and nowhere else. It is presentation either way — what a caller may read is
 * decided by the endpoints behind the page.
 */
export const metadata = {
  title: "Support - Apricart OneFlowe",
  description: "Raise a query with the Apricart team",
}

export default async function SupportLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string } | undefined)?.role

  if (supportUsesPortalShell(role)) {
    // No prefetch: support reads none of the portal's cached order, user or
    // branch lists.
    return <PortalShell preload={false}>{children}</PortalShell>
  }

  // Support is an Apricart Support agent's whole workspace. It does not mount
  // the admin shell, whose sidebar, bell and context call endpoints the agent
  // may not reach (`APRICART_SUPPORT_API_RULES`); it gets a bar with its
  // profile menu instead, so it can sign out.
  if (isApricartSupportRole(role)) {
    return (
      <SessionGuard>
        <RoleRenameNotice />
        <div className="min-h-svh bg-background dark:bg-slate-950">
          <ApricartSupportHeader />
          <main>{children}</main>
        </div>
      </SessionGuard>
    )
  }

  // The root layout already provides the session, SWR and toast providers.
  return (
    <SessionGuard>
      <main className="min-h-svh bg-background dark:bg-slate-950">{children}</main>
    </SessionGuard>
  )
}
