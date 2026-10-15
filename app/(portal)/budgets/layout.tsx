import { viewerReadRole } from "@/lib/viewer-access"
import type { ReactNode } from "react"
import { redirect } from "next/navigation"

import { getSharedServerSession } from "@/lib/auth"
import { canManageMoneyBudgets } from "@/lib/money-budget-access"
import { isGroupUserBudgetAllocationEnabled } from "@/lib/server/group-user-budget-allocation"

export default async function BudgetsLayout({ children }: Readonly<{ children: ReactNode }>) {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")

  const user = session.user as { id?: string; role?: string; organizationId?: number | null; branchId?: number | null }
  // An organization-wide Viewer reads the budgets read-only, as Head Office sees them.
  if (!canManageMoneyBudgets(viewerReadRole(user) ?? undefined)) redirect("/dashboard")
  if (user.role === "GROUP_USER" && !await isGroupUserBudgetAllocationEnabled(user.id, user.organizationId)) {
    redirect("/dashboard")
  }

  return children
}
