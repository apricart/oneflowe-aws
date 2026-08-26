"use client"

import { useMemo } from "react"
import useSWR from "swr"
import { Building2 } from "lucide-react"

import { useAppContext } from "@/components/context/app-context"
import {
  BranchAdminDashboard,
  type BranchDashboardScope,
} from "@/components/dashboard/branch-admin-dashboard"
import { DashboardSkeleton } from "@/components/dashboard/dashboard-skeleton"
import { fetcher } from "@/lib/fetcher"

type GroupUserScopeResponse = {
  item?: {
    branches?: { id: number }[] | null
  } | null
}

/**
 * The Group User's dashboard: the same view the Branch Admin gets, reporting on
 * the branches assigned to this user instead of a single pinned branch.
 *
 * The branch set is read from `/api/v1/group-portal/scope`, which resolves the
 * signed-in user's own group and branch assignments server-side and is closed
 * to every role that has none. The ids are sent along as a filter for cache
 * separation and for the drill-down links, but they are not what grants access:
 * each analytics endpoint re-resolves the caller's assignments itself and
 * intersects them with whatever the request asks for, so a tampered branch list
 * narrows this view and can never widen it.
 */
export function GroupUserDashboard() {
  const { organizationId, isInitialized } = useAppContext()

  const { data, isLoading } = useSWR<GroupUserScopeResponse>(
    isInitialized ? "/api/v1/group-portal/scope" : null,
    fetcher,
  )

  const assignedBranchIds = useMemo(
    () => (data?.item?.branches ?? []).map((branch) => String(branch.id)),
    [data],
  )

  const scope = useMemo<BranchDashboardScope>(
    () => ({
      organizationId,
      branchId: null,
      branchIds: assignedBranchIds,
      isReady: assignedBranchIds.length > 0,
      heading: "Branch Metrics",
    }),
    [organizationId, assignedBranchIds],
  )

  if (!isInitialized || isLoading) {
    return (
      <div className="p-6">
        <DashboardSkeleton />
      </div>
    )
  }

  // No assignments means no reach at all — never a tenant-wide view. The
  // endpoints refuse such a caller too; this simply explains why.
  if (assignedBranchIds.length === 0) {
    return (
      <div className="p-6">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-slate-200 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <Building2 className="h-6 w-6" />
          </span>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            No branches assigned
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Your account has no group or branch assignments yet, so there is
            nothing to report on. Ask an administrator to assign your scope.
          </p>
        </div>
      </div>
    )
  }

  return <BranchAdminDashboard scope={scope} />
}
