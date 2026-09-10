import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { PortalShell } from "@/components/shell/portal-shell"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"

export default async function PortalLayout({ children }: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  return <PortalShell>{children}</PortalShell>
}
