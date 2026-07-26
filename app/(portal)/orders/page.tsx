"use client"
import React, { useState, useMemo, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { useSession } from "next-auth/react"
import { useToast } from "@/hooks/use-toast"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import {
  Package,
  Search,
  Filter,
  CheckCircle,
  Clock,
  AlertTriangle,
  TrendingDown,
  ChevronDown,
  Calendar,
  User,
  MapPin,
  DollarSign,
  RefreshCw,
  Check,
  X,
  Eye,
  XCircle,
  Activity,
} from "lucide-react"
import { formatPKR, cn } from "@/lib/utils"
import { useAppContext } from "@/components/context/app-context"
import { OrderExport } from "@/components/orders/order-export"
import { OrdersDirectory } from "@/components/orders/orders-directory"
import { ReceiptIconButton } from "@/components/receipts/receipt-icon-button"
import { GlobalDateFilter, type FilterPreset } from "@/components/dashboard/global-date-filter"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { startOfDay, endOfDay } from "date-fns"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { getOrderFulfillmentVariant, getOrderRefundVariant, type OrderSplitFilter } from "@/lib/order-status"

type DateRange = {
  startDate: Date
  endDate: Date
}
const getDefaultDateRange = (): DateRange => ({
  startDate: startOfDay(new Date()),
  endDate: endOfDay(new Date()),
})

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface OrderItem {
  id: number
  tid: string
  organizationId: number
  organizationName?: string | null
  branchId: number
  branchName?: string | null
  branchCostCenterId?: string | null
  status: string
  statusAtRefund?: string | null
  refundedAt?: string | null
  refundAmountCents?: number | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  createdAt: string
  deliveredAt?: string | null
  createdByUserId: string
  hasRefundRequests?: number
  rejectionReason?: string | null
  itemNames?: string | null
  approvalToken?: string | null
}

export default function OrdersManagementPage() {
  const router = useRouter()
  const { data: session } = useSession()
  const { toast } = useToast()
  const {
    organizationId,
    branchId,
    branchIds,
    isInitialized,
    setBranchIds: setContextBranchIds
  } = useAppContext()
  const userRole = (session?.user as any)?.role
  const isBranchAdmin = userRole === "BRANCH_ADMIN"
  const isHeadOffice = userRole === "HEAD_OFFICE"
  const isSuperAdmin = userRole === "SUPER_ADMIN"

  const [searchQuery, setSearchQuery] = useState("")
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [activePreset, setActivePreset] = useState<FilterPreset>("all")
  const [selectedMonths, setSelectedMonths] = useState<number[]>([])
  const [selectedYears, setSelectedYears] = useState<number[]>([])
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [splitFilter, setSplitFilter] = useState<OrderSplitFilter>("all")
  const [selectedOrder, setSelectedOrder] = useState<OrderItem | null>(null)
  const [showApprovalDialog, setShowApprovalDialog] = useState(false)
  const [showRejectDialog, setShowRejectDialog] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)

  // Local Hierarchical Filter State
  const [reportBranchIds, setReportBranchIds] = useState<string[]>([])
  const [reportGroupIds, setReportGroupIds] = useState<string[]>([])

  // Approval token state (shown once after approval)
  const [showTokenDialog, setShowTokenDialog] = useState(false)
  const [approvalToken, setApprovalToken] = useState<string | null>(null)

  // Fulfillment token state (Super Admin must enter to fulfill)
  const [showFulfillDialog, setShowFulfillDialog] = useState(false)
  const [fulfillToken, setFulfillToken] = useState("")

  // Error dialog state
  const [showErrorDialog, setShowErrorDialog] = useState(false)
  const [errorMessage, setErrorMessage] = useState("")


  const handleDateChange = useCallback((
    range: DateRange | null,
    preset: FilterPreset,
    _compare?: boolean,
    _compareRange?: DateRange | null,
    months: number[] = [],
    years: number[] = []
  ) => {
    setDateRange(range)
    setActivePreset(preset)
    setSelectedMonths(months)
    setSelectedYears(years)
  }, [])

  const hasActiveOrderFilters =
    reportGroupIds.length > 0 ||
    reportBranchIds.length > 0 ||
    searchQuery.length > 0 ||
    activePreset !== "all" ||
    dateRange !== null ||
    selectedMonths.length > 0 ||
    selectedYears.length > 0 ||
    statusFilter !== "all" ||
    splitFilter !== "all"

  const resetOrderFilters = useCallback(() => {
    setReportGroupIds([])
    setReportBranchIds([])
    setSearchQuery("")
    setDateRange(null)
    setActivePreset("all")
    setSelectedMonths([])
    setSelectedYears([])
    setStatusFilter("all")
    setSplitFilter("all")
  }, [])

  // ━━━ CASCADING SELECTION CLEARING ━━━
  useEffect(() => {
    setReportBranchIds([])
  }, [reportGroupIds])

  // Build orders endpoint with context parameters
  const ordersEndpoint = useMemo(() => {
    if (!isInitialized) return null
    const params = new URLSearchParams()
    if (organizationId && organizationId !== "null" && organizationId !== "0") {
      params.set("organizationId", organizationId)
    }


    // Local filters override global context if set
    // If a group is selected but no branches, we leave branchIds empty so the API filters solely by Group
    const effectiveBranchIds = reportBranchIds.length > 0
      ? reportBranchIds
      : (reportGroupIds.length > 0
        ? []
        : (branchIds.length > 0 ? branchIds : (branchId ? [branchId] : [])))

    if (effectiveBranchIds.length > 0) {
      params.set("branchIds", effectiveBranchIds.join(","))
    }

    if (reportGroupIds.length > 0) {
      params.set("groupIds", reportGroupIds.join(","))
    }

    if (dateRange) {
      params.set("startDate", dateRange.startDate.toISOString())
      params.set("endDate", dateRange.endDate.toISOString())
    }

    if (selectedMonths.length > 0) {
      params.set("months", selectedMonths.join(","))
    }

    if (selectedYears.length > 0) {
      params.set("years", selectedYears.join(","))
    }

    return `/api/v1/orders${params.toString() ? `?${params.toString()}` : ""}`
  }, [organizationId, branchId, branchIds, reportBranchIds, reportGroupIds, dateRange, selectedMonths, selectedYears, isInitialized])

  // Fetch orders scoped by context
  const { data: ordersData, mutate: mutateOrders, isLoading } = useSWR<any>(
    ordersEndpoint,
    fetcher
  )

  const orders = ordersData?.items || []
  const showSplitFilter = statusFilter === "fulfilled" || statusFilter === "refunded"

  useEffect(() => {
    if (!showSplitFilter && splitFilter !== "all") {
      setSplitFilter("all")
    }
  }, [showSplitFilter, splitFilter])

  // Filter and search orders
  const filteredOrders = useMemo(() => {
    let filtered = orders

    if (statusFilter !== "all") {
      if (statusFilter === "refunded") {
        filtered = filtered.filter((o: OrderItem) => o.status.toLowerCase() === "refunded")
      } else if (statusFilter === "fulfilled") {
        filtered = filtered.filter((o: OrderItem) => getOrderFulfillmentVariant(o) !== "none")
      } else if (statusFilter === "rejected") {
        filtered = filtered.filter((o: OrderItem) =>
          o.status.toLowerCase() === "rejected" || o.status.toLowerCase() === "cancelled"
        )
      } else {
        filtered = filtered.filter((o: OrderItem) => o.status.toLowerCase() === statusFilter)
      }
    }

    if (showSplitFilter && splitFilter !== "all") {
      filtered = filtered.filter((o: OrderItem) => {
        const variant = statusFilter === "refunded"
          ? getOrderRefundVariant(o)
          : getOrderFulfillmentVariant(o)

        return variant === splitFilter
      })
    }


    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase()
      filtered = filtered.filter((o: OrderItem) =>
        o.tid.toLowerCase().includes(lowerQuery) ||
        o.id.toString().includes(lowerQuery) ||
        (o.branchCostCenterId?.toLowerCase().includes(lowerQuery)) ||
        (o.itemNames?.toLowerCase().includes(lowerQuery))
      )
    }

    return filtered.sort((a: OrderItem, b: OrderItem) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }, [orders, searchQuery, showSplitFilter, splitFilter, statusFilter])

  // Approve order
  const handleApproveOrder = async (orderId: number) => {
    setIsProcessing(true)
    try {
      const res = await fetch("/api/v1/orders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: orderId,
          action: "approve"
        })
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || "Failed to approve order")
      }

      // Show approval token in modal (SECURITY: shown once, must be copied)
      if (data.approvalToken) {
        setApprovalToken(data.approvalToken)
        setShowTokenDialog(true)
      }

      toast({ title: "Success", description: "Order approved successfully" })
      mutateOrders()
      setShowApprovalDialog(false)
      setSelectedOrder(null)
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setIsProcessing(false)
    }
  }

  // Reject order
  const handleRejectOrder = async (orderId: number) => {
    if (!rejectReason.trim()) {
      toast({ title: "Error", description: "Please provide a rejection reason", variant: "destructive" })
      return
    }

    setIsProcessing(true)
    try {
      const res = await fetch("/api/v1/orders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: orderId,
          action: "reject",
          rejectionReason: rejectReason
        })
      })

      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || "Failed to reject order")
      }

      toast({ title: "Success", description: "Order rejected successfully" })
      mutateOrders()
      setShowRejectDialog(false)
      setSelectedOrder(null)
      setRejectReason("")
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setIsProcessing(false)
    }
  }

  // Fulfill order (requires approval token)
  const handleFulfillOrder = async (orderId: number) => {
    if (!fulfillToken.trim()) {
      setErrorMessage("Please enter the approval token to fulfill this order")
      setShowErrorDialog(true)
      return
    }

    setIsProcessing(true)
    try {
      const res = await fetch("/api/v1/orders", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: orderId,
          action: "fulfill",
          approvalToken: fulfillToken.trim().toUpperCase()
        })
      })

      const data = await res.json()

      if (!res.ok) {
        setErrorMessage(data.error || "Invalid approval token. Please verify the token and try again.")
        setShowErrorDialog(true)
        return
      }

      toast({
        title: "✅ Order Fulfilled",
        description: "The order has been successfully fulfilled",
        duration: 4000
      })
      mutateOrders()
      setSelectedOrder(null)
      setShowFulfillDialog(false)
      setFulfillToken("")
    } catch (error: any) {
      setErrorMessage(error.message || "Failed to fulfill order. Please try again.")
      setShowErrorDialog(true)
    } finally {
      setIsProcessing(false)
    }
  }

  const getStatusColor = (status: string) => {
    const colors: Record<string, { bg: string; text: string; icon: any }> = {
      pending: { bg: "bg-yellow-50 dark:bg-yellow-950", text: "text-yellow-700 dark:text-yellow-300", icon: Clock },
      approved: { bg: "bg-blue-50 dark:bg-slate-800", text: "text-blue-700 dark:text-slate-200", icon: CheckCircle },
      fulfilled: { bg: "bg-green-50 dark:bg-green-950", text: "text-green-700 dark:text-green-300", icon: CheckCircle },
      rejected: { bg: "bg-red-50 dark:bg-red-950", text: "text-red-700 dark:text-red-300", icon: AlertTriangle },
      refunded: { bg: "bg-slate-50 dark:bg-slate-950", text: "text-slate-700 dark:text-slate-300", icon: TrendingDown },
    }
    return colors[status?.toLowerCase()] || colors.pending
  }

  // Derive scope display from context + org/branch metadata
  // These hooks must be called before any conditional returns
  const { data: orgsData } = useSWR(organizationId ? "/api/v1/organizations" : null, fetcher)
  const { data: branchesData } = useSWR(
    organizationId ? `/api/v1/branches?organizationId=${organizationId}` : null,
    fetcher
  )
  const organizations = orgsData?.items || []
  const branches = branchesData?.items || []
  const selectedOrg = organizations.find((o: any) => o.id.toString() === organizationId)
  const selectedBranch = branches.find((b: any) => b.id.toString() === branchId)
  const showCostCenterId = branches.some((b: any) => Boolean(b.costCenterId)) ||
    filteredOrders.some((o: OrderItem) => Boolean(o.branchCostCenterId))

  const statusCounts = {
    all: orders.length,
    pending: orders.filter((o: OrderItem) => o.status.toLowerCase() === "pending").length,
    approved: orders.filter((o: OrderItem) => o.status.toLowerCase() === "approved").length,
    fulfilled: orders.filter((o: OrderItem) => getOrderFulfillmentVariant(o) === "full").length,
    refunded: orders.filter((o: OrderItem) => o.status.toLowerCase() === "refunded").length,
    rejected: orders.filter((o: OrderItem) => o.status.toLowerCase() === "rejected" || o.status.toLowerCase() === "cancelled").length,
  }

  const scopeText = branchId
    ? selectedBranch?.name || `Branch #${branchId}`
    : organizationId
      ? selectedOrg?.name || "Selected organization"
      : "All organizations"

  if (!isInitialized || !ordersEndpoint) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        Loading your context…
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] p-4 md:p-8 space-y-8">
      {/* ═══ MODERN COMPACT HEADER ═══ */}
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 shadow-inner">
              <Package className="h-5 w-5" />
            </span>
            Order Intelligence
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 sm:ml-[3.25rem]">
            {isBranchAdmin ? "Review orders placed from your branch's Order Portal." : `Monitor approvals and fulfillment pipelines across ${scopeText.toLowerCase()}.`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="h-8 px-3 rounded-full border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800/60 dark:text-indigo-400 font-semibold uppercase tracking-wider text-[10px]">
            {scopeText}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => mutateOrders()} className="h-8 gap-2 rounded-full border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm shadow-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            <RefreshCw className={cn("h-3.5 w-3.5 text-slate-500", isLoading && "animate-spin text-indigo-500")} />
            <span className="hidden sm:inline font-semibold text-slate-600 dark:text-slate-300">Refresh</span>
          </Button>
        </div>
      </section>

      {/* ═══ COMPACT STATS ROW ═══ */}
      <section className="grid grid-cols-2 md:grid-cols-7 gap-3 animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both">
        <CompactStatCard
          label="Total Orders"
          value={statusCounts.all}
          icon={<Package className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-indigo-50 to-blue-50/50 dark:from-indigo-950/40 dark:to-blue-900/20 border-indigo-100 dark:border-indigo-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-indigo-600 dark:text-indigo-400"
        />
        <CompactStatCard
          label="Pending Approval"
          value={statusCounts.pending}
          icon={<Clock className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-yellow-50 to-amber-50/50 dark:from-yellow-950/40 dark:to-amber-900/20 border-yellow-100 dark:border-yellow-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-yellow-600 dark:text-yellow-400"
        />
        <CompactStatCard
          label="Active"
          value={statusCounts.approved}
          icon={<CheckCircle className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-blue-50 to-cyan-50/50 dark:from-blue-950/40 dark:to-cyan-900/20 border-blue-100 dark:border-blue-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-blue-600 dark:text-blue-400"
        />
        <CompactStatCard
          label="Fulfilled"
          value={statusCounts.fulfilled}
          icon={<CheckCircle className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-emerald-50 to-teal-50/50 dark:from-emerald-950/40 dark:to-teal-900/20 border-emerald-100 dark:border-emerald-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-emerald-600 dark:text-emerald-400"
        />
        <CompactStatCard
          label="Rejected"
          value={statusCounts.rejected}
          icon={<XCircle className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-rose-50 to-pink-50/50 dark:from-rose-950/40 dark:to-pink-900/20 border-rose-100 dark:border-rose-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-rose-600 dark:text-rose-400"
        />
        <CompactStatCard
          label="Refunded"
          value={statusCounts.refunded}
          icon={<TrendingDown className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-amber-50 to-orange-50/50 dark:from-amber-950/40 dark:to-orange-900/20 border-amber-100 dark:border-amber-900/50"
          iconBadge="bg-white/60 dark:bg-slate-900/50 text-amber-600 dark:text-amber-400"
        />
      </section>

      {/* ═══ ULTRA-COMPACT UNIFIED FILTERS ═══ */}
      <section className="animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-300 fill-mode-both relative z-40">
        <Card className="border-none shadow-[0_15px_60px_rgb(0,0,0,0.05)] dark:shadow-[0_15px_60px_rgb(0,0,0,0.3)] bg-white/80 dark:bg-[#050b1a]/80 backdrop-blur-xl rounded-[2.5rem] overflow-visible">
          <div className="p-3 md:p-4 space-y-3">
            {/* Top Row: Core Tools */}
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              {/* Left Side: Search & Primary Filters */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full lg:w-auto">
                {/* Status Tabs */}
                <div className="flex items-center p-1 bg-slate-100/60 dark:bg-slate-800/50 rounded-xl border border-slate-200/50 dark:border-slate-700/50 overflow-x-auto no-scrollbar max-w-full">
                  {([
                    ["all", "All"],
                    ["pending", "Pending Approval"],
                    ["approved", "Active"],
                    ["fulfilled", "Fulfilled"],
                    ["rejected", "Rejected"],
                    ["refunded", "Refunded"],
                  ] as [string, string][]).map(([status, label]) => (
                    <Button
                      key={status}
                      onClick={() => setStatusFilter(status)}
                      variant={statusFilter === status ? "secondary" : "ghost"}
                      size="sm"
                      className={`px-3 h-8 text-xs font-bold rounded-lg transition-all duration-200 shrink-0 ${statusFilter === status
                        ? "bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-white"
                        : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                        }`}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <div className="relative group min-w-[200px] sm:min-w-[280px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-indigo-500" />
                  <Input
                    placeholder="Search by TID, ID, or cost center..."
                    className="pl-9 h-8 text-[11px] font-bold bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 rounded-xl focus:ring-1 focus:ring-indigo-500/30 transition-all shadow-sm"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>

              {/* Right Side: Environment Filters & Actions */}
              <div className="hidden lg:flex items-center    rounded-2xl  ">
                <GlobalDateFilter
                  value={dateRange}
                  onChange={handleDateChange}
                  activePreset={activePreset}
                  months={selectedMonths}
                  years={selectedYears}
                />

                <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1" />
                <OrderExport orders={filteredOrders} role={userRole} />
              </div>
            </div>

            {showSplitFilter && (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 dark:border-slate-800/50">
                <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">
                  {statusFilter === "refunded" ? "Refund Type" : "Fulfillment Type"}
                </span>
                {(["all", "partial", "full"] as OrderSplitFilter[]).map((value) => (
                  <Button
                    key={value}
                    onClick={() => setSplitFilter(value)}
                    variant={splitFilter === value ? "secondary" : "ghost"}
                    size="sm"
                    className={cn(
                      "h-7 rounded-lg px-2.5 text-[10px] font-bold capitalize",
                      splitFilter === value
                        ? "bg-slate-100 text-slate-900 dark:bg-slate-700 dark:text-white"
                        : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                    )}
                  >
                    {value}
                  </Button>
                ))}
              </div>
            )}

            {/* Bottom Row: Hierarchical Filters */}
            {((isSuperAdmin || isHeadOffice) || hasActiveOrderFilters) && (
              <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-100 dark:border-slate-800/50">
                <span className="text-[9px] uppercase font-black text-slate-400 tracking-wider flex items-center gap-1.5 ml-1">
                  <Filter className="h-3 w-3" /> Filters
                </span>

                {(isSuperAdmin || isHeadOffice) && (
                  <>
                    <GroupFilter
                      selectedIds={reportGroupIds}
                      onChange={setReportGroupIds}
                      organizationIds={organizationId ? [organizationId] : undefined}
                    />

                    <BranchFilter
                      selectedIds={reportBranchIds}
                      onChange={setReportBranchIds}
                      organizationIds={organizationId ? [organizationId] : undefined}
                      groupIds={reportGroupIds}
                    />
                  </>
                )}

                {hasActiveOrderFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetOrderFilters}
                    className="h-7 px-2 text-[9px] font-black text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 uppercase tracking-widest gap-1 rounded-lg transition-all"
                  >
                    <RefreshCw className="h-3 w-3" /> Reset Filters
                  </Button>
                )}
              </div>
            )}

          </div>

          <div className="px-1 sm:px-4 pb-4 w-full">
            <OrdersDirectory
              orders={filteredOrders}
              statusContext={showSplitFilter ? (statusFilter as "fulfilled" | "refunded") : "default"}
              userRole={userRole}
              isSuperAdmin={isSuperAdmin}
              isBranchAdmin={isBranchAdmin}
              isHeadOffice={isHeadOffice}
              showCostCenterId={showCostCenterId}
              onUpdate={() => mutateOrders()}
            />
          </div>
        </Card>
      </section>

      {/* Professional Error Dialog */}
      <Dialog open={showErrorDialog} onOpenChange={setShowErrorDialog}>
        <DialogContent className="max-w-md border-0 shadow-2xl bg-white/90 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2rem]">
          <DialogHeader className="text-center pb-2">
            <div className="mx-auto w-16 h-16 rounded-[1.5rem] bg-amber-500/10 flex items-center justify-center mb-4">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
            </div>
            <DialogTitle className="text-xl font-black text-slate-900 dark:text-slate-100 tracking-tight">
              Attention Required
            </DialogTitle>
          </DialogHeader>

          <div className="py-4">
            <p className="text-center text-slate-600 dark:text-slate-400 leading-relaxed font-medium">
              {errorMessage}
            </p>
          </div>

          <DialogFooter className="sm:justify-center">
            <Button
              onClick={() => setShowErrorDialog(false)}
              className="w-full sm:w-auto px-8 h-12 rounded-xl font-bold bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 dark:text-slate-900"
            >
              Understood
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

function CompactStatCard({
  label,
  value,
  icon,
  gradient,
  iconBadge
}: {
  label: string
  value: string | number
  icon: React.ReactNode
  gradient: string
  iconBadge: string
}) {
  return (
    <Card className={cn("border border-white/40 dark:border-white/5 rounded-3xl shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden", gradient)}>
      <CardContent className="p-6 flex items-center justify-between relative">
        <div className="absolute inset-0 bg-gradient-to-br from-white/40 to-transparent dark:from-white/5 dark:to-transparent pointer-events-none" />
        <div className="space-y-2 relative z-10">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p className="text-3xl sm:text-4xl font-black tracking-tight text-slate-900 dark:text-white">
            {value}
          </p>
        </div>
        <div className={cn("flex h-14 w-14 items-center justify-center rounded-2xl relative z-10", iconBadge)}>
          {icon}
        </div>
      </CardContent>
    </Card>
  )
}
