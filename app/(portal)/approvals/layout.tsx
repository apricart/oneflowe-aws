import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { GROUP_USER_ROLE } from "@/lib/server/multi-branch-scope"

/**
 * Server-side gate for the multi-branch approval workspace.
 *
 * `proxy.ts` already confines each role to its own areas, and every
 * `/api/v1/group-portal/approvals*` endpoint independently allowlists this one
 * role. This layer exists so the page never renders for the wrong role even if
 * it is reached by a route the proxy did not match — the workspace is refused
 * before any of its client code is sent.
 */
export default async function ApprovalsLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) redirect("/login?reason=session-expired")
  if ((session.user as { role?: string }).role !== GROUP_USER_ROLE) redirect("/dashboard")

  return children
}
