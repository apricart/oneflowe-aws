import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { canManageWarehouse } from "@/lib/warehouse-access"

/**
 * Warehouse Team is Super Admin's alone: assigning each warehouse account the
 * branches it picks, dispatches and delivers for. `proxy.ts` sends every other
 * role home first; this refuses them again on the server, and both endpoints
 * behind the page check the role themselves.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */
export default async function WarehouseTeamLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")
  if (!canManageWarehouse((session.user as { role?: string }).role)) redirect("/dashboard")
  return children
}
