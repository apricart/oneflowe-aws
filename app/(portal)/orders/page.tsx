"use client"
import { viewerAccessFor } from "@/lib/viewer-access"
import { isApricartSupportRole } from "@/lib/apricart-support-access"
import React,{ Suspense,useState,useMemo,useEffect,useCallback } from "react"
import { useSearchParams } from "next/navigation"
import useSWR from "swr"
import { useSession } from "next-auth/react"
import { useDebounce } from "@/hooks/use-debounce"
import { Card,CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination"
import {
  Package,
  Search,
  Filter,
  CheckCircle,
  Clock,
  TrendingDown,RefreshCw,XCircle,ChevronLeft,
  ChevronRight,
  PackageCheck,
  Truck,
  FileText,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAppContext } from "@/components/context/app-context"
import { OrderExport } from "@/components/orders/order-export"
import { OrdersDirectory } from "@/components/orders/orders-directory"
import { useTableSort } from "@/components/reports/sortable-header"
import type { OrderListSortKey } from "@/lib/list-sort-keys"
import { appendSortParams,type SortDirection } from "@/lib/table-sort"
import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
import { startOfDay,endOfDay } from "date-fns"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getOrderFulfillmentVariant,
  getOrderStatusFilter,
  type OrderSplitFilter,
  type OrderStatusFilter,
} from "@/lib/order-status"
import { selectOrdersForListView } from "@/lib/order-list-view"
import {
  DELIVERED_UNFULFILLED_LABEL,
  ORDER_DELIVERY_FILTER_UNACKNOWLEDGED,
  parseOrderDeliveryFilter,
  type OrderDeliveryFilter,
} from "@/lib/unacknowledged-orders"
import {
  FULFILLMENT_STATUS_LABELS,
  FULFILLMENT_STATUSES,
  parseFulfillmentStatusFilter,
  type FulfillmentStatus,
} from "@/lib/fulfillment-status"
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUSES,
  parseInvoiceStatusFilter,
  type InvoiceStatus,
} from "@/lib/invoice-status"
import {
  PAYMENT_STATUS_LABELS,
  parsePaymentStatusFilter,
  type PaymentStatus,
} from "@/lib/payment-status"

type DateRange = {
  startDate: Date
  endDate: Date
}
const getDefaultDateRange = (): DateRange => ({
  startDate: startOfDay(new Date()),
  endDate: endOfDay(new Date()),
})
const ORDERS_PAGE_SIZE = 25
// The export walks the same query a page at a time. 200 is the list endpoint's
// own default page size and well inside its cap of 500.
const ORDERS_EXPORT_PAGE_SIZE = 200
const ORDERS_EXPORT_CONCURRENCY = 4

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
  partialDelivery?: boolean
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  statusAtRefund?: string | null
  refundedAt?: string | null
  refundAmountCents?: number | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  createdAt: string
  approvedAt?: string | null
  fulfilledAt?: string | null
  deliveredAt?: string | null
  createdByUserId: string
  hasRefundRequests?: number
  rejectionReason?: string | null
  itemNames?: string | null
  approvalToken?: string | null
  /** Derived server-side: the order came from a Group Order Portal submission. */
  placedByGroupPortal?: boolean
}

export default function OrdersManagementPage() {
  return (
    <Suspense
      fallback={
        <div className="py-24 text-center text-muted-foreground">
          Loading orders…
        </div>
      }
    >
      <OrdersManagementContent />
    </Suspense>
  )
}

/**
 * The tab a link asks for. `?delivery=unacknowledged` opens the
 * "Delivered · Unfulfilled" tab, which rides on the approved status filter;
 * any other delivery value is ignored here and refused by the API.
 */
function requestedListTab(searchParams: Pick<URLSearchParams, "get">): {
  statusFilter: OrderStatusFilter
  deliveryFilter: OrderDeliveryFilter | null
  fulfillmentStatusFilter: FulfillmentStatus | null
  invoiceStatusFilter: InvoiceStatus | null
  paymentStatusFilter: PaymentStatus | null
} {
  const delivery = parseOrderDeliveryFilter(searchParams.get("delivery"))
  const deliveryFilter = delivery.ok ? delivery.filter : null
  const fulfillmentStatus = parseFulfillmentStatusFilter(searchParams.get("fulfillmentStatus"))
  const invoiceStatus = parseInvoiceStatusFilter(searchParams.get("invoiceStatus"))
  const paymentStatus = parsePaymentStatusFilter(searchParams.get("paymentStatus"))
  return {
    statusFilter: deliveryFilter ? "approved" : getOrderStatusFilter(searchParams.get("status")),
    deliveryFilter,
    fulfillmentStatusFilter: fulfillmentStatus.ok ? fulfillmentStatus.filter : null,
    invoiceStatusFilter: invoiceStatus.ok ? invoiceStatus.filter : null,
    paymentStatusFilter: paymentStatus.ok ? paymentStatus.status : null,
  }
}

function OrdersManagementContent() {
  const searchParams = useSearchParams()
  const {
    statusFilter: requestedStatusFilter,
    deliveryFilter: requestedDeliveryFilter,
    fulfillmentStatusFilter: requestedFulfillmentStatusFilter,
    invoiceStatusFilter: requestedInvoiceStatusFilter,
    paymentStatusFilter: requestedPaymentStatusFilter,
  } = requestedListTab(searchParams)
  const { data: session } = useSession()
  const {
    organizationId,
    branchId,
    branchIds,
    isInitialized  } = useAppContext()
  // An organization-wide Viewer reads the directory as Head Office does. It
  // decides and hands over nothing: the decision capabilities and the token
  // that drive those controls come from the server, which never grants them
  // to the role.
  const { role: sessionRole, viewRole, readOnly: viewerReadOnly } = viewerAccessFor(session?.user)
  const userRole = viewRole ?? undefined
  const isApricartSupport = isApricartSupportRole(sessionRole)
  const isReadOnly = viewerReadOnly || isApricartSupport
  const isBranchAdmin = userRole === "BRANCH_ADMIN"
  const isHeadOffice = userRole === "HEAD_OFFICE"
  const isSuperAdmin = userRole === "SUPER_ADMIN"
  // The approver reaches every branch assigned to it. It sends no branch filter
  // of its own: `/api/v1/orders` resolves that set from the caller's own
  // assignments, so the list is scoped on the server rather than here.
  const isGroupUser = userRole === "GROUP_USER"

  const [searchQuery, setSearchQuery] = useState("")
  const debouncedSearchQuery = useDebounce(searchQuery.trim(), 300)
  const [currentPage, setCurrentPage] = useState(1)
  // Sorted on the server, so it covers every page; it starts at the order the
  // list already used (newest first). A new sort starts again from page 1.
  const { sort: orderSort, toggleSort: toggleOrderSort } = useTableSort<OrderListSortKey>({ key: "orderDate", direction: "desc" })
  const handleOrderSort = useCallback((key: OrderListSortKey, firstDirection?: SortDirection) => {
    toggleOrderSort(key, firstDirection)
    setCurrentPage(1)
  }, [toggleOrderSort])
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [activePreset, setActivePreset] = useState<FilterPreset>("all")
  const [selectedMonths, setSelectedMonths] = useState<number[]>([])
  const [selectedYears, setSelectedYears] = useState<number[]>([])
  const [statusFilter, setStatusFilter] = useState<OrderStatusFilter>(requestedStatusFilter)
  const [splitFilter, setSplitFilter] = useState<OrderSplitFilter>("all")
  // Delivered orders still waiting to be fulfilled are a slice of Active, shown
  // as their own tab. It rides on the approved status filter.
  const [deliveryFilter, setDeliveryFilter] = useState<OrderDeliveryFilter | null>(requestedDeliveryFilter)
  const [fulfillmentStatusFilter, setFulfillmentStatusFilter] = useState<FulfillmentStatus | null>(
    requestedFulfillmentStatusFilter,
  )
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<InvoiceStatus | null>(
    requestedInvoiceStatusFilter,
  )
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatus | null>(
    requestedPaymentStatusFilter,
  )
  // Local Hierarchical Filter State
  const [reportBranchIds, setReportBranchIds] = useState<string[]>([])
  const [reportGroupIds, setReportGroupIds] = useState<string[]>([])

  useEffect(() => {
    setCurrentPage(1)
    setStatusFilter(requestedStatusFilter)
    setDeliveryFilter(requestedDeliveryFilter)
    setFulfillmentStatusFilter(requestedFulfillmentStatusFilter)
    setInvoiceStatusFilter(requestedInvoiceStatusFilter)
    setPaymentStatusFilter(requestedPaymentStatusFilter)
  }, [requestedStatusFilter, requestedDeliveryFilter, requestedFulfillmentStatusFilter, requestedInvoiceStatusFilter, requestedPaymentStatusFilter])


  const handleDateChange = useCallback(({ range, preset, months = [], years = [] }: GlobalDateFilterChange) => {
    setCurrentPage(1)
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
    deliveryFilter !== null ||
    fulfillmentStatusFilter !== null ||
    invoiceStatusFilter !== null ||
    paymentStatusFilter !== null ||
    splitFilter !== "all"

  const resetOrderFilters = useCallback(() => {
    setCurrentPage(1)
    setReportGroupIds([])
    setReportBranchIds([])
    setSearchQuery("")
    setDateRange(null)
    setActivePreset("all")
    setSelectedMonths([])
    setSelectedYears([])
    setStatusFilter("all")
    setDeliveryFilter(null)
    setFulfillmentStatusFilter(null)
    setInvoiceStatusFilter(null)
    setPaymentStatusFilter(null)
    setSplitFilter("all")
  }, [])

  // ━━━ CASCADING SELECTION CLEARING ━━━
  useEffect(() => {
    setReportBranchIds([])
  }, [reportGroupIds])

  useEffect(() => {
    setCurrentPage(1)
  }, [organizationId, branchId, branchIds])

  // The active filters, without paging. The screen appends its own page and the
  // export walks every page of the same query, so both describe the same scope.
  const ordersQuery = useMemo<string | null>(() => {
    if (!isInitialized) return null
    const params = new URLSearchParams()
    if (organizationId && organizationId !== "null" && organizationId !== "0") {
      params.set("organizationId", organizationId)
    }


    // Local filters override global context if set
    // If a group is selected but no branches, we leave branchIds empty so the API filters solely by Group
    const effectiveBranchIds = (() => {
      if (reportBranchIds.length > 0) {
        return reportBranchIds
      }
      return ((() => {
        if (reportGroupIds.length > 0) {
          return []
        }
        return ((() => {
          if (branchIds.length > 0) {
            return branchIds
          }
          return (branchId ? [branchId] : [])
        })())
      })())
    })()

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

    if (statusFilter !== "all") {
      params.set("status", statusFilter)
    }

    if (deliveryFilter) {
      params.set("delivery", deliveryFilter)
    }

    if (fulfillmentStatusFilter) {
      params.set("fulfillmentStatus", fulfillmentStatusFilter)
    }

    if (invoiceStatusFilter) {
      params.set("invoiceStatus", invoiceStatusFilter)
    }

    if (paymentStatusFilter) {
      params.set("paymentStatus", paymentStatusFilter)
    }

    if (debouncedSearchQuery) {
      params.set("q", debouncedSearchQuery)
    }

    return params.toString()
  }, [organizationId, branchId, branchIds, reportBranchIds, reportGroupIds, dateRange, selectedMonths, selectedYears, statusFilter, isInitialized, debouncedSearchQuery, deliveryFilter, fulfillmentStatusFilter, invoiceStatusFilter, paymentStatusFilter])

  const ordersEndpoint = useMemo(() => {
    if (ordersQuery === null) return null
    const params = new URLSearchParams(ordersQuery)
    params.set("page", currentPage.toString())
    params.set("limit", ORDERS_PAGE_SIZE.toString())
    appendSortParams(params, orderSort)
    return `/api/v1/orders?${params.toString()}`
  }, [ordersQuery, currentPage, orderSort])

  // Fetch orders scoped by context
  const { data: ordersData, mutate: mutateOrders, isValidating } = useSWR<any>(
    ordersEndpoint,
    fetcher,
    { keepPreviousData: true },
  )

  const orders = useMemo(() => ordersData?.items || [], [ordersData?.items])
  const canDecideOrders = Boolean(
    ordersData?.capabilities?.canApproveOrders
    && ordersData?.capabilities?.canRejectOrders,
  )
  const showSplitFilter = statusFilter === "fulfilled" || statusFilter === "refunded"
  const showPaymentFilter = statusFilter === "fulfilled" && deliveryFilter === null

  useEffect(() => {
    if (!showSplitFilter && splitFilter !== "all") {
      setSplitFilter("all")
    }
  }, [showSplitFilter, splitFilter])

  useEffect(() => {
    if (!showPaymentFilter && paymentStatusFilter !== null) {
      setPaymentStatusFilter(null)
    }
  }, [showPaymentFilter, paymentStatusFilter])

  // Filter and search orders
  const filteredOrders = useMemo(
    () => selectOrdersForListView<OrderItem>(orders, { statusFilter, splitFilter, deliveryFilter }),
    [orders, splitFilter, statusFilter, deliveryFilter],
  )

  // Export covers the whole filtered scope, not the page on screen. The list is
  // paginated, so this walks every page of the same query and narrows the
  // result with the selector the table itself uses.
  const fetchAllFilteredOrders = useCallback(async (): Promise<OrderItem[]> => {
    if (ordersQuery === null) return []

    const requestPage = async (page: number) => {
      const params = new URLSearchParams(ordersQuery)
      params.set("page", page.toString())
      params.set("limit", ORDERS_EXPORT_PAGE_SIZE.toString())
      const response = await fetch(`/api/v1/orders?${params.toString()}`)
      if (!response.ok) throw new Error(`Export request failed (${response.status})`)
      const data = await response.json()
      if (data?.error) throw new Error(data.error)
      return data
    }

    const firstPage = await requestPage(1)
    const collected: OrderItem[] = [...(firstPage?.items || [])]
    const totalPages = Math.max(1, Number(firstPage?.pagination?.totalPages) || 1)

    for (let page = 2; page <= totalPages; page += ORDERS_EXPORT_CONCURRENCY) {
      const pageNumbers = Array.from(
        { length: Math.min(ORDERS_EXPORT_CONCURRENCY, totalPages - page + 1) },
        (_, index) => page + index,
      )
      const pages = await Promise.all(pageNumbers.map(requestPage))
      pages.forEach((data) => collected.push(...(data?.items || [])))
    }

    return selectOrdersForListView<OrderItem>(collected, { statusFilter, splitFilter, deliveryFilter })
  }, [ordersQuery, splitFilter, statusFilter, deliveryFilter])

  // Approve order

  // Reject order

  // Fulfill order (requires approval token)


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

  const statusCounts = ordersData?.summary || {
    all: orders.length,
    pending: orders.filter((o: OrderItem) => o.status.toLowerCase() === "pending").length,
    approved: orders.filter((o: OrderItem) => o.status.toLowerCase() === "approved").length,
    fulfilled: orders.filter((o: OrderItem) => getOrderFulfillmentVariant(o) === "full").length,
    refunded: orders.filter((o: OrderItem) => o.status.toLowerCase() === "refunded").length,
    rejected: orders.filter((o: OrderItem) => o.status.toLowerCase() === "rejected" || o.status.toLowerCase() === "cancelled").length,
  }
  const totalOrders = Number(ordersData?.pagination?.total || 0)
  const totalPages = Math.max(
    1,
    Number(ordersData?.pagination?.totalPages) || Math.ceil(totalOrders / ORDERS_PAGE_SIZE),
  )
  const firstVisibleOrder = totalOrders === 0 ? 0 : (currentPage - 1) * ORDERS_PAGE_SIZE + 1
  const lastVisibleOrder = Math.min(
    (currentPage - 1) * ORDERS_PAGE_SIZE + filteredOrders.length,
    totalOrders,
  )

  useEffect(() => {
    if (ordersData?.pagination && currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, ordersData?.pagination, totalPages])

  const scopeText = (() => {
    if (branchId) {
      return selectedBranch?.name || `Branch #${branchId}`
    }
    // The approver's list already covers exactly its assigned branches, so the
    // badge names that scope rather than the whole organization.
    if (isGroupUser) {
      return "Assigned branches"
    }
    if (organizationId) {
      return selectedOrg?.name || "Selected organization"
    }
    return "All organizations"
  })()

  const scopeDescription = (() => {
    if (isApricartSupport) return "View orders across every organization. This workspace is read only."
    if (isBranchAdmin) return "Review orders placed from your branch's Order Initiator Portal."
    if (isGroupUser) return "Review orders placed from the branches assigned to you."
    return `Monitor approvals and fulfillment pipelines across ${scopeText.toLowerCase()}.`
  })()

  if (!isInitialized || !ordersEndpoint) {
    return (
      <div className="py-24 text-center text-muted-foreground">
        Loading your context…
      </div>
    )
  }

  return (
    <main className="min-h-screen w-full min-w-0 max-w-full bg-[#f8fafc] dark:bg-[#020617] p-4 md:p-8 space-y-8">
      {/* ═══ MODERN COMPACT HEADER ═══ */}
      <section className="flex flex-col md:flex-row md:items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-400 shadow-inner">
              <Package className="h-5 w-5" />
            </span>
            <span>Order Intelligence</span>
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 sm:ml-[3.25rem]">
            {scopeDescription}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isReadOnly && (
            <Badge variant="outline" className="h-8 rounded-full border-slate-300 bg-white px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              View only
            </Badge>
          )}
          <Badge variant="outline" className="h-8 px-3 rounded-full border-indigo-200 bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:border-indigo-800/60 dark:text-indigo-400 font-semibold uppercase tracking-wider text-[10px]">
            {scopeText}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => mutateOrders()} className="h-8 gap-2 rounded-full border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-sm shadow-sm hover:bg-slate-100 dark:hover:bg-slate-800">
            <RefreshCw className={cn("h-3.5 w-3.5 text-slate-500", isValidating && "animate-spin text-indigo-500")} />
            <span className="hidden sm:inline font-semibold text-slate-600 dark:text-slate-300">Refresh</span>
          </Button>
        </div>
      </section>

      {/* ═══ COMPACT STATS ROW ═══ */}
      <section
        aria-label="Order summary"
        className="grid grid-cols-6 gap-[clamp(0.25rem,0.75vw,0.75rem)] animate-in fade-in slide-in-from-bottom-4 duration-500 delay-100 fill-mode-both"
      >
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
      <section className="relative z-40 min-w-0 max-w-full animate-in fade-in slide-in-from-bottom-6 duration-1000 delay-300 fill-mode-both">
        <Card className="min-w-0 max-w-full overflow-visible rounded-[2.5rem] border-none bg-white/80 shadow-[0_15px_60px_rgb(0,0,0,0.05)] backdrop-blur-xl dark:bg-[#050b1a]/80 dark:shadow-[0_15px_60px_rgb(0,0,0,0.3)]">
          <div className="min-w-0 space-y-3 p-3 md:p-4">
            {/* Top Row: Core Tools */}
            <div className="flex min-w-0 flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
              {/* Left Side: Search & Primary Filters */}
              <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center 2xl:flex-1">
                {/* Status Tabs */}
                <div className="flex min-w-0 max-w-full items-center overflow-x-auto rounded-xl border border-slate-200/50 bg-slate-100/60 p-1 no-scrollbar dark:border-slate-700/50 dark:bg-slate-800/50 sm:flex-1">
                  {([
                    ["all", "All"],
                    ["pending", "Pending Approval"],
                    ["approved", "Active"],
                    ["fulfilled", "Fulfilled"],
                    ["rejected", "Rejected"],
                    ["refunded", "Refunded"],
                  ] as [OrderStatusFilter, string][]).map(([status, label]) => {
                    const isSelected = statusFilter === status && deliveryFilter === null
                    return (
                    <Button
                      key={status}
                      onClick={() => {
                        setCurrentPage(1)
                        setStatusFilter(status)
                        setDeliveryFilter(null)
                        if (status !== "fulfilled") setPaymentStatusFilter(null)
                      }}
                      variant={isSelected ? "secondary" : "ghost"}
                      size="sm"
                      className={`px-3 h-8 text-xs font-bold rounded-lg transition-all duration-200 shrink-0 ${isSelected
                        ? "bg-white dark:bg-slate-700 shadow-sm text-slate-900 dark:text-white"
                        : "text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                        }`}
                    >
                      {label}
                    </Button>
                    )
                  })}
                  <Button
                    onClick={() => {
                      setCurrentPage(1)
                      setStatusFilter("approved")
                      setDeliveryFilter(ORDER_DELIVERY_FILTER_UNACKNOWLEDGED)
                      setFulfillmentStatusFilter(null)
                    }}
                    variant={deliveryFilter ? "secondary" : "ghost"}
                    size="sm"
                    title="Active orders whose goods have been delivered but which are not yet fulfilled"
                    className={cn(
                      "h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-bold transition-all duration-200",
                      deliveryFilter
                        ? "bg-white text-amber-700 shadow-sm dark:bg-slate-700 dark:text-amber-300"
                        : "text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300",
                    )}
                  >
                    <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                    {DELIVERED_UNFULFILLED_LABEL}
                    <span className="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                      {Number(statusCounts.deliveredUnacknowledged || 0)}
                    </span>
                  </Button>
                </div>

                {showPaymentFilter && (
                  <div
                    className="flex shrink-0 items-center rounded-xl border border-slate-200/50 bg-slate-100/60 p-1 dark:border-slate-700/50 dark:bg-slate-800/50"
                    role="group"
                    aria-label="Filter fulfilled orders by payment status"
                  >
                    {([null, "PAID", "UNPAID"] as const).map((paymentStatus) => (
                      <Button
                        key={paymentStatus ?? "all"}
                        type="button"
                        size="sm"
                        variant={paymentStatusFilter === paymentStatus ? "secondary" : "ghost"}
                        aria-pressed={paymentStatusFilter === paymentStatus}
                        onClick={() => { setCurrentPage(1); setPaymentStatusFilter(paymentStatus) }}
                        className="h-8 rounded-lg px-3 text-xs font-bold"
                      >
                        {paymentStatus ? PAYMENT_STATUS_LABELS[paymentStatus] : "All payments"}
                      </Button>
                    ))}
                  </div>
                )}

                <div className="group relative w-full min-w-0 sm:w-[280px] sm:shrink-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-indigo-500" />
                  <Input
                    placeholder="Search by transaction ID, order ID, or cost center..."
                    className="pl-9 h-8 text-[11px] font-bold bg-white dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 rounded-xl focus:ring-1 focus:ring-indigo-500/30 transition-all shadow-sm"
                    value={searchQuery}
                    onChange={(e) => {
                      setCurrentPage(1)
                      setSearchQuery(e.target.value)
                    }}
                  />
                </div>
              </div>

              {/* Right Side: Environment Filters & Actions */}
              <div className="flex w-full flex-wrap items-center justify-end gap-2 rounded-2xl 2xl:w-auto 2xl:shrink-0 2xl:flex-nowrap">
                <Select
                  value={fulfillmentStatusFilter ?? "all"}
                  onValueChange={(value) => {
                    setCurrentPage(1)
                    setDeliveryFilter(null)
                    setFulfillmentStatusFilter(value === "all" ? null : (value as FulfillmentStatus))
                  }}
                >
                  <SelectTrigger
                    aria-label="Filter by delivery status"
                    className="h-10 w-[190px] rounded-xl border-slate-200 bg-white text-xs font-medium shadow-sm dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <Truck className="mr-2 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                    <SelectValue placeholder="All delivery statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All delivery statuses</SelectItem>
                    {FULFILLMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {FULFILLMENT_STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={invoiceStatusFilter ?? "all"}
                  onValueChange={(value) => {
                    setCurrentPage(1)
                    setInvoiceStatusFilter(value === "all" ? null : (value as InvoiceStatus))
                  }}
                >
                  <SelectTrigger
                    aria-label="Filter by invoice status"
                    className="h-10 w-[190px] rounded-xl border-slate-200 bg-white text-xs font-medium shadow-sm dark:border-slate-800 dark:bg-slate-900/50"
                  >
                    <FileText className="mr-2 h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                    <SelectValue placeholder="All invoice statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All invoice statuses</SelectItem>
                    {INVOICE_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {INVOICE_STATUS_LABELS[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <GlobalDateFilter
                  value={dateRange}
                  onChange={handleDateChange}
                  activePreset={activePreset}
                  months={selectedMonths}
                  years={selectedYears}
                />

                <div className="h-6 w-px bg-slate-200 dark:bg-slate-800 mx-1" />
                <OrderExport
                  fetchOrders={fetchAllFilteredOrders}
                  totalOrders={totalOrders}
                  role={userRole}
                  statusContext={showSplitFilter ? statusFilter : "default"}
                />
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
                    onClick={() => {
                      setCurrentPage(1)
                      setSplitFilter(value)
                    }}
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
                      onChange={(ids) => {
                        setCurrentPage(1)
                        setReportGroupIds(ids)
                      }}
                      organizationIds={organizationId ? [organizationId] : undefined}
                    />

                    <BranchFilter
                      selectedIds={reportBranchIds}
                      onChange={(ids) => {
                        setCurrentPage(1)
                        setReportBranchIds(ids)
                      }}
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

          <div className="w-full min-w-0 max-w-full px-1 pb-4 sm:px-4">
            <OrdersDirectory
              orders={filteredOrders}
              statusContext={showSplitFilter ? (statusFilter as "fulfilled" | "refunded") : "default"}
              userRole={userRole}
              isSuperAdmin={isSuperAdmin}
              isBranchAdmin={isBranchAdmin}
              isHeadOffice={isHeadOffice}
              readOnly={isReadOnly}
              showOrganization={isSuperAdmin || isApricartSupport}
              showInvoiceLink={!isApricartSupport}
              canDecideOrders={canDecideOrders}
              showCostCenterId={showCostCenterId}
              pricesHidden={Boolean(ordersData?.pricesHidden)}
              sort={orderSort}
              onSort={handleOrderSort}
              onUpdate={() => mutateOrders()}
            />
            {totalOrders > 0 && (
              <div className="mt-4 flex flex-col items-center justify-between gap-3 border-t border-slate-100 px-2 pt-4 dark:border-slate-800 sm:flex-row">
                <p className="text-xs font-medium text-slate-500" aria-live="polite">
                  Showing {firstVisibleOrder}-{lastVisibleOrder} of {totalOrders} orders
                </p>
                <Pagination className="mx-0 w-auto justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1 rounded-xl"
                        aria-label="Go to previous page"
                        disabled={currentPage <= 1 || isValidating}
                        onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="hidden sm:inline">Previous</span>
                      </Button>
                    </PaginationItem>
                    <PaginationItem>
                      <span className="flex h-9 min-w-24 items-center justify-center px-3 text-xs font-semibold text-slate-600 dark:text-slate-300">
                        Page {currentPage} of {totalPages}
                      </span>
                    </PaginationItem>
                    <PaginationItem>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1 rounded-xl"
                        aria-label="Go to next page"
                        disabled={currentPage >= totalPages || isValidating}
                        onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                      >
                        <span className="hidden sm:inline">Next</span>
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </div>
        </Card>
      </section>

    </main>
  )
}

function CompactStatCard({
  label,
  value,
  icon,
  gradient,
  iconBadge
}: Readonly<{
  label: string
  value: string | number
  icon: React.ReactNode
  gradient: string
  iconBadge: string
}>) {
  return (
    <Card className={cn("min-w-0 overflow-hidden rounded-[clamp(0.75rem,8cqw,1.5rem)] border border-white/40 shadow-sm transition-all duration-300 [container-type:inline-size] hover:-translate-y-0.5 hover:shadow-md dark:border-white/5", gradient)}>
      <CardContent className="relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[clamp(0.125rem,2cqw,0.75rem)] p-[clamp(0.5rem,7cqw,1.5rem)]">
        <div className="absolute inset-0 bg-gradient-to-br from-white/40 to-transparent dark:from-white/5 dark:to-transparent pointer-events-none" />
        <div className="relative z-10 min-w-0 space-y-[clamp(0.25rem,2cqw,0.5rem)]">
          <p className="break-words text-[clamp(0.45rem,5.5cqw,0.625rem)] font-bold uppercase leading-snug tracking-[clamp(0.08em,1cqw,0.2em)] text-slate-500 dark:text-slate-400">
            {label}
          </p>
          <p className="text-[clamp(1.25rem,18cqw,2.25rem)] font-black leading-none tracking-tight text-slate-900 dark:text-white">
            {value}
          </p>
        </div>
        <div className={cn("relative z-10 flex size-[clamp(1.5rem,28cqw,3.5rem)] shrink-0 items-center justify-center rounded-[clamp(0.5rem,8cqw,1rem)] [&>svg]:size-[clamp(0.75rem,11cqw,1.25rem)]", iconBadge)}>
          {icon}
        </div>
      </CardContent>
    </Card>
  )
}
