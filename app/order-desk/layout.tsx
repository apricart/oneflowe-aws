import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { isOrderDeskRole } from "@/lib/order-desk-access"
import { getProtectedPageSession } from "@/lib/server/page-session"

export const metadata = {
  title: "Order Desk - Apricart OneFlowe",
  description: "Enter and fulfil orders received by email or WhatsApp",
  icons: {
    icon: "/logo-web.png",
    shortcut: "/logo-web.png",
    apple: "/logo-web.png",
  },
}

/**
 * Server-side gate for Apricart's Order Desk workspace.
 *
 * `proxy.ts` already confines a desk session here and keeps every other role
 * out; this layer refuses any other role before the workspace's client code is
 * sent, in case a route reaches it that the proxy did not match. It fails
 * closed: an unrecognised role is turned away. Like the group portal, it does
 * not mount the admin shell or its context providers.
 */
export default async function OrderDeskLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string }).role
  if (!isOrderDeskRole(role)) redirect("/dashboard")

  return <SessionGuard>{children}</SessionGuard>
}
