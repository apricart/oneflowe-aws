import type { ReactNode } from "react"
import { redirect } from "next/navigation"
import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"

export default async function InvoiceLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const pageSession = await getProtectedPageSession()
  if (pageSession.kind === "invalid") {
    redirect("/login?reason=session-expired")
  }
  if (pageSession.kind === "unavailable") return <SessionUnavailable />

  return <SessionGuard>{children}</SessionGuard>
}
