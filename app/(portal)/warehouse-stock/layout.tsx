import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { canManageWarehouseStock } from "@/lib/warehouse-stock-access"

/**
 * Warehouse Stock is Super Admin's alone. `proxy.ts` sends every other role
 * home first; this refuses them again on the server, and every endpoint behind
 * the page checks the role itself. See plans/OF-STOCK-per-warehouse-stock.md.
 */
export default async function WarehouseStockLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")
  if (!canManageWarehouseStock((session.user as { role?: string }).role)) redirect("/dashboard")
  return children
}
