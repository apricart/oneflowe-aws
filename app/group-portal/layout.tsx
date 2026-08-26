import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"
import { GROUP_ORDER_PORTAL_ROLE } from "@/lib/server/multi-branch-scope"

export const metadata = {
  title: "Group Order Portal - Apricart OneFlowe",
  description: "Order on behalf of assigned branches",
  icons: {
    icon: '/logo-web.png',
    shortcut: '/logo-web.png',
    apple: '/logo-web.png',
  },
}

/**
 * Server-side gate for the multi-branch ordering storefront.
 *
 * `proxy.ts` already confines each role to its own portal area, and every
 * `/api/v1/group-portal/*` endpoint independently allowlists this one role.
 * This layer exists so the storefront never renders for the wrong role even if
 * it is reached by a route the proxy did not match — it is refused before any
 * of its client code is sent.
 *
 * Only the requester belongs here. GROUP_USER approves orders across its
 * branches but does not raise them, so it is returned to the admin shell along
 * with every other role. The check fails closed: an unrecognised role is turned
 * away rather than allowed through.
 *
 * Deliberately does not mount AppContextProvider. The org/branch context is
 * built around a single active branch; this portal's multi-branch context is
 * its own side menu.
 */
export default async function GroupPortalLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string }).role
  if (role !== GROUP_ORDER_PORTAL_ROLE) redirect("/dashboard")

  return <SessionGuard>{children}</SessionGuard>
}
