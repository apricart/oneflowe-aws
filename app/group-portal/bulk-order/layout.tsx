import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { GROUP_ORDER_PORTAL_ROLE } from "@/lib/server/multi-branch-scope"

/**
 * Server-side gate for the multi-branch ordering workspace.
 *
 * `proxy.ts` already confines each role to its own portal area, and every
 * `/api/v1/group-portal/*` endpoint independently allowlists this one role.
 * This layer exists so the page never renders for the wrong role even if it is
 * reached by a route the proxy did not match — the workspace is refused before
 * any of its client code is sent.
 *
 * GROUP_USER approves orders across its branches but does not raise them, so it
 * is redirected back to the shared group landing page rather than shown this
 * screen.
 */
export default async function GroupBulkOrderLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) redirect("/login?reason=session-expired")
  if ((session.user as { role?: string }).role !== GROUP_ORDER_PORTAL_ROLE) redirect("/group-portal")

  return children
}
