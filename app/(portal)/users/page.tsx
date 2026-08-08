"use client"
import { ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HeadOfficeUsersTable } from "@/components/users/head-office-users-table"
import { CreateUserDialog } from "@/components/users/create-user-dialog"
import { useAppContext } from "@/components/context/app-context"
import { Button } from "@/components/ui/button"
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton"
import { AlertCircle, RefreshCw, Users, UserPlus, Building2, UserCircle, ShoppingCart } from "lucide-react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

type CollectionResponse = {
  items: any[]
}

export default function UsersPage() {
  const { organizationId, branchId, branchIds, userRole, isInitialized } = useAppContext()
  const isContextReady = isInitialized && userRole !== null

  const {
    data: usersData,
    error: usersRequestError,
    isLoading: usersLoading,
    mutate: mutateUsers,
  } = useSWR<CollectionResponse>(
    isContextReady ? "/api/v1/users" : null,
    fetcher
  )

  const { data: branchesData } = useSWR<CollectionResponse>(
    organizationId ? `/api/v1/branches?organizationId=${organizationId}` : "/api/v1/branches",
    fetcher
  )
  const { data: organizationsData } = useSWR<CollectionResponse>(
    "/api/v1/organizations",
    fetcher
  )

  const hasValidUsersData = Array.isArray(usersData?.items)
  const hasMalformedUsersData = usersData !== undefined && !hasValidUsersData
  const hasInitialUsersError = !hasValidUsersData && (Boolean(usersRequestError) || hasMalformedUsersData)
  const isUsersReady = isContextReady && hasValidUsersData
  const isUsersPending =
    !isContextReady ||
    (!hasValidUsersData && !hasInitialUsersError && (usersLoading || usersData === undefined))

  const users = hasValidUsersData ? usersData.items : []
  const branches = Array.isArray(branchesData?.items) ? branchesData.items : []
  const organizations = Array.isArray(organizationsData?.items) ? organizationsData.items : []
  const organizationFilterId = organizationId ? parseInt(organizationId, 10) : null
  const branchFilterId = branchId ? parseInt(branchId, 10) : null
  const branchFilterIds = branchIds
    .map(id => parseInt(id, 10))
    .filter(id => Number.isFinite(id))
  const effectiveBranchFilterIds = branchFilterIds.length > 0
    ? branchFilterIds
    : branchFilterId
      ? [branchFilterId]
      : []
  const effectiveBranchFilterSet = new Set(effectiveBranchFilterIds)

  // Filter users based on role and organization
  const filteredUsers = users.filter((user: any) => {
    if (userRole === "SUPER_ADMIN") {
      if (organizationFilterId && user.organizationId !== organizationFilterId) return false
    } else if (userRole === "HEAD_OFFICE") {
      if (!organizationFilterId || user.organizationId !== organizationFilterId) return false
    } else if (userRole === "BRANCH_ADMIN") {
      if (!branchFilterId || user.branchId !== branchFilterId) return false
    } else {
      return false
    }

    if (effectiveBranchFilterSet.size > 0) {
      return user.branchId != null && effectiveBranchFilterSet.has(Number(user.branchId))
    }

    return true
  })

  // Calculate stats
  const stats = {
    total: filteredUsers.length,
    headOffice: filteredUsers.filter((u: any) => u.role === "HEAD_OFFICE").length,
    branchAdmin: filteredUsers.filter((u: any) => u.role === "BRANCH_ADMIN").length,
    orderPortal: filteredUsers.filter((u: any) => u.role === "ORDER_PORTAL").length,
  }

  return (
    <main className="min-h-[calc(100vh-4rem)] bg-slate-50/50 dark:bg-slate-950 p-4 md:p-8 space-y-6">
      {/* Compact Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-indigo-100 to-purple-100 dark:from-indigo-900/50 dark:to-purple-900/50 flex items-center justify-center border border-indigo-50/50 dark:border-indigo-800/50 shadow-inner">
            <UserCircle className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">User Management</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Global workforce directory & permissions</p>
          </div>
        </div>
        {isContextReady ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => mutateUsers()}>
              <RefreshCw className="h-4 w-4" />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <CreateUserDialog onSuccess={() => mutateUsers()} />
          </div>
        ) : (
          <div className="flex items-center gap-2" aria-hidden="true">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        )}
      </div>

      {/* Ultra-compact Colorful Light Stats */}
      {isUsersReady ? (
        <div className="grid gap-4 md:grid-cols-4">
          <CompactStatCard
            label="Total Users"
            value={stats.total}
            icon={<Users className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-indigo-50/80 to-blue-50/80 border-indigo-100/50 text-indigo-700 dark:from-indigo-900/20 dark:to-blue-900/20 dark:border-indigo-800/30 dark:text-indigo-400"
            iconBadge="bg-white/80 text-indigo-600 shadow-sm border border-indigo-100 dark:bg-slate-800 dark:border-indigo-800"
          />
          <CompactStatCard
            label="Head Office"
            value={stats.headOffice}
            icon={<Building2 className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-teal-50/80 to-emerald-50/80 border-teal-100/50 text-teal-700 dark:from-teal-900/20 dark:to-emerald-900/20 dark:border-teal-800/30 dark:text-teal-400"
            iconBadge="bg-white/80 text-teal-600 shadow-sm border border-teal-100 dark:bg-slate-800 dark:border-teal-800"
          />
          <CompactStatCard
            label="Branch Admins"
            value={stats.branchAdmin}
            icon={<UserPlus className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-fuchsia-50/80 to-purple-50/80 border-fuchsia-100/50 text-fuchsia-700 dark:from-fuchsia-900/20 dark:to-purple-900/20 dark:border-fuchsia-800/30 dark:text-fuchsia-400"
            iconBadge="bg-white/80 text-fuchsia-600 shadow-sm border border-fuchsia-100 dark:bg-slate-800 dark:border-fuchsia-800"
          />
          <CompactStatCard
            label="Order Portal"
            value={stats.orderPortal}
            icon={<ShoppingCart className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-amber-50/80 to-orange-50/80 border-amber-100/50 text-amber-700 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800/30 dark:text-amber-400"
            iconBadge="bg-white/80 text-amber-600 shadow-sm border border-amber-100 dark:bg-slate-800 dark:border-amber-800"
          />
        </div>
      ) : (
        <UsersStatsSkeleton />
      )}

      {/* Main Directory Area */}
      <div className="flex flex-col pt-2">
        {isUsersReady ? (
          <HeadOfficeUsersTable
            users={filteredUsers}
            branches={branches}
            organizations={organizations}
            userRole={userRole ?? undefined}
            onUserUpdate={() => mutateUsers()}
          />
        ) : hasInitialUsersError && isContextReady ? (
          <UsersLoadError onRetry={() => mutateUsers()} />
        ) : isUsersPending ? (
          <UsersDirectorySkeleton />
        ) : null}
      </div>
    </main>
  )
}

function UsersStatsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index} className="rounded-2xl border shadow-sm">
          <CardContent className="flex items-center justify-between p-5">
            <div className="space-y-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-10 w-16" />
            </div>
            <Skeleton className="h-12 w-12 rounded-xl" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function UsersDirectorySkeleton() {
  return (
    <Card className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <CardContent className="p-6">
        <div role="status" aria-live="polite">
          <span className="sr-only">Loading users...</span>
          <ListSkeleton rows={6} />
        </div>
      </CardContent>
    </Card>
  )
}

function UsersLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Card role="alert" className="rounded-2xl border-rose-200 bg-rose-50/60 shadow-sm dark:border-rose-900/60 dark:bg-rose-950/20">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400">
          <AlertCircle className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <CardTitle className="text-base text-slate-900 dark:text-slate-100">Unable to load users</CardTitle>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            The user directory could not be loaded. Your organization and role scope have not been changed.
          </p>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <Button variant="outline" size="sm" className="gap-2" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  )
}

function CompactStatCard({
  label,
  value,
  icon,
  gradient,
  iconBadge,
}: {
  label: string
  value: string | number
  icon: ReactNode
  gradient: string
  iconBadge: string
}) {
  return (
    <Card className={cn("border rounded-2xl shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5", gradient)}>
      <CardContent className="p-5 flex items-center justify-between">
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold opacity-80 uppercase tracking-widest">
            {label}
          </p>
          <p className="text-4xl font-black tracking-tight">
            {value}
          </p>
        </div>
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-xl", iconBadge)}>
           {icon}
        </div>
      </CardContent>
    </Card>
  )
}
