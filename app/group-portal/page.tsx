import { redirect } from "next/navigation"

import { OrderPortalLanding } from "@/components/group-portal/order-portal-landing"
import { getSharedServerSession } from "@/lib/auth"
import { GROUP_USER_ROLE } from "@/lib/server/multi-branch-scope"

/**
 * The requester's landing page.
 *
 * `proxy.ts` already sends the approver to its own area inside the portal
 * shell, so this page belongs to GROUP_ORDER_PORTAL alone. The redirect below
 * is defence in depth: if the approver ever reaches this route directly it is
 * returned to its workspace rather than shown the ordering surface.
 */
export default async function GroupPortalPage() {
  const session = await getSharedServerSession()

  if (!session?.user) redirect("/login?reason=session-expired")
  if ((session.user as { role?: string }).role === GROUP_USER_ROLE) redirect("/approvals")

  return <OrderPortalLanding />
}
