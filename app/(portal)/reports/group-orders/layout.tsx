import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { GROUP_USER_ROLE } from "@/lib/server/multi-branch-scope"

/**
 * Server-side gate for the group order report.
 *
 * The report reads the multi-branch approver's own scope, so it belongs to that
 * role alone — every other role keeps the reports it already had, unchanged.
 * `/api/v1/group-portal/reports/group-orders` allowlists the same single role
 * independently; this layer exists so the page never renders for the wrong role
 * even if it is reached by a route the proxy did not match.
 */
export default async function GroupOrderReportLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()

  if (!session?.user) redirect("/login?reason=session-expired")
  if ((session.user as { role?: string }).role !== GROUP_USER_ROLE) redirect("/reports")

  return children
}
