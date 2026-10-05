import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { canManageOrderDesk } from "@/lib/order-desk-access"

/**
 * Order Desk Team is Super Admin's alone: creating Apricart's order-entry
 * staff and granting each the managed organizations they may order for.
 * `proxy.ts` sends every other role home first; this refuses them again on the
 * server, and every endpoint behind the page checks the role itself.
 */
export default async function DeskTeamLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")
  if (!canManageOrderDesk((session.user as { role?: string }).role)) redirect("/dashboard")
  return children
}
