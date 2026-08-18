import type { ReactNode } from "react"
import { SessionGuard } from "@/components/shell/session-guard"
import { redirect } from "next/navigation"
import { getProtectedPageSession } from "@/lib/server/page-session"
import { SessionUnavailable } from "@/components/shell/session-unavailable"

export default async function ChangePasswordLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") redirect("/login?reason=session-expired")
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  return <SessionGuard>{children}</SessionGuard>
}
