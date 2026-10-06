import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { isApricartExecutiveRole } from "@/lib/apricart-executive-access"
import { getProtectedPageSession } from "@/lib/server/page-session"

export const metadata = {
  title: "Delivery Management - Apricart OneFlowe",
  description: "Delivery performance across every client",
  icons: {
    icon: "/logo-web.png",
    shortcut: "/logo-web.png",
    apple: "/logo-web.png",
  },
}

/**
 * Server-side gate for the Apricart Executive workspace.
 *
 * `proxy.ts` already confines an executive session here and keeps every other
 * role out; this layer refuses any other role before the page's client code is
 * sent, in case a route reaches it that the proxy did not match. Like the
 * Order Desk, it does not mount the admin shell, whose sidebar and context
 * call endpoints this role may not reach.
 */
export default async function ExecutiveLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string }).role
  if (!isApricartExecutiveRole(role)) redirect("/dashboard")

  return <SessionGuard>{children}</SessionGuard>
}
