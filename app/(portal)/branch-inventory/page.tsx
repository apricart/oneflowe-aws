"use client"

import { useMemo, useState, type ReactNode } from "react"
import useSWR from "swr"
import { motion, AnimatePresence } from "framer-motion"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useAppContext } from "@/components/context/app-context"
import { useSession } from "next-auth/react"
import { Role } from "@/lib/rbac"
import { formatPKR, cn } from "@/lib/utils"
import {
  Search,
  Package,
  Box,
  LayoutGrid,
  Filter,
  RefreshCw,
  ChevronRight,
  Info,
  CheckCircle2,
  XCircle
} from "lucide-react"
import { Button } from "@/components/ui/button"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type BranchInventoryItem = {
  id: number
  productName: string
  productCode: string
  productImageUrl?: string
  customName?: string
  customPrice?: number | null
  customDescription?: string
  customImageUrl?: string
  categoryName: string
  parentCategoryName?: string
  basePrice: number | null
  unit: string
  isVisible: boolean
  isActive: boolean
  stockQuantity: number
  reorderThreshold: number
  assignedAt: string
}

type InventoryScope = {
  role: Role
  userBranchId: string | number | null | undefined
  userOrganizationId: string | number | null | undefined
  branchId: string | number | null | undefined
  organizationId: string | number | null | undefined
}

const addInventoryScope = (params: URLSearchParams, scope: InventoryScope) => {
  const isBranchAdmin = scope.role === "BRANCH_ADMIN"
  const organizationId = isBranchAdmin ? scope.userOrganizationId : scope.organizationId
  const branchId = isBranchAdmin ? scope.userBranchId || scope.branchId : scope.branchId
  if (organizationId) params.set("organizationId", String(organizationId))
  if (branchId) params.set("branchId", String(branchId))
}

const buildInventoryParams = (
  scope: InventoryScope,
  filters?: { search: string; category: string; subcategory: string },
) => {
  const params = new URLSearchParams()
  if (filters) {
    params.set("search", filters.search)
    if (filters.category !== "all") params.set("category", filters.category)
    if (filters.subcategory !== "all") params.set("subCategory", filters.subcategory)
  } else {
    params.set("limit", "5000")
  }
  addInventoryScope(params, scope)
  return params
}

export default function BranchInventoryPage() {
  const { data: session } = useSession()
  const role = (session?.user as any)?.role as Role
  const userBranchId = (session?.user as any)?.branchId
  const userOrgId = (session?.user as any)?.organizationId

  const { branchId, organizationId, isInitialized } = useAppContext()
  const [searchQuery, setSearchQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [subCategoryFilter, setSubCategoryFilter] = useState("all")

  const scope = { role, userBranchId, userOrganizationId: userOrgId, branchId, organizationId }
  const params = buildInventoryParams(scope, {
    search: searchQuery,
    category: categoryFilter,
    subcategory: subCategoryFilter,
  })
  const statsParams = buildInventoryParams(scope)

  // No fallbackData on these: zero-filled fallback made the stat cards flash
  // "0" before the real numbers arrived. Fetching is deferred until the
  // org/branch context has hydrated to avoid an unscoped first request.
  const { data, isLoading, mutate } = useSWR<{
    items: BranchInventoryItem[]
    total: number
    pricesHidden?: boolean
  }>(isInitialized ? `/api/v1/branch/inventory?${params.toString()}` : null, fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  })

  const { data: statsData, mutate: mutateStats } = useSWR<{
    items: BranchInventoryItem[]
    total: number
  }>(isInitialized ? `/api/v1/branch/inventory?${statsParams.toString()}` : null, fetcher, {
    refreshInterval: 5000,
    keepPreviousData: true,
  })

  const inventory = data?.items ?? []
  const pricesHidden = Boolean(data?.pricesHidden)
  const totalProducts = data?.total ?? 0
  const statsInventory = statsData?.items ?? []
  const totalAssigned = statsData?.total ?? statsInventory.length
  const activeCount = useMemo(() => statsInventory.filter((item) => item.isActive).length, [statsInventory])
  const inactiveCount = Math.max(totalAssigned - activeCount, 0)

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 lg:p-6 space-y-6 max-w-[2000px] mx-auto overflow-x-hidden"
    >
      {/* ━━━ Premium Header ━━━ */}
      <div className="relative z-30 flex flex-col md:flex-row md:items-center justify-between gap-6 mb-2">
        <div className="space-y-1 px-2">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Box className="w-5 h-5 text-indigo-500" />
            </div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Assigned Inventory</h1>
          </div>
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Direct SKUs from Head Office for your branch</p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setSearchQuery("")
              setCategoryFilter("all")
              setSubCategoryFilter("all")
              void mutate()
              void mutateStats()
            }}
            className="h-10 px-4 rounded-xl border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shadow-sm gap-2 text-xs font-bold uppercase tracking-wider"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh Data
          </Button>
        </div>
      </div>

      {/* ━━━ KPI Stats ━━━ */}
      <div className="relative z-10 grid gap-4 md:grid-cols-3 mb-8">
        <StatCard
          label="Assigned Products"
          value={totalAssigned}
          icon={<Package className="h-5 w-5" />}
          variant="blue"
          isLoading={!statsData}
        />
        <StatCard
          label="Active SKUs"
          value={activeCount}
          icon={<CheckCircle2 className="h-5 w-5" />}
          variant="green"
          isLoading={!statsData}
        />
        <StatCard
          label="Inactive SKUs"
          value={inactiveCount}
          icon={<XCircle className="h-5 w-5" />}
          variant="red"
          isLoading={!statsData}
        />
      </div>

      {/* ━━━ Inventory Management Table ━━━ */}
      <Card className="border border-slate-200/80 dark:border-slate-800/60 shadow-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl overflow-hidden glass-card rounded-[2rem]">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-800/20">
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <LayoutGrid className="w-5 h-5 text-indigo-500" />
              <h3 className="text-lg font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">Branch Catalog</h3>
            </div>

            <div className="flex w-full flex-col gap-3 md:flex-row md:flex-wrap md:items-center lg:flex-nowrap">
              <div className="relative group w-full md:min-w-[320px] md:max-w-md md:flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                <Input
                  placeholder="Search products or SKU..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full h-11 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm font-medium"
                />
              </div>

              <CategoryFilter value={categoryFilter} onChange={(val) => { setCategoryFilter(val); setSubCategoryFilter('all'); }} />
              <SubcategoryFilter categoryId={categoryFilter} value={subCategoryFilter} onChange={setSubCategoryFilter} />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-transparent">
                <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Product Info</TableHead>
                <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Category Path</TableHead>
                {!pricesHidden && <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Pricing</TableHead>}
                <TableHead className="px-6 py-4 text-center text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Stock Status</TableHead>
                {/* <TableHead className="px-6 py-4 text-right text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Action</TableHead> */}
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence mode="popLayout">
                {(() => {
                  if (isLoading) {
                    return (
                  <TableRow>
                    <TableCell colSpan={pricesHidden ? 4 : 5} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center gap-3 animate-pulse">
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
                          <RefreshCw className="h-10 w-10 text-slate-300 dark:text-slate-600 animate-spin" />
                        </div>
                        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">Loading Catalog...</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )
                  }
                  if (inventory.length === 0) {
                    return (
                  <TableRow>
                    <TableCell colSpan={pricesHidden ? 4 : 5} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center gap-3">
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
                          <Package className="h-10 w-10 text-slate-300 dark:text-slate-600" />
                        </div>
                        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">No assigned products found</p>
                      </div>
                    </TableCell>
                  </TableRow>
                )
                  }
                  return (
                  inventory.map((item, idx) => (
                    <motion.tr
                      key={item.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.02 }}
                      className="group border-b border-slate-50 dark:border-slate-800/30 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <TableCell className="px-6 py-4">
                        <div className="flex items-center gap-4">
                          <div className="relative h-14 w-14 shrink-0 group-hover:scale-110 transition-transform duration-300">
                            {item.customImageUrl || item.productImageUrl ? (
                              <div className="h-full w-full overflow-hidden rounded-2xl border border-slate-200 shadow-sm dark:border-slate-800">
                                <img
                                  src={item.customImageUrl || item.productImageUrl}
                                  alt={item.productName}
                                  className="h-full w-full object-cover"
                                />
                              </div>
                            ) : (
                              <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-800">
                                <Package className="w-6 h-6 text-slate-300 dark:text-slate-500" />
                              </div>
                            )}
                            <div className={cn(
                              "absolute -top-1 -right-1 w-4 h-4 rounded-full border-2 border-white dark:border-slate-900",
                              item.isVisible ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : "bg-slate-300 dark:bg-slate-600"
                            )} />
                          </div>
                          <div>
                            <div className="font-black text-slate-900 dark:text-white text-sm tracking-tight leading-tight mb-0.5">
                              {item.customName || item.productName}
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[9px] font-black uppercase px-1.5 py-0 border-slate-200 dark:border-slate-700 text-slate-500">
                                {item.productCode}
                              </Badge>
                              <span className="text-[10px] font-bold text-slate-400 uppercase">{item.unit}</span>
                            </div>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="px-6 py-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">{item.parentCategoryName || "Global"}</span>
                            <ChevronRight className="h-3 w-3 text-slate-400" />
                            <span className="text-xs font-bold text-indigo-500 uppercase tracking-wider">{item.categoryName}</span>
                          </div>
                        </div>
                      </TableCell>

                      {!pricesHidden && <TableCell className="px-6 py-4">
                        <div className="space-y-0.5">
                          <div className="text-sm font-black text-indigo-600 dark:text-indigo-400 tracking-tight">
                            {item.customPrice !== null || item.basePrice !== null
                              ? formatPKR(((item.customPrice ?? item.basePrice) || 0) / 100, { maximumFractionDigits: 0 })
                              : "-"}
                          </div>
                        </div>
                      </TableCell>}

                      <TableCell className="px-6 py-4">
                        <div className="flex justify-center">
                          <div className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-full border shadow-sm transition-all duration-300",
                            (() => {
                              if (item.stockQuantity > item.reorderThreshold) {
                                return "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 ring-4 ring-emerald-500/5"
                              }
                              if (item.stockQuantity > 0) {
                                return "bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400 ring-4 ring-amber-500/5"
                              }
                              return "bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400 ring-4 ring-rose-500/5"
                            })()
                          )}>
                            <div className={cn(
                              "w-1.5 h-1.5 rounded-full animate-pulse",
                              (() => {
                                if (item.stockQuantity > item.reorderThreshold) {
                                  return "bg-emerald-500"
                                }
                                if (item.stockQuantity > 0) {
                                  return "bg-amber-500"
                                }
                                return "bg-rose-500"
                              })()
                            )} />
                            <span className="text-[10px] font-black uppercase tracking-widest">
                              {item.stockQuantity > 0 ? `${item.stockQuantity} in Stock` : "Stock Out"}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      {/* <TableCell className="px-6 py-4 text-right">
                        <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-indigo-500 transition-all">
                          <ChevronRight className="h-5 w-5" />
                        </Button>
                      </TableCell> */}
                    </motion.tr>
                  ))
                )
                })()}
              </AnimatePresence>
            </TableBody>
          </Table>
        </div>

        <div className="p-6 border-t border-slate-100 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-800/10">
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            <Info className="w-3.5 h-3.5 text-indigo-500" />
            Showing {inventory.length} of {totalProducts} assigned products
          </div>
        </div>
      </Card>
    </motion.main>
  )
}

function StatCard({
  label,
  value,
  icon,
  variant,
  isLoading = false
}: Readonly<{
  label: string
  value: string | number
  icon: ReactNode
  variant: "blue" | "green" | "red" | "amber" | "purple"
  isLoading?: boolean
}>) {
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
        {isLoading ? (
          <div className="h-8 w-16 rounded-md bg-slate-300/40 dark:bg-slate-600/40 animate-pulse" />
        ) : (
          <p className="text-2xl font-black tracking-tight">{value}</p>
        )}
      </div>
      <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", iconBadge[variant])}>
        {icon}
      </div>
    </div>
  )
}

const CategoryFilter = ({ value, onChange }: { value: string, onChange: (val: string) => void }) => {
  const { data } = useSWR<{ items: { id: number, name: string }[] }>('/api/v1/categories?limit=100', fetcher)
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-11 w-full rounded-xl border-slate-200 bg-white pl-3 pr-3 text-[10px] font-black uppercase tracking-wider shadow-sm transition-all focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-800 dark:bg-slate-900 md:w-56 md:shrink-0 lg:w-48">
        <div className="flex min-w-0 items-center gap-2">
          <Filter className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
          <SelectValue placeholder="All Categories" />
        </div>
      </SelectTrigger>
      <SelectContent className="max-h-72 rounded-2xl border-slate-200 bg-white p-1.5 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <SelectItem value="all" className="rounded-xl py-2 text-[11px] font-black uppercase tracking-wider">
          All Categories
        </SelectItem>
        {data?.items?.map((cat) => (
          <SelectItem key={cat.id} value={cat.id.toString()} className="rounded-xl py-2 text-[11px] font-bold uppercase tracking-wider">
            {cat.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const SubcategoryFilter = ({ categoryId, value, onChange }: { categoryId: string, value: string, onChange: (val: string) => void }) => {
  const query = categoryId !== 'all'
    ? `/api/v1/subcategories?categoryId=${categoryId}&limit=100`
    : '/api/v1/subcategories?limit=100'
  const { data } = useSWR<{ items: { id: number, name: string }[] }>(query, fetcher)

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-11 w-full rounded-xl border-slate-200 bg-white pl-3 pr-3 text-[10px] font-black uppercase tracking-wider shadow-sm transition-all focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-800 dark:bg-slate-900 md:w-60 md:shrink-0 lg:w-56">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
          <SelectValue placeholder="All Subcategories" />
        </div>
      </SelectTrigger>
      <SelectContent className="max-h-72 rounded-2xl border-slate-200 bg-white p-1.5 shadow-2xl dark:border-slate-800 dark:bg-slate-900">
        <SelectItem value="all" className="rounded-xl py-2 text-[11px] font-black uppercase tracking-wider">
          All Subcategories
        </SelectItem>
        {data?.items?.map((cat) => (
          <SelectItem key={cat.id} value={cat.id.toString()} className="rounded-xl py-2 text-[11px] font-bold uppercase tracking-wider">
            {cat.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
