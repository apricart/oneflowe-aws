"use client"

import dynamic from "next/dynamic"
import { useSession } from "next-auth/react"
import { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton"

const SuperAdminDashboard = dynamic(
  () => import("@/components/dashboard/super-admin-dashboard").then(mod => ({ default: mod.SuperAdminDashboard })),
  { loading: () => <DashboardSkeleton /> }
)

const HeadOfficeDashboard = dynamic(
  () => import("@/components/dashboard/head-office-dashboard").then(mod => ({ default: mod.HeadOfficeDashboard })),
  { loading: () => <DashboardSkeleton /> }
)

const BranchAdminDashboard = dynamic(
  () => import("@/components/dashboard/branch-admin-dashboard").then(mod => ({ default: mod.BranchAdminDashboard })),
  { loading: () => <DashboardSkeleton /> }
)

// The approver sees the Branch Admin dashboard over the branches assigned to
// it. The wrapper resolves that set; the analytics endpoints enforce it.
const GroupUserDashboard = dynamic(
  () => import("@/components/dashboard/group-user-dashboard").then(mod => ({ default: mod.GroupUserDashboard })),
  { loading: () => <DashboardSkeleton /> }
)

export default function DashboardPage() {
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role

  if (status === "loading") {
    return (
      <div className="p-6">
        <DashboardSkeleton />
      </div>
    )
  }

  if (role === "SUPER_ADMIN") return <SuperAdminDashboard />
  if (role === "HEAD_OFFICE") return <HeadOfficeDashboard />
  if (role === "BRANCH_ADMIN") return <BranchAdminDashboard />
  if (role === "GROUP_USER") return <GroupUserDashboard />

  return (
    <div className="p-6 text-sm text-muted-foreground">
      Your session has expired. Please refresh or sign in again.
    </div>
  )
}
