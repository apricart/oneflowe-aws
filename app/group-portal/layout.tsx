import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"

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
 * Deliberately does not mount AppContextProvider. The org/branch context is
 * built around a single active branch; the group portal's own multi-branch
 * context arrives with its dedicated view.
 */
export default async function GroupPortalLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  return <SessionGuard>{children}</SessionGuard>
}
