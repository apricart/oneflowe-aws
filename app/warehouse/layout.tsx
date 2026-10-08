import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"
import { isWarehouseRole } from "@/lib/warehouse-access"

export const metadata = {
  title: "Warehouse - Apricart OneFlowe",
  description: "Picking, dispatch and delivery for assigned branches",
  icons: {
    icon: "/logo-web.png",
    shortcut: "/logo-web.png",
    apple: "/logo-web.png",
  },
}

/**
 * Server-side gate for the warehouse workspace.
 *
 * `proxy.ts` already confines a warehouse session here and keeps every other
 * role out; this layer refuses any other role before the page's client code is
 * sent, in case a route reaches it that the proxy did not match. Like the
 * Order Desk and the executive, it does not mount the admin shell, whose
 * sidebar and context call endpoints this role may not reach.
 */
export default async function WarehouseLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  const role = (pageSession.session.user as { role?: string }).role
  if (!isWarehouseRole(role)) redirect("/dashboard")

  return <SessionGuard>{children}</SessionGuard>
}
