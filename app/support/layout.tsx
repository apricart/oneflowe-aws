import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { SessionGuard } from "@/components/shell/session-guard"
import { SessionUnavailable } from "@/components/shell/session-unavailable"
import { getProtectedPageSession } from "@/lib/server/page-session"

/**
 * The support area is shared by every role, so it carries its own minimal
 * shell rather than the admin sidebar — an Order Portal user reaching it from
 * `/shop` must not suddenly find themselves inside the administrator's
 * navigation. Same arrangement as `/invoices`, for the same reason.
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

  // The root layout already provides the session, SWR and toast providers.
  return (
    <SessionGuard>
      <div className="min-h-svh bg-background dark:bg-slate-950">{children}</div>
    </SessionGuard>
  )
}
