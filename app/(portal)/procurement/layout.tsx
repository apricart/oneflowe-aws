import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { canReadProcurement } from "@/lib/procurement-access"

/**
 * Purchasing is Procurement's, Super Admin's, and Finance's to read.
 * `proxy.ts` sends every other role home first; this refuses them again on the
 * server, and every endpoint behind the page checks the capability itself.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */
export default async function ProcurementLayout({
  children,
}: Readonly<{
  children: ReactNode
}>) {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")
  if (!canReadProcurement((session.user as { role?: string }).role)) redirect("/dashboard")
  return children
}
