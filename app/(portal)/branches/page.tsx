"use client"

import { useEffect, useMemo, useState } from "react"
import { useBranches, useUsers } from "@/lib/hooks/use-api"
import { fetcher } from "@/lib/fetcher"
import { useAppContext } from "@/components/context/app-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import {
  Building2, Users, RefreshCcw, Search, Boxes, UserCog, Sparkles,
  ShieldCheck, ChevronLeft, ChevronRight, AlertCircle, LayoutGrid, List,
  MapPin, CalendarDays, Hash, Layers, X, Phone,
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
import { useRouter } from "next/navigation"
import { HeadOfficeCreateBranchDialog } from "@/components/organizations/head-office-create-branch-dialog"

type Branch = {
  id: number
  name: string
  code?: string | null
  status?: string | null
  adminUserId?: string | null
  createdAt?: string
  updatedAt?: string
  organizationId?: number
  province?: string | null
  city?: string | null
  address?: string | null
  costCenterId?: string | null
  groupId?: number | null
  groupName?: string | null
}

type User = {
  id: string
  firstName?: string
  lastName?: string
  email: string
  phone?: string | null
  branchId?: number | null
  role?: string
}

export default function BranchesPage() {
  const router = useRouter()
  const { organizationId, userOrgId, userRole, isInitialized, setBranchId } = useAppContext()
  const { data: branchesRes, isLoading, isValidating: isRefreshingBranches, mutate: refetchBranches } = useBranches(organizationId || undefined)
  const { data: usersRes, isValidating: isRefreshingUsers, mutate: refetchUsers } = useUsers(organizationId || undefined)

  const PAGE_SIZE = 20
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all")
  const [page, setPage] = useState(1)
  const [updatingBranchId, setUpdatingBranchId] = useState<number | null>(null)
  const [manualRefreshing, setManualRefreshing] = useState(false)
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid")
  const [viewingBranch, setViewingBranch] = useState<Branch | null>(null)

  const branches = (branchesRes?.items as Branch[] | undefined) || []
  const users = (usersRes?.items as User[] | undefined) || []

  const branchAdmins = useMemo(() => users.filter((u) => u.role === "BRANCH_ADMIN" && u.branchId), [users])
  const adminByBranch = useMemo(
    () => Object.fromEntries(branchAdmins.map((admin) => [String(admin.branchId), admin])),
    [branchAdmins],
  )

  const filteredBranches = useMemo(() => {
    const normalized = search.trim().toLowerCase()
    return branches.filter((branch) => {
      const matchesSearch =
        !normalized ||
        branch.name.toLowerCase().includes(normalized) ||
        (branch.code || "").toLowerCase().includes(normalized) ||
        (branch.costCenterId || "").toLowerCase().includes(normalized)

      const status = (branch.status || "active").toLowerCase()
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "active" ? status === "active" : status !== "active")

      return matchesSearch && matchesStatus
    })
  }, [branches, search, statusFilter])

  const totalPages = Math.max(1, Math.ceil(filteredBranches.length / PAGE_SIZE))

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter])

  useEffect(() => {
    setPage((prev) => Math.min(prev, totalPages) || 1)
  }, [totalPages])

  // Keep viewingBranch in sync when branches data refreshes
  useEffect(() => {
    if (viewingBranch) {
      const updated = branches.find((b) => b.id === viewingBranch.id)
      if (updated) setViewingBranch(updated)
    }
  }, [branches])

  const paginatedBranches = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredBranches.slice(start, start + PAGE_SIZE)
  }, [filteredBranches, page])

  const totalBranches = branches.length
  const activeBranches = branches.filter((b) => (b.status || "active").toLowerCase() === "active").length
  const inactiveBranches = totalBranches - activeBranches

  const isRefreshing = manualRefreshing || isRefreshingBranches || isRefreshingUsers

  const handleRefresh = async () => {
    const addRefreshParam = (url: string) => {
      const separator = url.includes("?") ? "&" : "?"
      return `${url}${separator}refresh=${Date.now()}`
    }

    const branchUrl = `/api/v1/branches${organizationId ? `?organizationId=${organizationId}` : ""}`
    const usersUrl = `/api/v1/users${organizationId ? `?organizationId=${organizationId}` : ""}`

    setManualRefreshing(true)
    try {
      const [freshBranches, freshUsers] = await Promise.all([
        fetcher<{ items: Branch[] }>(addRefreshParam(branchUrl)),
        fetcher<{ items: User[] }>(addRefreshParam(usersUrl)),
      ])

      await Promise.all([
        refetchBranches(freshBranches, { revalidate: false }),
        refetchUsers(freshUsers, { revalidate: false }),
      ])
    } catch (error) {
      console.error("Failed to refresh branches page data", error)
    } finally {
      setManualRefreshing(false)
    }
  }

  const handleStatusToggle = async (branchId: number, currentStatus?: string | null) => {
    const nextStatus = (currentStatus || "active").toLowerCase() === "active" ? "inactive" : "active"
    setUpdatingBranchId(branchId)
    try {
      const payload: Record<string, any> = { status: nextStatus }
      if (organizationId) {
        payload.organizationId = Number(organizationId)
      }

      const response = await fetch(`/api/v1/branches/${branchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || "Failed to update branch status")
      }
      await refetchBranches()
    } catch (error) {
      console.error("Failed to update branch status", error)
    } finally {
      setUpdatingBranchId(null)
    }
  }

  if (!isInitialized) {
    return (
      <main className="p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80" />
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, idx) => (
            <Card key={idx}>
              <CardContent className="p-6 space-y-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    )
  }

  if (userRole !== "HEAD_OFFICE") {
    return (
      <main className="p-6">
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            You need Head Office access to view the My Branches workspace.
          </CardContent>
        </Card>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] p-4 md:p-8 space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-blue-50/50 dark:border-blue-800/50 shadow-inner">
            <Building2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">My Branches</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Manage and monitor branch performance and staffing</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <HeadOfficeCreateBranchDialog
            organizationId={userOrgId}
            onCreated={() => { void refetchBranches() }}
          />
          <Badge variant="outline" className="h-8 px-3 rounded-full border-blue-200 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:border-blue-800/60 dark:text-blue-400 font-semibold uppercase tracking-wider text-[10px]">
            {totalBranches} Branches
          </Badge>
          <Button variant="outline" size="sm" onClick={() => { void handleRefresh() }} disabled={isRefreshing} className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm">
            <RefreshCcw className={cn("h-4 w-4", isRefreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total Branches" value={totalBranches} icon={<Building2 className="h-5 w-5" />} variant="blue" />
        <StatCard label="Active Branches" value={activeBranches} icon={<ShieldCheck className="h-5 w-5" />} variant="green" />
        <StatCard label="Needs Attention" value={inactiveBranches} icon={<AlertCircle className="h-5 w-5" />} variant="red" />
      </div>

      <Card className="border-none shadow-[0_15px_60px_rgb(0,0,0,0.05)] dark:shadow-[0_15px_60px_rgb(0,0,0,0.3)] bg-white/80 dark:bg-[#050b1a]/80 backdrop-blur-xl rounded-[2.5rem] overflow-hidden">
        <CardHeader className="p-6 border-b border-slate-100 dark:border-slate-800/50">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div>
              <CardTitle className="text-xl font-bold text-slate-900 dark:text-white">Branch Directory</CardTitle>
              <p className="text-sm text-muted-foreground">Click any branch to view full details.</p>
            </div>
            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="relative group w-full lg:w-64">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
                <Input
                  placeholder="Search branches or cost centers..."
                  className="pl-9 h-10 bg-slate-100/50 dark:bg-slate-900/50 border-transparent focus:bg-white dark:focus:bg-slate-900 transition-all rounded-xl"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={(value: "all" | "active" | "inactive") => setStatusFilter(value)}>
                <SelectTrigger className="h-10 w-full sm:w-40 rounded-xl border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-slate-200 dark:border-slate-800">
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>

              {/* View Mode Toggle */}
              <div className="flex bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1 shadow-sm shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewMode("table")}
                  className={cn("h-8 px-3 rounded-md transition-all", viewMode === "table" ? "bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-300")}
                >
                  <List className="h-4 w-4 mr-2" />
                  Table
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setViewMode("grid")}
                  className={cn("h-8 px-3 rounded-md transition-all", viewMode === "grid" ? "bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-300")}
                >
                  <LayoutGrid className="h-4 w-4 mr-2" />
                  Grid
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-6">
          {isLoading && (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton key={idx} className="h-48 w-full rounded-2xl" />
              ))}
            </div>
          )}

          {!isLoading && (
            <>
              {filteredBranches.length > 0 && (
                <div className="flex flex-col pb-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Showing{" "}
                    <span className="font-medium text-foreground">
                      {(page - 1) * PAGE_SIZE + 1}–{Math.min(filteredBranches.length, page * PAGE_SIZE)}
                    </span>{" "}
                    of <span className="font-medium text-foreground">{filteredBranches.length}</span> branches
                  </span>
                  <div className="inline-flex items-center gap-2 mt-2 sm:mt-0">
                    <Button variant="outline" size="sm" className="gap-1" disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                      <ChevronLeft className="h-4 w-4" />
                      Prev
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page <span className="font-medium text-foreground">{page}</span> / {totalPages}
                    </span>
                    <Button variant="outline" size="sm" className="gap-1" disabled={page === totalPages || filteredBranches.length === 0} onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}>
                      Next
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}

              <AnimatePresence mode="wait">
                {viewMode === "grid" ? (
                  <motion.div
                    key="grid-view"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                  >
                    {filteredBranches.length === 0 ? (
                      <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                        No branches match your filters.
                      </div>
                    ) : (
                      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
                        {paginatedBranches.map((branch, idx) => {
                          const admin = adminByBranch[String(branch.id)]
                          const isActive = (branch.status || "active").toLowerCase() === "active"
                          const isUpdatingThisBranch = updatingBranchId === branch.id
                          return (
                            <motion.div
                              key={branch.id}
                              initial={{ opacity: 0, scale: 0.95 }}
                              animate={{ opacity: 1, scale: 1 }}
                              transition={{ duration: 0.2, delay: idx * 0.04 }}
                              onClick={() => setViewingBranch(branch)}
                              className="group relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2rem] p-6 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 overflow-hidden cursor-pointer"
                            >
                              <div className={cn(
                                "absolute top-0 right-0 w-32 h-32 blur-3xl rounded-full opacity-10 -translate-y-1/2 translate-x-1/2 transition-opacity group-hover:opacity-20",
                                isActive ? "bg-emerald-500" : "bg-slate-500"
                              )} />

                              <div className="flex justify-between items-start mb-6 relative z-10">
                                <div className="space-y-1">
                                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Branch Name</p>
                                  <h3 className="text-xl font-black text-slate-800 dark:text-slate-100 tracking-tight">{branch.name}</h3>
                                </div>
                                <Badge className={cn(
                                  "rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                                  isActive
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"
                                    : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                                )}>
                                  {isActive ? "Active" : "Inactive"}
                                </Badge>
                              </div>

                              <div className="grid grid-cols-2 gap-4 mb-6 relative z-10">
                                <div className="space-y-1">
                                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                    <Boxes className="h-3 w-3 text-blue-500" /> Code
                                  </p>
                                  <p className="font-mono text-sm font-bold text-slate-700 dark:text-slate-300">{branch.code || "—"}</p>
                                </div>
                                <div className="space-y-1">
                                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                    <Sparkles className="h-3 w-3 text-amber-500" /> Created
                                  </p>
                                  <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                                    {branch.createdAt ? new Date(branch.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—"}
                                  </p>
                                </div>
                              </div>

                              <div className="relative z-10 bg-slate-50/80 dark:bg-slate-800/50 backdrop-blur-sm border border-slate-100 dark:border-slate-700/50 p-4 rounded-2xl mb-6">
                                <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Primary Admin</p>
                                {admin ? (
                                  <div className="flex items-center gap-3">
                                    <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-sm shadow-md shadow-indigo-500/20">
                                      {admin.firstName?.[0] || admin.email[0].toUpperCase()}
                                    </div>
                                    <div className="min-w-0">
                                      <p className="font-bold text-slate-900 dark:text-white truncate text-sm">
                                        {[admin.firstName, admin.lastName].filter(Boolean).join(" ") || "Admin User"}
                                      </p>
                                      <p className="text-xs text-slate-500 truncate">{admin.email}</p>
                                      {admin.phone && (
                                        <p className="text-xs text-slate-400 truncate flex items-center gap-1 mt-0.5">
                                          <Phone className="h-3 w-3 shrink-0" />{admin.phone}
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-3 opacity-60">
                                    <div className="h-10 w-10 rounded-xl bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-400">
                                      <Users className="h-5 w-5" />
                                    </div>
                                    <p className="text-xs font-medium text-slate-500 italic">No admin assigned</p>
                                  </div>
                                )}
                              </div>

                              <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between relative z-10" onClick={(e) => e.stopPropagation()}>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-10 px-4 gap-2 rounded-xl text-xs font-bold text-slate-600 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-900/20 transition-all"
                                  onClick={() => {
                                    setBranchId(String(branch.id))
                                    router.push("/users")
                                  }}
                                >
                                  <UserCog className="h-4 w-4" />
                                  {admin ? "Manage Team" : "Assign Admin"}
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  loading={isUpdatingThisBranch}
                                  className={cn(
                                    "h-10 min-w-[112px] px-4 gap-2 rounded-xl border-slate-200 dark:border-slate-800 shadow-sm transition-all",
                                    isActive
                                      ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                                      : "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                                  )}
                                  disabled={!!updatingBranchId}
                                  onClick={() => { void handleStatusToggle(branch.id, branch.status) }}
                                >
                                  {isUpdatingThisBranch ? "Updating" : isActive ? "Deactivate" : "Activate"}
                                </Button>
                              </div>
                            </motion.div>
                          )
                        })}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="table-view"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm"
                  >
                    {filteredBranches.length === 0 ? (
                      <div className="p-10 text-center text-sm text-muted-foreground">
                        No branches match your filters.
                      </div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-slate-50/50 dark:bg-slate-800/50 hover:bg-slate-50/50">
                            <TableHead className="py-4 pl-6">Branch</TableHead>
                            <TableHead>Code</TableHead>
                            <TableHead>Cost Center</TableHead>
                            <TableHead>Primary Admin</TableHead>
                            <TableHead>Created</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right pr-6">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {paginatedBranches.map((branch, idx) => {
                            const admin = adminByBranch[String(branch.id)]
                            const isActive = (branch.status || "active").toLowerCase() === "active"
                            const isUpdatingThisBranch = updatingBranchId === branch.id
                            return (
                              <motion.tr
                                key={branch.id}
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ duration: 0.2, delay: idx * 0.03 }}
                                onClick={() => setViewingBranch(branch)}
                                className="group border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/80 dark:hover:bg-slate-800/30 transition-colors cursor-pointer"
                              >
                                <TableCell className="py-4 pl-6">
                                  <div className="flex items-center gap-3">
                                    <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center shrink-0">
                                      <Building2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                                    </div>
                                    <span className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                                      {branch.name}
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                                    {branch.code || "—"}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                                    {branch.costCenterId || "â€”"}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  {admin ? (
                                    <div className="flex items-center gap-2">
                                      <div className="h-7 w-7 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-xs shrink-0">
                                        {admin.firstName?.[0] || admin.email[0].toUpperCase()}
                                      </div>
                                      <div className="min-w-0">
                                        <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[140px]">
                                          {[admin.firstName, admin.lastName].filter(Boolean).join(" ") || "Admin User"}
                                        </p>
                                        <p className="text-xs text-slate-400 truncate max-w-[140px]">{admin.email}</p>
                                        {admin.phone && (
                                          <p className="text-xs text-slate-400 truncate max-w-[140px] flex items-center gap-1 mt-0.5">
                                            <Phone className="h-3 w-3 shrink-0" />{admin.phone}
                                          </p>
                                        )}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-xs text-slate-400 italic flex items-center gap-1.5">
                                      <Users className="h-3.5 w-3.5" /> No admin assigned
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs font-medium text-slate-500 dark:text-slate-400">
                                  {branch.createdAt
                                    ? new Date(branch.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
                                    : "—"}
                                </TableCell>
                                <TableCell>
                                  <Badge className={cn(
                                    "rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                                    isActive
                                      ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"
                                      : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                                  )}>
                                    {isActive ? "Active" : "Inactive"}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-right pr-6" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center justify-end gap-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-8 px-3 gap-1.5 rounded-lg text-xs font-bold text-slate-600 hover:text-blue-600 hover:bg-blue-50 dark:text-slate-400 dark:hover:text-blue-400 dark:hover:bg-blue-900/20 transition-all"
                                      onClick={() => {
                                        setBranchId(String(branch.id))
                                        router.push("/users")
                                      }}
                                    >
                                      <UserCog className="h-3.5 w-3.5" />
                                      {admin ? "Manage" : "Assign"}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      loading={isUpdatingThisBranch}
                                      className={cn(
                                        "h-8 px-3 rounded-lg text-xs font-bold border-slate-200 dark:border-slate-700 shadow-sm transition-all",
                                        isActive
                                          ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
                                          : "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
                                      )}
                                      disabled={!!updatingBranchId}
                                      onClick={() => { void handleStatusToggle(branch.id, branch.status) }}
                                    >
                                      {isUpdatingThisBranch ? "Updating..." : isActive ? "Deactivate" : "Activate"}
                                    </Button>
                                  </div>
                                </TableCell>
                              </motion.tr>
                            )
                          })}
                        </TableBody>
                      </Table>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          )}
        </CardContent>
      </Card>

      {/* Branch Detail Side Panel */}
      <Sheet open={!!viewingBranch} onOpenChange={(open) => !open && setViewingBranch(null)}>
        <SheetContent className="w-full sm:max-w-md border-l-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] p-0 bg-[#fdfdfd] dark:bg-[#0b0f19] overflow-y-auto">
          {viewingBranch && (() => {
            const admin = adminByBranch[String(viewingBranch.id)]
            const isActive = (viewingBranch.status || "active").toLowerCase() === "active"
            const isUpdatingThisBranch = updatingBranchId === viewingBranch.id
            const fullAddress = [viewingBranch.address, viewingBranch.city, viewingBranch.province].filter(Boolean).join(", ")

            return (
              <div className="flex flex-col h-full font-sans">
                {/* Header */}
                <div className="p-6 md:p-8 bg-gradient-to-br from-blue-50/80 to-indigo-50/50 dark:from-blue-950/20 dark:to-indigo-950/10 border-b border-blue-100/50 dark:border-blue-900/30 rounded-b-[2.5rem] relative overflow-hidden shrink-0">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-300/20 dark:bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
                  <div className="absolute bottom-0 left-0 w-40 h-40 bg-blue-300/20 dark:bg-blue-500/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />

                  <div className="flex justify-between items-start mb-6 relative z-10">
                    <div className="flex items-center gap-4">
                      <div className="h-14 w-14 rounded-[1.2rem] bg-blue-100/80 dark:bg-blue-900/40 border border-white/50 dark:border-blue-800/30 flex items-center justify-center text-blue-500 dark:text-blue-400 shadow-sm backdrop-blur-sm -rotate-3 transition-transform hover:rotate-0">
                        <Building2 className="h-7 w-7 stroke-[1.5]" />
                      </div>
                      <div>
                        <p className="text-[10px] font-bold text-blue-400/80 dark:text-blue-500 uppercase tracking-widest mb-0.5">Branch</p>
                        <h2 className="text-lg font-black text-slate-800 dark:text-slate-100 tracking-tight leading-tight">
                          {viewingBranch.name}
                        </h2>
                      </div>
                    </div>
                    <Badge className={cn(
                      "px-3 py-1 text-[9px] font-bold tracking-widest uppercase rounded-xl border-dashed shadow-sm backdrop-blur-sm",
                      isActive
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"
                        : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                    )}>
                      {isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>

                  {/* Code + Created summary card */}
                  <div className="bg-white/60 dark:bg-slate-900/40 backdrop-blur-md border border-white dark:border-slate-800 p-4 rounded-3xl shadow-[0_4px_20px_rgb(0,0,0,0.03)] grid grid-cols-2 gap-4 relative z-10">
                    <div className="space-y-1">
                      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-1">
                        <Hash className="h-3 w-3" /> Code
                      </p>
                      <p className="font-mono text-base font-black text-slate-900 dark:text-white tracking-widest">
                        {viewingBranch.code || "—"}
                      </p>
                    </div>
                    <div className="space-y-1 text-right">
                      <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center justify-end gap-1">
                        <CalendarDays className="h-3 w-3" /> Created
                      </p>
                      <p className="text-sm font-bold text-slate-700 dark:text-slate-300">
                        {viewingBranch.createdAt
                          ? new Date(viewingBranch.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Body */}
                <div className="flex-1 p-6 space-y-5">

                  {/* Location Details */}
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 pl-2">
                      <MapPin className="h-3.5 w-3.5" />
                      Location
                    </h3>
                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-5 rounded-[2rem] space-y-4">
                      {viewingBranch.province && (
                        <div className="flex items-center justify-between group">
                          <span className="text-xs font-semibold text-slate-500">Province</span>
                          <span className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-indigo-500 transition-colors">{viewingBranch.province}</span>
                        </div>
                      )}
                      {viewingBranch.city && (
                        <div className="flex items-center justify-between group">
                          <span className="text-xs font-semibold text-slate-500">City</span>
                          <span className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-indigo-500 transition-colors">{viewingBranch.city}</span>
                        </div>
                      )}
                      {viewingBranch.address && (
                        <div className="flex items-start justify-between gap-3 group">
                          <span className="text-xs font-semibold text-slate-500 shrink-0">Address</span>
                          <span className="text-sm font-medium text-slate-700 dark:text-slate-300 text-right leading-snug">{viewingBranch.address}</span>
                        </div>
                      )}
                      {!viewingBranch.province && !viewingBranch.city && !viewingBranch.address && (
                        <p className="text-xs text-slate-400 italic text-center py-1">No address information available</p>
                      )}
                    </div>
                  </div>

                  {/* Branch Info */}
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 pl-2">
                      <Building2 className="h-3.5 w-3.5" />
                      Details
                    </h3>
                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-5 rounded-[2rem] space-y-4">
                      {viewingBranch.groupName && (
                        <div className="flex items-center justify-between group">
                          <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Layers className="h-3.5 w-3.5" /> Group</span>
                          <span className="text-sm font-bold text-slate-800 dark:text-slate-200 group-hover:text-indigo-500 transition-colors">{viewingBranch.groupName}</span>
                        </div>
                      )}
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5 shrink-0"><Users className="h-3.5 w-3.5" /> Admin</span>
                        {admin ? (
                          <div className="flex items-center gap-2 text-right">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-800 dark:text-slate-200 truncate max-w-[180px]">
                                {[admin.firstName, admin.lastName].filter(Boolean).join(" ") || "Admin User"}
                              </p>
                              <p className="text-xs text-slate-400 truncate max-w-[180px]">{admin.email}</p>
                              {admin.phone && (
                                <p className="text-xs text-slate-400 truncate max-w-[180px] flex items-center gap-1 mt-0.5">
                                  <Phone className="h-3 w-3 shrink-0" />{admin.phone}
                                </p>
                              )}
                            </div>
                            <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center text-white font-bold text-xs shrink-0">
                              {admin.firstName?.[0] || admin.email[0].toUpperCase()}
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400 italic">No admin assigned</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Footer Actions */}
                <div className="p-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-t border-slate-100 dark:border-slate-800 rounded-t-[2.5rem] mt-auto shrink-0 space-y-3">
                  <Button
                    className="w-full h-12 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-600/20 gap-2"
                    onClick={() => {
                      setBranchId(String(viewingBranch.id))
                      router.push("/users")
                    }}
                  >
                    <UserCog className="h-4 w-4" />
                    {admin ? "Manage Team" : "Assign Admin"}
                  </Button>
                  <Button
                    variant="outline"
                    loading={isUpdatingThisBranch}
                    disabled={!!updatingBranchId}
                    className={cn(
                      "w-full h-12 rounded-2xl font-bold border-slate-200 dark:border-slate-700 transition-all",
                      isActive
                        ? "text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950/20 dark:border-rose-900/40"
                        : "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/20 dark:border-emerald-900/40"
                    )}
                    onClick={() => { void handleStatusToggle(viewingBranch.id, viewingBranch.status) }}
                  >
                    {isUpdatingThisBranch ? "Updating..." : isActive ? "Deactivate Branch" : "Activate Branch"}
                  </Button>
                </div>
              </div>
            )
          })()}
        </SheetContent>
      </Sheet>
    </main>
  )
}

function StatCard({ label, value, icon, variant }: {
  label: string
  value: string | number
  icon: React.ReactNode
  variant: "blue" | "green" | "red" | "amber" | "purple"
}) {
  const variants = {
    blue: "bg-gradient-to-br from-blue-50/80 to-indigo-50/80 border-blue-100/50 text-blue-700 dark:from-blue-900/20 dark:to-indigo-900/20 dark:border-blue-800/30 dark:text-blue-400",
    green: "bg-gradient-to-br from-emerald-50/80 to-teal-50/80 border-emerald-100/50 text-emerald-700 dark:from-emerald-900/20 dark:to-teal-900/20 dark:border-emerald-800/30 dark:text-emerald-400",
    red: "bg-gradient-to-br from-rose-50/80 to-red-50/80 border-rose-100/50 text-rose-700 dark:from-rose-900/20 dark:to-red-900/20 dark:border-rose-800/30 dark:text-rose-400",
    amber: "bg-gradient-to-br from-amber-50/80 to-orange-50/80 border-amber-100/50 text-amber-700 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800/30 dark:text-amber-400",
    purple: "bg-gradient-to-br from-purple-50/80 to-fuchsia-50/80 border-purple-100/50 text-purple-700 dark:from-purple-900/20 dark:to-fuchsia-900/20 dark:border-purple-800/30 dark:text-purple-400",
  }

  const iconBadge = {
    blue: "bg-white/80 text-blue-600 shadow-sm border border-blue-100 dark:bg-slate-800 dark:border-blue-800",
    green: "bg-white/80 text-emerald-600 shadow-sm border border-emerald-100 dark:bg-slate-800 dark:border-emerald-800",
    red: "bg-white/80 text-rose-600 shadow-sm border border-rose-100 dark:bg-slate-800 dark:border-rose-800",
    amber: "bg-white/80 text-amber-600 shadow-sm border border-amber-100 dark:bg-slate-800 dark:border-amber-800",
    purple: "bg-white/80 text-purple-600 shadow-sm border border-purple-100 dark:bg-slate-800 dark:border-purple-800",
  }

  return (
    <div className={cn("flex items-center justify-between p-4 rounded-2xl border shadow-sm transition-all hover:shadow-md", variants[variant])}>
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] opacity-80">{label}</p>
        <p className="text-2xl font-black tracking-tight">{value}</p>
      </div>
      <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", iconBadge[variant])}>
        {icon}
      </div>
    </div>
  )
}
