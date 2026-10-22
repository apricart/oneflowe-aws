"use client"

import { viewerAccessFor } from "@/lib/viewer-access"
import { useAppContext } from "@/components/context/app-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { usesPurchaseWording } from "@/lib/purchase-wording"
import {
DropdownMenu,
DropdownMenuContent,
DropdownMenuItem,
DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Pagination,PaginationContent,PaginationItem } from "@/components/ui/pagination"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs"
import { approverLevelOf } from "@/lib/consolidated-invoice"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { getOrderStatusDisplay } from "@/lib/order-status-display"
import { getFulfillmentProgressColor, getPaymentStatusColor } from "@/lib/order-status-colors"
import { PAYMENT_STATUS_LABELS, type PaymentStatus } from "@/lib/payment-status"
import { Role } from "@/lib/rbac"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import {
    buildOrderReportExportRows,
    resolveOrderReportExportHeaders,
} from "@/lib/order-report-export-layout"
import { cn,formatPKR } from "@/lib/utils"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import {
Calculator,
Calendar,
ChevronLeft,ChevronRight,
ChevronDown,
Database,
FileSpreadsheet,
FileText,
Filter,
Hash,
Layers,LayoutDashboard,
Loader2,
Package,
RefreshCw,
RotateCcw,
Search,
Store,
TrendingUp,
Upload
} from "lucide-react"
import { useSession } from "next-auth/react"
import { Fragment,useCallback,useEffect,useMemo,useRef,useState,type KeyboardEvent,type ReactNode } from "react"
import {
Bar,
CartesianGrid,
Cell,
ComposedChart,
Line,
Pie,
PieChart,
Tooltip as RechartsTooltip,
ResponsiveContainer,
XAxis,
YAxis
} from "recharts"
import useSWR from "swr"
import * as XLSX from "xlsx"

import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { ColumnSelector,useColumnSelector,type ColumnDef } from "@/components/reports/column-selector"
import { GroupFilter } from "@/components/reports/group-filter"
import { KPICard } from "@/components/reports/kpi-card"
import { ReportTableScroll } from "@/components/reports/report-table-scroll"
import { SortableHeader, ariaSortFor, useTableSort } from "@/components/reports/sortable-header"
import type { OrderReportSortKey } from "@/lib/list-sort-keys"
import { appendSortParams, type SortDirection } from "@/lib/table-sort"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { OrderReportRowDetails } from "@/components/reports/order-report-row-details"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import type { DateRange } from "@/lib/hooks/use-sales-performance"
const fetcher = (url: string) => fetch(url).then((r) => r.json())
const ORDER_REPORT_PAGE_SIZE = 25
/** Dates, quantities and money show the newest or largest first on the first click. */
const ORDER_REPORT_DESC_FIRST_SORT_KEYS = new Set<OrderReportSortKey>([
    "orderDate", "quantityOrdered", "quantityDelivered", "quantityRefunded", "subtotalValue", "refundValue", "netTotalValue",
])

const ALL_COLUMNS: ColumnDef[] = [
    { key: "orderDate", label: "Date", defaultVisible: true },
    { key: "userName", label: "User name", defaultVisible: true },
    { key: "employeeId", label: "Employee #", defaultVisible: true },
    { key: "tid", label: "Transaction ID", defaultVisible: true },
    { key: "organizationName", label: "Org", defaultVisible: true },
    { key: "group", label: "Group", defaultVisible: true },
    { key: "groupOrderReference", label: "Group Order ID", defaultVisible: true },
    { key: "branchName", label: "Branch", defaultVisible: true },
    { key: "status", label: "Status", defaultVisible: true },
    { key: "deliveryStatus", label: "Delivery Status", defaultVisible: true },
    { key: "paymentStatus", label: "Payment", defaultVisible: true },
    { key: "approvalLevel", label: "Approval Level", defaultVisible: true },
    { key: "financialApproverLevel", label: "Financial Approver Level", defaultVisible: true },
    { key: "approver", label: "Approver", defaultVisible: true },
    { key: "quantityOrdered", label: "Qty Ordered", defaultVisible: true },
    { key: "quantityDelivered", label: "Qty Delivered", defaultVisible: true },
    { key: "quantityRefunded", label: "Qty Refunded", defaultVisible: true },
    { key: "subtotalValue", label: "Subtotal", defaultVisible: true },
    { key: "refundValue", label: "Refund", defaultVisible: true },
    { key: "netTotalValue", label: "Net Value", defaultVisible: true },
] as const;

type StatusFilter = "all" | "pending" | "approved" | "fulfilled" | "refunded" | "rejected"

const STATUS_COLORS: Record<string, string> = {
    FULFILLED: "#10b981",
    APPROVED: "#3b82f6",
    REFUNDED: "#f59e0b",
    REJECTED: "#ef4444",
    PENDING: "#8b5cf6",
    CANCELLED: "#ef4444",
}

export default function OrderReportPage() {

    const {
        organizationId: contextOrgId,
        branchId: contextBranchId,
        branchIds: contextBranchIds,
        setBranchIds: setContextBranchIds,
        isInitialized
    } = useAppContext()

    const { data: session, status: sessionStatus } = useSession()
    const { toast } = useToast()
    // An organization-wide Viewer reads this report as Head Office does.
    const { viewRole } = viewerAccessFor(session?.user)
    const role = viewRole as Role
    const userOrgId = (session?.user as any)?.organizationId
    const organizationId = userOrgId || contextOrgId
    const isBuyer = usesPurchaseWording(role)

    // Role-based terminology
    const kpiRevenueLabel = isBuyer ? "Net Amount" : "Net Revenue"
    const kpiAvgLabel = isBuyer ? "Avg Purchased Value" : "Avg Value"
    const chartRevenueLabel = isBuyer ? "Purchased" : "Revenue"
    const chartOrdersLabel = "Orders"
    const exportTitleLabel = isBuyer ? "Order Purchase Report" : "Order Consumption Report"

    const [hasMounted, setHasMounted] = useState(false)
    const [activeTab, setActiveTab] = useState("analytics")
    const [reportSearch, setReportSearch] = useState("")
    const debouncedReportSearch = useDebounce(reportSearch.trim(), 300)
    // A Group Order Portal submission is recorded as one ordinary order per
    // branch, so these rows already sit in every administrator's report. The
    // column and the reference filter are what let them tell which submission a
    // row came from — the server pins the reference lookup to the caller's own
    // organizations, so it reveals nothing outside the scope they already read.
    const showsGroupOrders = ["GROUP_USER", "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"].includes(role)
    const [groupOrderFilter, setGroupOrderFilter] = useState("")
    const debouncedGroupOrderFilter = useDebounce(groupOrderFilter.trim(), 300)
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
    const [paymentStatusFilter, setPaymentStatusFilter] = useState<PaymentStatus | null>(null)
    const [currentPage, setCurrentPage] = useState(1)
    // Sorted on the server so it covers every page, starting from the order the
    // report already used (newest first). A new sort starts again from page 1.
    const { sort: reportSort, toggleSort: toggleReportSort } = useTableSort<OrderReportSortKey>({ key: "orderDate", direction: "desc" })
    const handleReportSort = useCallback((key: OrderReportSortKey, firstDirection?: SortDirection) => {
        toggleReportSort(key, firstDirection)
        setCurrentPage(1)
    }, [toggleReportSort])
    const sortHead = (key: OrderReportSortKey, label: ReactNode) => (
        <SortableHeader
            label={label}
            sortKey={key}
            sort={reportSort}
            onSort={handleReportSort}
            firstDirection={ORDER_REPORT_DESC_FIRST_SORT_KEYS.has(key) ? "desc" : "asc"}
        />
    )
    // Rows opened to show their order details and line items. Several may be open
    // at once; an id no longer on the current page simply renders nothing.
    const [expandedOrderIds, setExpandedOrderIds] = useState<Set<number>>(() => new Set())
    const toggleOrderExpansion = useCallback((orderId: number) => {
        setExpandedOrderIds((current) => {
            const next = new Set(current)
            if (next.has(orderId)) next.delete(orderId)
            else next.add(orderId)
            return next
        })
    }, [])
    const handleOrderRowClick = (orderId: number) => {
        // Selecting a transaction id to copy it should not also toggle the row.
        if (window.getSelection()?.toString()) return
        toggleOrderExpansion(orderId)
    }
    const handleOrderRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, orderId: number) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        toggleOrderExpansion(orderId)
    }
    const [isExporting, setIsExporting] = useState(false)
    const [generatedDate, setGeneratedDate] = useState("")

    // ━━━ 1. GLOBAL STATE (Sticky Header) ━━━
    const [dateRange, setDateRange] = useState<DateRange | null>(null)
    const [activePreset, setActivePreset] = useState<FilterPreset>("all")
    const [compare, setCompare] = useState(false)
    const [compareRange, setCompareRange] = useState<DateRange | null>(null)

    // Global Multi-Selects
    const [selectedMonths, setSelectedMonths] = useState<number[]>([])
    const [selectedYears, setSelectedYears] = useState<number[]>([])
    const [compareMonths, setCompareMonths] = useState<number[]>([])
    const [compareYears, setCompareYears] = useState<number[]>([])

    // ━━━ 2. ANALYTICS LOCAL STATE ━━━
    const [chartMonths, setChartMonths] = useState<number[]>([])
    const [chartYears, setChartYears] = useState<number[]>([])
    const [chartOrgIds, setChartOrgIds] = useState<string[]>([])
    const [chartGroupIds, setChartGroupIds] = useState<string[]>([])
    const [chartBranchIds, setChartBranchIds] = useState<string[]>([])

    // ━━━ 3. REPORTS LOCAL STATE ━━━
    const [reportMonths, setReportMonths] = useState<number[]>([])
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportOrgIds, setReportOrgIds] = useState<string[]>([])
    const [reportGroupIds, setReportGroupIds] = useState<string[]>([])
    const [reportBranchIds, setReportBranchIds] = useState<string[]>([])

    const lastSyncedMonths = useRef<number[]>([])
    const lastSyncedYears = useRef<number[]>([])
    const lastSyncedBranchIds = useRef<string[]>([])

    useEffect(() => {
        const hasGlobalChanged = JSON.stringify(selectedMonths) !== JSON.stringify(lastSyncedMonths.current)
        if (hasGlobalChanged) {
            setChartMonths([...selectedMonths])
            setReportMonths([...selectedMonths])
            lastSyncedMonths.current = [...selectedMonths]
        }
    }, [selectedMonths])

    useEffect(() => {
        const hasGlobalChanged = JSON.stringify(selectedYears) !== JSON.stringify(lastSyncedYears.current)
        if (hasGlobalChanged) {
            setChartYears([...selectedYears])
            setReportYears([...selectedYears])
            lastSyncedYears.current = [...selectedYears]
        }
    }, [selectedYears])

    // ━━━ SMART SYNC (Global to Local) ━━━
    useEffect(() => {
        // Clearing the global selection is a change like any other: without
        // propagating the empty list the tabs stay pinned to the branch the
        // user just deselected.
        const hasGlobalChanged = JSON.stringify(contextBranchIds) !== JSON.stringify(lastSyncedBranchIds.current)
        if (hasGlobalChanged) {
            setChartBranchIds([...contextBranchIds])
            setReportBranchIds([...contextBranchIds])
            lastSyncedBranchIds.current = [...contextBranchIds]
        }
    }, [contextBranchIds])

    const { visibleKeys, isVisible, setVisibleKeys } = useColumnSelector(ALL_COLUMNS, "order-report-v2")

    // ━━━ DATA FETCHING (3-TIER) ━━━

    // Tier 1: Global Summary
    const globalParams = new URLSearchParams()

    // Security Isolation: Force branch/org if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (userOrgId) globalParams.set("organizationId", String(userOrgId))
        if (adminBranchId) globalParams.set("branchIds", String(adminBranchId))
    } else {
        // The KPI cards answer the same question the sticky-header branch
        // selector asks, so they carry the global branch scope too. Without it
        // they report organization-wide totals beside branch-scoped charts.
        if (organizationId) globalParams.set("organizationId", organizationId.toString())
        if (contextBranchIds.length > 0) globalParams.set("branchIds", contextBranchIds.join(","))
    }

    if (dateRange?.startDate) globalParams.set("startDate", dateRange.startDate.toISOString())
    if (dateRange?.endDate) globalParams.set("endDate", dateRange.endDate.toISOString())
    if (selectedMonths.length) globalParams.set("months", selectedMonths.join(","))
    if (selectedYears.length) globalParams.set("years", selectedYears.join(","))
    if (compare) {
        globalParams.set("compare", "true")
        if (compareRange?.startDate) globalParams.set("compareStartDate", compareRange.startDate.toISOString())
        if (compareRange?.endDate) globalParams.set("compareEndDate", compareRange.endDate.toISOString())
        if (compareMonths.length) globalParams.set("compareMonths", compareMonths.join(","))
        if (compareYears.length) globalParams.set("compareYears", compareYears.join(","))
    }
    // Fetches are deferred until the org/branch context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: globalData, isLoading: isGlobalLoading, mutate: mutateGlobal } = useSWR(
        isInitialized ? `/api/v1/analytics/summary?${globalParams.toString()}&summaryOnly=true` : null, fetcher,
        { keepPreviousData: true }
    )

    // Tier 2: Chart/Trend Data
    const chartParams = new URLSearchParams()

    // Security Isolation: Force branch/org if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (userOrgId) chartParams.set("organizationId", String(userOrgId))
        if (adminBranchId) chartParams.set("branchIds", String(adminBranchId))
    } else {
        if (chartOrgIds.length > 0) chartParams.set("organizationIds", chartOrgIds.join(","))
        else if (organizationId) chartParams.set("organizationId", organizationId.toString())
        if (chartBranchIds.length > 0) chartParams.set("branchIds", chartBranchIds.join(","))
    }

    if (chartGroupIds.length > 0) chartParams.set("groupIds", chartGroupIds.join(","))
    if (chartMonths.length > 0) chartParams.set("months", chartMonths.join(","))
    if (chartYears.length > 0) chartParams.set("years", chartYears.join(","))
    if (compare) chartParams.set("compare", "true")
    const { data: chartData, isLoading: isChartLoading, mutate: mutateChart } = useSWR(
        isInitialized ? `/api/v1/analytics/summary?${chartParams.toString()}&trendOnly=true` : null, fetcher,
        { keepPreviousData: true }
    )

    // Tier 3: Report Table Data
    const reportParams = new URLSearchParams()

    // Security Isolation: Force branch/org if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (userOrgId) reportParams.set("organizationId", String(userOrgId))
        if (adminBranchId) reportParams.set("branchIds", String(adminBranchId))
    } else {
        if (reportOrgIds.length > 0) reportParams.set("organizationIds", reportOrgIds.join(","))
        else if (organizationId) reportParams.set("organizationId", organizationId.toString())
        if (reportBranchIds.length > 0) reportParams.set("branchIds", reportBranchIds.join(","))
    }

    if (reportGroupIds.length > 0) reportParams.set("groupIds", reportGroupIds.join(","))
    if (dateRange?.startDate) reportParams.set("startDate", dateRange.startDate.toISOString())
    if (dateRange?.endDate) reportParams.set("endDate", dateRange.endDate.toISOString())
    if (reportMonths.length > 0) reportParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportParams.set("years", reportYears.join(","))
    if (statusFilter !== "all") reportParams.set("status", statusFilter)
    if (statusFilter === "fulfilled" && paymentStatusFilter) reportParams.set("paymentStatus", paymentStatusFilter)
    if (debouncedReportSearch) reportParams.set("q", debouncedReportSearch)
    if (showsGroupOrders && debouncedGroupOrderFilter) {
        reportParams.set("groupOrderRef", debouncedGroupOrderFilter)
    }
    reportParams.set("page", currentPage.toString())
    reportParams.set("limit", ORDER_REPORT_PAGE_SIZE.toString())
    appendSortParams(reportParams, reportSort)
    reportParams.set("ordersOnly", "true")
    const { data: reportData, isLoading: isReportLoading, isValidating: isReportValidating, mutate: mutateReport } = useSWR(
        isInitialized ? `/api/v1/analytics/summary?${reportParams.toString()}` : null, fetcher,
        { keepPreviousData: true }
    )

    // All-time Data (for year ranges)
    const { data: allTimeData } = useSWR(isInitialized && organizationId ? `/api/v1/analytics/summary?organizationId=${organizationId}&allTime=true` : null, fetcher)

    useEffect(() => {
        setHasMounted(true)
        setGeneratedDate(new Date().toLocaleString())
    }, [])

    const handleDateChange = useCallback(({ range, preset, compare: c, compareRange: cr, months: m, years: y, compareMonths: cm, compareYears: cy }: GlobalDateFilterChange) => {
        setDateRange(range)
        setActivePreset(preset)
        if (c !== undefined) setCompare(c)
        if (cr !== undefined) setCompareRange(cr)
        if (m !== undefined) setSelectedMonths(m)
        if (y !== undefined) setSelectedYears(y)
        if (cm !== undefined) setCompareMonths(cm)
        if (cy !== undefined) setCompareYears(cy)
    }, [])

    const resetGlobalDateFilter = useCallback(() => {
        setDateRange(null)
        setActivePreset("all")
        setCompare(false)
        setCompareRange(null)
        setSelectedMonths([])
        setSelectedYears([])
        setCompareMonths([])
        setCompareYears([])
        void mutateGlobal()
        void mutateChart()
        void mutateReport()
    }, [mutateGlobal, mutateChart, mutateReport])


    const resetReportFilters = useCallback(() => {
        setStatusFilter("all")
        setPaymentStatusFilter(null)
        setReportSearch("")
        setGroupOrderFilter("")
        setReportMonths([])
        setReportYears([])
        setReportOrgIds([])
        setReportGroupIds([])
        setReportBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        setCurrentPage(1)
        setDateRange(null)
        setActivePreset("all")
        setSelectedMonths([])
        setSelectedYears([])
        void mutateReport()
    }, [contextBranchIds, mutateReport])

    const resetChartFilters = useCallback(() => {
        setChartMonths([])
        setChartYears([])
        setChartOrgIds([])
        setChartGroupIds([])
        setChartBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        void mutateChart()
    }, [contextBranchIds, mutateChart])

    // ━━━ DATA PROCESSING ━━━
    const summary = globalData?.summary || { totalSales: 0, totalRefunds: 0, totalTax: 0, totalSubtotal: 0, orderCount: 0, totalOrderCount: 0 }
    const chartOrders = useMemo(() => chartData?.orders || [], [chartData?.orders])
    const reportOrders = useMemo(() => reportData?.orders || [], [reportData?.orders])
    const totalReportOrders = Number(reportData?.pagination?.total || 0)
    const totalReportPages = Math.max(
        1,
        Number(reportData?.pagination?.totalPages) || Math.ceil(totalReportOrders / ORDER_REPORT_PAGE_SIZE),
    )
    const firstVisibleOrder = totalReportOrders === 0 ? 0 : (currentPage - 1) * ORDER_REPORT_PAGE_SIZE + 1

    const filteredOrders = useMemo(() => {
        return reportOrders.filter((order: any) => {
            const matchesSearch = !reportSearch ||
                (order.tid?.toLowerCase().includes(reportSearch.toLowerCase())) ||
                (order.userName?.toLowerCase().includes(reportSearch.toLowerCase())) ||
                (order.employeeId && String(order.employeeId).toLowerCase().includes(reportSearch.toLowerCase())) ||
                (order.userId?.toLowerCase().includes(reportSearch.toLowerCase()))
            const matchesStatus = statusFilter === 'all' || order.status?.toLowerCase() === statusFilter.toLowerCase();
            const matchesPaymentStatus = paymentStatusFilter === null || order.paymentStatus === paymentStatusFilter
            return matchesSearch && matchesStatus && matchesPaymentStatus;
        })
    }, [reportOrders, reportSearch, statusFilter, paymentStatusFilter])
    const lastVisibleOrder = Math.min(
        (currentPage - 1) * ORDER_REPORT_PAGE_SIZE + filteredOrders.length,
        totalReportOrders,
    )

    useEffect(() => {
        setCurrentPage(1)
    }, [debouncedReportSearch, statusFilter, paymentStatusFilter, dateRange, reportMonths, reportYears, reportOrgIds, reportGroupIds, reportBranchIds, organizationId, contextBranchId])

    useEffect(() => {
        if (statusFilter !== "fulfilled" && paymentStatusFilter !== null) setPaymentStatusFilter(null)
    }, [paymentStatusFilter, statusFilter])

    useEffect(() => {
        if (reportData?.pagination && currentPage > totalReportPages) {
            setCurrentPage(totalReportPages)
        }
    }, [currentPage, reportData?.pagination, totalReportPages])

    // ━━━ CHART TREND DATA: Normalized X-Axis ━━━
    const chartTrendData = useMemo(() => {
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

        // Use backend aggregated trend if available (covers ALL orders in period)
        if (chartData?.trend?.length > 0) {
            const activeYear = chartYears.length === 1 ? chartYears[0] : new Date().getFullYear()
            const monthsToShow = chartMonths.length > 0 && chartMonths.length < 12
                ? [...chartMonths].sort((a, b) => a - b)
                : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

            return monthsToShow.map(m => {
                const dataPoint = chartData.trend.find((t: any) => Number(t.month) === m && (chartYears.length > 1 || Number(t.year) === activeYear))
                return {
                    label: monthNames[m - 1],
                    revenue: dataPoint ? Math.round(dataPoint.revenue / 100) : 0,
                    orders: dataPoint ? Number(dataPoint.orders) : 0,
                    prevRevenue: 0, // Comparison support could be added here later
                    prevOrders: 0
                }
            })
        }

        // --- FALLBACK: Client-side calculation (limited to current page/chartOrders) ---
        const trend = (chartOrders || []).filter((o: any) =>
            ['FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes((o.status || "").toUpperCase())
        )
        const currentYear = new Date().getFullYear()

        // Case A: Multiple years -> Show Years on X-Axis
        if (chartYears.length > 1) {
            return chartYears.toSorted((a, b) => a - b).map(year => {
                const yearOrders = trend.filter((o: any) => new Date(o.createdAt || o.orderDate).getFullYear() === year)
                const compOrders = (chartData?.comparisonOrders || []).filter((o: any) =>
                    ['FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes((o.status || "").toUpperCase()) &&
                    new Date(o.createdAt || o.orderDate).getFullYear() === year
                )

                return {
                    label: String(year),
                    revenue: Math.round(yearOrders.reduce((sum: number, o: any) => sum + (o.totalCents - (o.refundAmountCents || 0)) / 100, 0)),
                    orders: yearOrders.length,
                    prevRevenue: Math.round(compOrders.reduce((sum: number, o: any) => sum + (o.totalCents - (o.refundAmountCents || 0)) / 100, 0)),
                    prevOrders: compOrders.length
                }
            })
        }

        // Case B: Single year (or default) -> Show Months on X-Axis
        const activeYearForFallback = chartYears.length === 1 ? chartYears[0] : currentYear
        const monthsToShowForFallback = chartMonths.length > 0 && chartMonths.length < 12
            ? [...chartMonths].sort((a, b) => a - b)
            : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

        return monthsToShowForFallback.map(m => {
            const monthOrders = trend.filter((o: any) => {
                const d = new Date(o.createdAt || o.orderDate)
                return d.getFullYear() === activeYearForFallback && (d.getMonth() + 1) === m
            })
            const compOrders = (chartData?.comparisonOrders || []).filter((o: any) => {
                const d = new Date(o.createdAt || o.orderDate)
                return ['FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes((o.status || "").toUpperCase()) &&
                    d.getFullYear() === activeYearForFallback && (d.getMonth() + 1) === m
            })

            return {
                label: monthNames[m - 1],
                revenue: Math.round(monthOrders.reduce((sum: number, o: any) => sum + (o.totalCents - (o.refundAmountCents || 0)) / 100, 0)),
                orders: monthOrders.length,
                prevRevenue: Math.round(compOrders.reduce((sum: number, o: any) => sum + (o.totalCents - (o.refundAmountCents || 0)) / 100, 0)),
                prevOrders: compOrders.length
            }
        })
    }, [chartOrders, chartData, chartMonths, chartYears])

    interface StatusChartItem {
        name: string
        value: number
        fill: string
    }

    // Status breakdown for Donut
    const statusChartData = useMemo<StatusChartItem[]>(() => {
        const dist = chartData?.statusDistribution || []
        if (dist.length > 0) {
            return dist.map((d: any) => ({
                name: d.name,
                value: Number(d.value),
                fill: STATUS_COLORS[d.name] || "#94a3b8"
            }))
        }

        // Fallback for legacy or edge cases
        if (!chartOrders.length) return []
        const counts: Record<string, number> = {}
        chartOrders.forEach((o: any) => {
            const s = (o.status || "UNKNOWN").toUpperCase()
            counts[s] = (counts[s] || 0) + 1
        })
        return Object.entries(counts).map(([name, value]) => ({ name, value, fill: STATUS_COLORS[name] || "#94a3b8" }))
    }, [chartData, chartOrders])

    const fetchAllReportOrders = async () => {
        const exportParams = new URLSearchParams(reportParams)
        const activeSearch = reportSearch.trim()
        if (activeSearch) exportParams.set("q", activeSearch)
        else exportParams.delete("q")
        exportParams.set("page", "1")
        exportParams.set("limit", "100")

        const fetchPage = async (page: number) => {
            const pageParams = new URLSearchParams(exportParams)
            pageParams.set("page", page.toString())
            const response = await fetch(`/api/v1/analytics/summary?${pageParams.toString()}`)
            if (!response.ok) throw new Error(`Export request failed (${response.status})`)
            const data = await response.json()
            if (data?.error) throw new Error(data.error)
            return data
        }

        const firstPage = await fetchPage(1)
        const allOrders = [...(firstPage?.orders || [])]
        const totalPages = Math.max(1, Number(firstPage?.pagination?.totalPages) || 1)
        const exportConcurrency = 4

        for (let page = 2; page <= totalPages; page += exportConcurrency) {
            const pageNumbers = Array.from(
                { length: Math.min(exportConcurrency, totalPages - page + 1) },
                (_, index) => page + index,
            )
            const pageResults = await Promise.all(pageNumbers.map(fetchPage))
            pageResults.forEach((data) => allOrders.push(...(data?.orders || [])))
        }

        return allOrders
    }

    const handleExport = async (format: 'csv' | 'excel' | 'pdf') => {
        if (isExporting) return
        setIsExporting(true)

        try {
            const exportOrders = await fetchAllReportOrders()
            if (exportOrders.length === 0) {
                toast({ title: "No orders to export", description: "No orders match the active report filters." })
                return
            }

            // The download is a fixed document, not a snapshot of the toggled
            // table: the same columns in the same order every time, so two
            // exports taken weeks apart line up. Only the money columns vary,
            // and only where price visibility has already withheld them.
            const exportLayoutOptions = { pricesHidden, isBuyer }
            const headers = resolveOrderReportExportHeaders(exportLayoutOptions)

            // Map every filtered API page, not just the currently visible table page.
            const rows = buildOrderReportExportRows(exportOrders, exportLayoutOptions)

            if (format === 'pdf') {
                const doc = new jsPDF('landscape')
                doc.setFontSize(20); doc.text(exportTitleLabel, 14, 20)
                doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
                autoTable(doc, { startY: 40, head: [headers], body: rows, theme: 'grid', styles: { fontSize: 8 } })
                doc.save(`order-report-${Date.now()}.pdf`)
                return
            }

            const ws = XLSX.utils.aoa_to_sheet([
                sanitizeSpreadsheetRow(headers),
                ...rows.map(sanitizeSpreadsheetRow),
            ])
            const wb = XLSX.utils.book_new()
            XLSX.utils.book_append_sheet(wb, ws, "Orders")
            XLSX.writeFile(wb, `order-report-${Date.now()}.${format === 'excel' ? 'xlsx' : 'csv'}`)
        } catch (error) {
            console.error("Order report export failed", error)
            toast({
                title: "Export failed",
                description: error instanceof Error ? error.message : "Unable to export the filtered orders.",
                variant: "destructive",
            })
        } finally {
            setIsExporting(false)
        }
    }

    const pricesHidden = Boolean((globalData as any)?.pricesHidden || (chartData as any)?.pricesHidden || (reportData as any)?.pricesHidden)
    const priceVisibilityKnown = [globalData, chartData, reportData].some((data: any) => typeof data?.pricesHidden === "boolean")
    const isPriceVisibilityPending = role === "BRANCH_ADMIN" && !priceVisibilityKnown
    // Mirrors the <colgroup> below, so an expanded row spans exactly the shown columns.
    const visibleReportColumnCount = [
        isVisible("tid"),
        isVisible("orderDate"),
        isVisible("userName"),
        isVisible("employeeId"),
        isVisible("organizationName") && role === "SUPER_ADMIN",
        isVisible("group") && role !== "BRANCH_ADMIN",
        isVisible("groupOrderReference") && showsGroupOrders,
        isVisible("branchName") && role !== "BRANCH_ADMIN",
        isVisible("status"),
        isVisible("deliveryStatus"),
        isVisible("paymentStatus"),
        isVisible("approvalLevel"),
        isVisible("financialApproverLevel"),
        isVisible("approver"),
        isVisible("quantityOrdered"),
        isVisible("quantityDelivered"),
        isVisible("quantityRefunded"),
        !pricesHidden && isVisible("subtotalValue"),
        !pricesHidden && isVisible("refundValue"),
        !pricesHidden && isVisible("netTotalValue"),
    ].filter(Boolean).length

    if (!hasMounted || sessionStatus === "loading" || isPriceVisibilityPending) return <div className="flex h-[50vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-indigo-400" /></div>

    return (
        <div className="min-h-screen min-w-0 overflow-x-hidden bg-[#f8fafc] dark:bg-[#020617] transition-colors duration-500 pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-40 w-full backdrop-blur-3xl bg-white/70 dark:bg-slate-950/70 border-b border-slate-200/60 dark:border-slate-800/60 shadow-[0_1px_20px_rgba(0,0,0,0.02)] transition-all duration-500">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-6">
                    <div className="flex items-center gap-5 group cursor-default">
                        <div className="relative">
                            <div className="absolute -inset-1 bg-gradient-to-tr from-indigo-500 to-blue-600 rounded-2xl blur opacity-20 group-hover:opacity-40 transition duration-500"></div>
                            <div className="relative h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-700 flex items-center justify-center shadow-indigo-500/20 group-hover:rotate-6 transition-all duration-500 ease-out">
                                <TrendingUp className="h-6 w-6 text-white" />
                            </div>
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tighter text-slate-900 dark:text-white uppercase leading-none mb-1">Order Intelligence</h1>
                            <div className="flex items-center gap-1.5 h-4">
                                <div className="h-1 w-1 rounded-full bg-indigo-500 animate-pulse" />
                                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Audit & Analytics Terminal</p>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="hidden lg:flex items-center gap-2 p-1.5 bg-slate-100 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner">
                            <GlobalDateFilter
                                value={dateRange}
                                onChange={handleDateChange}
                                activePreset={activePreset}
                                hidePresets={false}
                                compare={compare}
                                compareRange={compareRange}
                                months={selectedMonths}
                                years={selectedYears}
                                compareMonths={compareMonths}
                                compareYears={compareYears}
                            />
                        </div>
                        {role !== "BRANCH_ADMIN" && organizationId && (
                            <>
                                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
                                <MultiBranchFilter organizationId={organizationId} selectedBranchIds={contextBranchIds} onChange={setContextBranchIds} />
                            </>
                        )}
                        <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-indigo-500 transition-colors" onClick={resetGlobalDateFilter}>
                            <RefreshCw className={cn("h-4 w-4", (isGlobalLoading || isChartLoading || isReportLoading) && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="w-full min-w-0 max-w-[1600px] mx-auto px-6 pt-10 space-y-10">
                {/* ━━━ KPI BENTO GRID ━━━ */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {!pricesHidden && (
                        <div className="hover:scale-[1.02] transition-all duration-500">
                            <KPICard title={kpiRevenueLabel} value={formatPKR(summary.totalSales / 100)} icon={TrendingUp} colorScheme="indigo" isLoading={!globalData} />
                        </div>
                    )}
                    <div className="hover:scale-[1.02] transition-all duration-500">
                        <KPICard title={pricesHidden ? "Items Ordered" : "Refund Impact"} value={pricesHidden ? Number(summary.totalItemsSold || 0).toLocaleString() : formatPKR(summary.totalRefunds / 100)} icon={RotateCcw} colorScheme="rose" isLoading={!globalData} />
                    </div>
                    <div className="hover:scale-[1.02] transition-all duration-500">
                        <KPICard title="Total Orders" value={summary.totalOrderCount} icon={Package} colorScheme="blue" isLoading={!globalData} />
                    </div>
                    {!pricesHidden && (
                        <div className="hover:scale-[1.02] transition-all duration-500">
                            <KPICard title={kpiAvgLabel} value={formatPKR(summary.orderCount > 0 ? (summary.totalSales / summary.orderCount) / 100 : 0)} icon={Calculator} colorScheme="amber" isLoading={!globalData} />
                        </div>
                    )}
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">

                    <div className="flex items-center justify-between gap-4 border-b border-slate-200/60 dark:border-slate-800/60 pb-1">
                        <TabsList className="bg-transparent h-auto p-0 gap-10">
                            <TabsTrigger
                                value="analytics"
                                className="group relative bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-[0.15em] text-slate-400 data-[state=active]:text-indigo-600 dark:data-[state=active]:text-indigo-400 transition-all"
                            >
                                <div className="flex items-center gap-2">
                                    <LayoutDashboard className="h-4 w-4 transition-transform group-hover:-translate-y-0.5" />
                                    Analytics
                                </div>
                            </TabsTrigger>
                            <TabsTrigger
                                value="reports"
                                className="group relative bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-[0.15em] text-slate-400 data-[state=active]:text-indigo-600 dark:data-[state=active]:text-indigo-400 transition-all"
                            >
                                <div className="flex items-center gap-2">
                                    <Database className="h-4 w-4 transition-transform group-hover:-translate-y-0.5" />
                                    Reports
                                </div>
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="analytics" className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                            {/* Main Trend Chart */}
                            <Card className="lg:col-span-2 rounded-[2rem] border-slate-200 dark:border-slate-800 shadow-xl bg-white/50 dark:bg-slate-900/40 backdrop-blur-xl overflow-hidden">
                                <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4">
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500">
                                            <TrendingUp className="h-4 w-4" />
                                        </div>
                                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">Order Velocity</h3>
                                    </div>
                                    <div className="flex max-w-full flex-wrap items-center justify-center gap-2">
                                        <MonthFilter selected={chartMonths} onChange={setChartMonths} />
                                        <YearFilter selected={chartYears} onChange={setChartYears} allTimeData={allTimeData} />
                                        {role === "SUPER_ADMIN" && (
                                            <OrganizationFilter selectedIds={chartOrgIds} onChange={setChartOrgIds} />
                                        )}
                                        {((role === "SUPER_ADMIN" && (chartOrgIds.length > 0 || organizationId)) || (role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && organizationId)) && (
                                            <>
                                                <GroupFilter
                                                    selectedIds={chartGroupIds}
                                                    onChange={setChartGroupIds}
                                                    organizationIds={(() => {
                                                      if (chartOrgIds.length > 0) {
                                                        return chartOrgIds
                                                      }
                                                      return (organizationId ? [String(organizationId)] : [])
                                                    })()}
                                                    disabled={chartBranchIds.length > 0}
                                                />
                                                <BranchFilter
                                                    selectedIds={chartBranchIds}
                                                    onChange={setChartBranchIds}
                                                    organizationIds={(() => {
                                                      if (chartOrgIds.length > 0) {
                                                        return chartOrgIds
                                                      }
                                                      return (organizationId ? [organizationId] : [])
                                                    })()}
                                                    groupIds={chartGroupIds}
                                                />
                                            </>
                                        )}
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={resetChartFilters}
                                            className="h-10 w-10 p-0 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm"
                                            aria-label="Reset analytics filters"
                                            title="Reset analytics filters"
                                        >
                                            <RefreshCw className={cn("h-3.5 w-3.5 text-slate-400", isChartLoading && "animate-spin")} />
                                        </Button>
                                    </div>
                                </div>
                                <div className="p-8 h-[400px]">
                                    {(() => {
                                      if (isChartLoading) {
                                        return (
                                        <div className="h-full flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-indigo-500/20" /></div>
                                    )
                                      }
                                      return (
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={chartTrendData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                                                <defs>
                                                    <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                                                        <stop offset="95%" stopColor="#6366f1" stopOpacity={0.05} />
                                                    </linearGradient>
                                                    <linearGradient id="ordersGradient" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} />
                                                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.5} />
                                                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 700, fill: '#64748b' }} dy={10} />
                                                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fontWeight: 600, fill: '#64748b' }} tickFormatter={(v) => `₨${v / 1000}k`} />
                                                <RechartsTooltip content={<BarTooltip compare={compare} revenueLabel={chartRevenueLabel} pricesHidden={pricesHidden} />} cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }} />
                                                <Bar dataKey={pricesHidden ? "orders" : "revenue"} fill="url(#revGradient)" radius={[6, 6, 0, 0]} barSize={32} name={pricesHidden ? "Orders" : `Current ${chartRevenueLabel}`} />
                                                {compare && <Bar dataKey="prevRevenue" fill="#94a3b8" opacity={0.3} radius={[6, 6, 0, 0]} barSize={32} name={`Prior ${chartRevenueLabel}`} />}
                                                <Line type="monotone" dataKey="orders" stroke="#10b981" strokeWidth={3} dot={{ r: 4, fill: '#10b981', strokeWidth: 2, stroke: '#fff' }} name={chartOrdersLabel} />
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    )
                                    })()}
                                </div>
                            </Card>

                            {/* Status Distribution */}
                            <Card className="rounded-[2rem] border-slate-200 dark:border-slate-800 shadow-xl bg-white/50 dark:bg-slate-900/40 backdrop-blur-xl overflow-hidden">
                                <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                                    <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500">
                                        <Layers className="h-4 w-4" />
                                    </div>
                                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">Status Mix</h3>
                                </div>
                                <div className="p-8 h-[400px] flex flex-col justify-center relative">
                                    <ResponsiveContainer width="100%" height={250}>
                                        <PieChart>
                                            <Pie
                                                data={statusChartData}
                                                cx="50%"
                                                cy="50%"
                                                innerRadius={70}
                                                outerRadius={90}
                                                paddingAngle={8}
                                                dataKey="value"
                                                stroke="none"
                                            >
                                                {statusChartData.map((entry, index) => (
                                                    <Cell
                                                        key={entry.name}
                                                        fill={entry.fill}
                                                        style={{ filter: `drop-shadow(0 0 8px ${entry.fill}40)` }}
                                                    />
                                                ))}
                                            </Pie>
                                            <RechartsTooltip
                                                content={<StatusMixTooltip />}
                                            />
                                        </PieChart>
                                    </ResponsiveContainer>
                                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -mt-10 text-center pointer-events-none">
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Total</p>
                                        <p className="text-2xl font-black text-slate-900 dark:text-white leading-none">{statusChartData.reduce((sum, s) => sum + s.value, 0).toLocaleString()}</p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3 mt-6">
                                        {statusChartData.map((s) => (
                                            <div key={s.name} className="flex items-center gap-2">
                                                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: s.fill }} />
                                                <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">{s.name}</span>
                                                <span className="text-[10px] font-black ml-auto">{s.value}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value="reports" className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
                        {/* Report Controls */}
                        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-6 bg-white dark:bg-slate-900/40 p-5 rounded-[2.5rem] border border-slate-200/60 dark:border-slate-800/60 shadow-sm backdrop-blur-xl">
                            <div className="flex flex-wrap items-center gap-2.5 p-1 bg-slate-50 dark:bg-slate-950/50 rounded-[1.25rem] border border-slate-100 dark:border-slate-800/50">
                                <button type="button" onClick={() => { setStatusFilter("all"); setPaymentStatusFilter(null) }} className={cn("px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300", statusFilter === "all" ? "bg-white dark:bg-slate-800 text-indigo-600 shadow-md ring-1 ring-slate-200 dark:ring-slate-700" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>All</button>
                                <button type="button" onClick={() => { setStatusFilter("pending"); setPaymentStatusFilter(null) }} className={cn("px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300", statusFilter === "pending" ? "bg-white dark:bg-slate-800 text-slate-700 shadow-md ring-1 ring-slate-200 dark:ring-slate-700" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>Pending Approval</button>
                                <button type="button" onClick={() => { setStatusFilter("approved"); setPaymentStatusFilter(null) }} className={cn("px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300", statusFilter === "approved" ? "bg-blue-500 text-white shadow-lg shadow-blue-500/20" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>Active</button>
                                <button type="button" onClick={() => setStatusFilter("fulfilled")} className={cn("px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300", statusFilter === "fulfilled" ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>Fulfilled</button>
                                <button type="button" onClick={() => { setStatusFilter("refunded"); setPaymentStatusFilter(null) }} className={cn("px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all duration-300", statusFilter === "refunded" ? "bg-rose-500 text-white shadow-lg shadow-rose-500/20" : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200")}>Refunds</button>
                            </div>
                            {statusFilter === "fulfilled" && (
                                <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-800 dark:bg-slate-950/50" role="group" aria-label="Filter fulfilled orders by payment status">
                                    {([null, "PAID", "UNPAID"] as const).map((nextPaymentStatus) => (
                                        <Button key={nextPaymentStatus ?? "all"} type="button" size="sm" variant={paymentStatusFilter === nextPaymentStatus ? "secondary" : "ghost"} aria-pressed={paymentStatusFilter === nextPaymentStatus} onClick={() => setPaymentStatusFilter(nextPaymentStatus)} className="h-8 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest">
                                            {nextPaymentStatus ? PAYMENT_STATUS_LABELS[nextPaymentStatus] : "All payments"}
                                        </Button>
                                    ))}
                                </div>
                            )}
                            <div className="flex flex-wrap items-center gap-3">
                                <div className="relative group/search">
                                    <div className="absolute inset-0 bg-indigo-500/5 rounded-2xl blur-md opacity-0 group-focus-within/search:opacity-100 transition-opacity"></div>
                                    <div className="relative">
                                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within/search:text-indigo-500 transition-colors" />
                                        <Input
                                            placeholder="Search Transaction..."
                                            className="pl-11 h-11 w-[280px] bg-slate-100 dark:bg-slate-800/80 border-transparent rounded-2xl text-[11px] font-bold placeholder:text-slate-400 focus-visible:bg-white dark:focus-visible:bg-slate-900 focus-visible:ring-2 focus-visible:ring-indigo-500/20 focus-visible:border-indigo-500/30 transition-all"
                                            value={reportSearch}
                                            onChange={(e) => setReportSearch(e.target.value)}
                                        />
                                    </div>
                                </div>
                                <div className="h-8 w-px bg-slate-200 dark:bg-slate-800 mx-1" />
                                <GlobalDateFilter
                                    value={dateRange}
                                    onChange={(change) => {
                                        handleDateChange(change)
                                        setReportMonths(change.months ?? [])
                                        setReportYears(change.years ?? [])
                                    }}
                                    activePreset={activePreset}
                                    customRangeOnly
                                    compare={compare}
                                    compareRange={compareRange}
                                    months={selectedMonths}
                                    years={selectedYears}
                                    compareMonths={compareMonths}
                                    compareYears={compareYears}
                                />
                                <MonthFilter selected={reportMonths} onChange={setReportMonths} />
                                <YearFilter selected={reportYears} onChange={setReportYears} allTimeData={allTimeData} />
                                {role === "SUPER_ADMIN" && (
                                    <>
                                        <OrganizationFilter
                                            selectedIds={reportOrgIds}
                                            onChange={(ids: string[]) => {
                                                setReportOrgIds(ids)
                                                setReportGroupIds([])
                                                setReportBranchIds([])
                                            }}
                                        />
                                        <GroupFilter
                                            selectedIds={reportGroupIds}
                                            onChange={(ids: string[]) => {
                                                setReportGroupIds(ids)
                                                setReportBranchIds([])
                                            }}
                                            organizationIds={(() => {
                                              if (reportOrgIds.length > 0) {
                                                return reportOrgIds
                                              }
                                              return (organizationId ? [String(organizationId)] : undefined)
                                            })()}
                                            disabled={reportBranchIds.length > 0}
                                        />
                                        {(reportOrgIds.length > 0 || organizationId) && (
                                            <BranchFilter
                                                selectedIds={reportBranchIds}
                                                onChange={setReportBranchIds}
                                                organizationIds={(() => {
                                                  if (reportOrgIds.length > 0) {
                                                    return reportOrgIds
                                                  }
                                                  return (organizationId ? [organizationId] : [])
                                                })()}
                                                groupIds={reportGroupIds}
                                            />
                                        )}
                                    </>
                                )}
                                {role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && organizationId && (
                                    <>
                                        <GroupFilter
                                            selectedIds={reportGroupIds}
                                            onChange={setReportGroupIds}
                                            organizationIds={[String(organizationId)]}
                                            disabled={reportBranchIds.length > 0}
                                        />
                                        <BranchFilter
                                            selectedIds={reportBranchIds}
                                            onChange={setReportBranchIds}
                                            organizationIds={[organizationId]}
                                            groupIds={reportGroupIds}
                                        />
                                    </>
                                )}
                                {showsGroupOrders && (
                                    <div className="relative">
                                        <Layers className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                        <Input
                                            value={groupOrderFilter}
                                            onChange={(event) => {
                                                setGroupOrderFilter(event.target.value)
                                                setCurrentPage(1)
                                            }}
                                            placeholder="Group Order ID"
                                            aria-label="Filter by group order ID"
                                            className="h-11 w-48 rounded-xl border-slate-200 bg-white pl-9 text-[11px] font-bold shadow-sm dark:border-slate-800 dark:bg-slate-950"
                                        />
                                    </div>
                                )}
                                <ColumnSelector columns={ALL_COLUMNS} storageKey="order-report-v2" visibleKeys={visibleKeys} onChange={setVisibleKeys} />
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={resetReportFilters}
                                    className="h-11 w-11 p-0 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm"
                                    aria-label="Reset report filters"
                                    title="Reset report filters"
                                >
                                    <RotateCcw className="h-3.5 w-3.5 text-slate-500" />
                                </Button>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button disabled={isExporting || totalReportOrders === 0} variant="outline" size="sm" className="h-11 text-[11px] font-black underline decoration-slate-200 gap-2 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-sm px-5">
                                            {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                                            {isExporting ? "EXPORTING..." : "EXPORT"}
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-52 rounded-2xl border-slate-200 dark:border-slate-800 p-2 shadow-2xl bg-white dark:bg-slate-900">
                                        <DropdownMenuItem onClick={() => handleExport('csv')} className="text-xs font-bold py-3 cursor-pointer rounded-xl"><FileText className="mr-3 h-4 w-4 text-slate-400" /> CSV ARCHIVE</DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => handleExport('excel')} className="text-xs font-bold py-3 cursor-pointer rounded-xl"><FileSpreadsheet className="mr-3 h-4 w-4 text-emerald-500" /> EXCEL WORKBOOK</DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => handleExport('pdf')} className="text-xs font-bold py-3 cursor-pointer rounded-xl"><FileText className="mr-3 h-4 w-4 text-rose-500" /> PDF DOCUMENT</DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </div>

                        {/* Report Table */}
                        <Card className="min-w-0 rounded-[2.5rem] border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900/40 overflow-hidden min-h-[600px] flex flex-col">
                            <ReportTableScroll className="flex-1">
                                <Table className="min-w-[2100px] table-fixed">
                                    <colgroup>
                                        {isVisible("tid") && <col className="w-[185px]" />}
                                        {isVisible("orderDate") && <col className="w-[125px]" />}
                                        {isVisible("userName") && <col className="w-[150px]" />}
                                        {isVisible("employeeId") && <col className="w-[125px]" />}
                                        {isVisible("organizationName") && role === "SUPER_ADMIN" && <col className="w-[145px]" />}
                                        {isVisible("group") && role !== "BRANCH_ADMIN" && <col className="w-[155px]" />}
                                        {isVisible("groupOrderReference") && showsGroupOrders && <col className="w-[175px]" />}
                                        {isVisible("branchName") && role !== "BRANCH_ADMIN" && <col className="w-[180px]" />}
                                        {isVisible("status") && <col className="w-[135px]" />}
                                        {isVisible("deliveryStatus") && <col className="w-[140px]" />}
                                        {isVisible("paymentStatus") && <col className="w-[110px]" />}
                                        {isVisible("approvalLevel") && <col className="w-[110px]" />}
                                        {isVisible("financialApproverLevel") && <col className="w-[145px]" />}
                                        {isVisible("approver") && <col className="w-[190px]" />}
                                        {isVisible("quantityOrdered") && <col className="w-[90px]" />}
                                        {isVisible("quantityDelivered") && <col className="w-[90px]" />}
                                        {isVisible("quantityRefunded") && <col className="w-[90px]" />}
                                        {!pricesHidden && isVisible("subtotalValue") && <col className="w-[135px]" />}
                                        {!pricesHidden && isVisible("refundValue") && <col className="w-[130px]" />}
                                        {!pricesHidden && isVisible("netTotalValue") && <col className="w-[155px]" />}
                                    </colgroup>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800 hover:bg-transparent">
                                            {isVisible("tid") && (
                                                <TableHead aria-sort={ariaSortFor(reportSort, "tid")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-50/100 dark:bg-slate-900/100 border-r border-slate-200/60 dark:border-slate-800/60">
                                                    {sortHead("tid", (
                                                        <span className="flex min-w-0 items-center gap-1.5">
                                                            <Hash className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                                                            <span>Transaction ID</span>
                                                        </span>
                                                    ))}
                                                </TableHead>
                                            )}
                                            {isVisible("orderDate") && <TableHead aria-sort={ariaSortFor(reportSort, "orderDate")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("orderDate", <span className="flex items-center gap-1.5"><Calendar className="h-3 w-3 shrink-0" /> Date</span>)}</TableHead>}
                                            {isVisible("userName") && <TableHead aria-sort={ariaSortFor(reportSort, "userName")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("userName", "User")}</TableHead>}
                                            {isVisible("employeeId") && <TableHead aria-sort={ariaSortFor(reportSort, "employeeId")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("employeeId", "Employee #")}</TableHead>}
                                            {isVisible("organizationName") && role === "SUPER_ADMIN" && <TableHead aria-sort={ariaSortFor(reportSort, "organizationName")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("organizationName", "Org")}</TableHead>}
                                            {isVisible("group") && role !== "BRANCH_ADMIN" && <TableHead aria-sort={ariaSortFor(reportSort, "group")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("group", "Group")}</TableHead>}
                                            {isVisible("groupOrderReference") && showsGroupOrders && <TableHead aria-sort={ariaSortFor(reportSort, "groupOrderReference")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("groupOrderReference", <span className="flex items-center gap-1.5"><Layers className="h-3 w-3 shrink-0" /> Group Order</span>)}</TableHead>}
                                            {isVisible("branchName") && role !== "BRANCH_ADMIN" && <TableHead aria-sort={ariaSortFor(reportSort, "branchName")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("branchName", <span className="flex items-center gap-1.5"><Store className="h-3 w-3 shrink-0" /> Branch</span>)}</TableHead>}
                                            {isVisible("status") && <TableHead aria-sort={ariaSortFor(reportSort, "status")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center">{sortHead("status", "Status")}</TableHead>}
                                            {isVisible("deliveryStatus") && <TableHead aria-sort={ariaSortFor(reportSort, "deliveryStatus")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center">{sortHead("deliveryStatus", "Delivery")}</TableHead>}
                                            {isVisible("paymentStatus") && <TableHead aria-sort={ariaSortFor(reportSort, "paymentStatus")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500 text-center">{sortHead("paymentStatus", "Payment")}</TableHead>}
                                            {isVisible("approvalLevel") && <TableHead aria-sort={ariaSortFor(reportSort, "approvalLevel")} className="h-14 px-2 text-center text-[9px] font-black uppercase leading-tight tracking-wide text-slate-500 whitespace-normal">{sortHead("approvalLevel", "Approval Level")}</TableHead>}
                                            {isVisible("financialApproverLevel") && <TableHead aria-sort={ariaSortFor(reportSort, "financialApproverLevel")} className="h-14 px-2 text-center text-[9px] font-black uppercase leading-tight tracking-wide text-slate-500 whitespace-normal">{sortHead("financialApproverLevel", "Financial Approver Level")}</TableHead>}
                                            {isVisible("approver") && <TableHead aria-sort={ariaSortFor(reportSort, "approver")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">{sortHead("approver", "Approver")}</TableHead>}
                                            {isVisible("quantityOrdered") && <TableHead aria-sort={ariaSortFor(reportSort, "quantityOrdered")} className="h-14 px-2 text-center text-[9px] font-black uppercase leading-tight tracking-wide text-slate-500 whitespace-normal">{sortHead("quantityOrdered", "Qty Ordered")}</TableHead>}
                                            {isVisible("quantityDelivered") && <TableHead aria-sort={ariaSortFor(reportSort, "quantityDelivered")} className="h-14 px-2 text-center text-[9px] font-black uppercase leading-tight tracking-wide text-emerald-600 whitespace-normal">{sortHead("quantityDelivered", "Qty Delivered")}</TableHead>}
                                            {isVisible("quantityRefunded") && <TableHead aria-sort={ariaSortFor(reportSort, "quantityRefunded")} className="h-14 px-2 text-center text-[9px] font-black uppercase leading-tight tracking-wide text-rose-500 whitespace-normal">{sortHead("quantityRefunded", "Qty Refunded")}</TableHead>}
                                            {!pricesHidden && isVisible("subtotalValue") && <TableHead aria-sort={ariaSortFor(reportSort, "subtotalValue")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-wide text-slate-500 text-right">{sortHead("subtotalValue", "Subtotal")}</TableHead>}
                                            {!pricesHidden && isVisible("refundValue") && <TableHead aria-sort={ariaSortFor(reportSort, "refundValue")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-wide text-right text-rose-500">{sortHead("refundValue", "Refund")}</TableHead>}
                                            {!pricesHidden && isVisible("netTotalValue") && <TableHead aria-sort={ariaSortFor(reportSort, "netTotalValue")} className="h-14 px-3 2xl:px-4 text-[10px] font-black uppercase tracking-wide text-slate-500 text-right whitespace-normal">{sortHead("netTotalValue", isBuyer ? "Net Purchased" : "Net Revenue")}</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {(() => {
                                          if (isReportLoading) {
                                            return (
                                            <TableRow><TableCell colSpan={ALL_COLUMNS.length} className="h-64 text-center"><Loader2 className="h-8 w-8 animate-spin mx-auto text-indigo-500/20" /></TableCell></TableRow>
                                        )
                                          }
                                          if (filteredOrders.length === 0) {
                                            return (
                                            <TableRow><TableCell colSpan={ALL_COLUMNS.length} className="h-64 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">No records found</TableCell></TableRow>
                                        )
                                          }
                                          return (
                                            filteredOrders.map((order: any) => {
                                                const isExpanded = expandedOrderIds.has(order.id)
                                                return (
                                                <Fragment key={order.id}>
                                                <TableRow
                                                    tabIndex={0}
                                                    aria-expanded={isExpanded}
                                                    aria-controls={isExpanded ? `order-report-details-${order.id}` : undefined}
                                                    aria-label={`Order ${order.tid}, ${isExpanded ? "collapse" : "show"} details`}
                                                    onClick={() => handleOrderRowClick(order.id)}
                                                    onKeyDown={(event) => handleOrderRowKeyDown(event, order.id)}
                                                    className={cn(
                                                        "group cursor-pointer border-b border-slate-100 dark:border-slate-800/50 hover:bg-slate-50/80 dark:hover:bg-indigo-500/5 transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500",
                                                        isExpanded && "bg-indigo-50/40 dark:bg-indigo-950/10",
                                                    )}
                                                >
                                                    {isVisible("tid") && (
                                                        <TableCell className="px-3 2xl:px-4 py-5 bg-white/100 dark:bg-[#0c1222]/100 group-hover:bg-slate-50/100 dark:group-hover:bg-slate-900/100 border-r border-slate-200/60 dark:border-slate-800/60 transition-colors duration-300">
                                                            <div className="flex min-w-0 flex-col gap-1.5">
                                                                <div className="flex min-w-0 items-center gap-1.5">
                                                                    <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-300", isExpanded ? "rotate-0 text-indigo-500" : "-rotate-90 text-slate-300 group-hover:text-indigo-400")} />
                                                                    <span className="whitespace-normal break-all text-[11px] font-black text-slate-900 dark:text-white font-mono tracking-tight tabular-nums" title={order.tid}>{order.tid}</span>
                                                                </div>
                                                                <span className="flex min-w-0 items-center gap-1 text-[9px] font-bold text-slate-400 uppercase tracking-wide">
                                                                    <span className="h-1 w-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-700" />
                                                                    <span>Audit Invoice</span>
                                                                </span>
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                    {isVisible("orderDate") && (
                                                        <TableCell className="px-3 2xl:px-4 py-5" suppressHydrationWarning>
                                                            <div className="flex flex-col gap-1">
                                                                <span className="text-[11px] font-black text-slate-700 dark:text-slate-200 tabular-nums">{new Date(order.createdAt).toLocaleDateString()}</span>
                                                                <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter tabular-nums">{new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                    {isVisible("userName") && <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words"><span className="block text-[11px] font-black text-slate-900 dark:text-white uppercase tracking-tighter" title={order.userName || "Guest System"}>{order.userName || "Guest System"}</span></TableCell>}
                                                    {isVisible("employeeId") && (
                                                        <TableCell className="px-3 2xl:px-4 py-5">
                                                            <div className="inline-flex max-w-full items-center whitespace-normal break-all px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800/50 text-[10px] font-black text-slate-600 dark:text-slate-400 font-mono ring-1 ring-slate-200 dark:ring-slate-700/50" title={order.employeeId || "N/A"}>
                                                                #{order.employeeId || (order.userId ? order.userId.split('-')[0] : 'N/A')}
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                    {isVisible("organizationName") && role === "SUPER_ADMIN" && <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words text-[10px] font-bold text-slate-500 uppercase tracking-tighter" title={order.organizationName || "N/A"}>{order.organizationName || "N/A"}</TableCell>}
                                                    {isVisible("group") && role !== "BRANCH_ADMIN" && <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words text-[10px] font-black text-indigo-600 dark:text-indigo-400 uppercase tracking-wide tabular-nums" title={order.groupName || "-"}>{order.groupName || "-"}</TableCell>}
                                                    {isVisible("groupOrderReference") && showsGroupOrders && <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words font-mono text-[10px] font-bold text-slate-600 dark:text-slate-300 tabular-nums" title={order.groupOrderReference || "-"}>{order.groupOrderReference || "-"}</TableCell>}
                                                    {isVisible("branchName") && role !== "BRANCH_ADMIN" && <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words text-[11px] font-black text-slate-700 dark:text-slate-300 uppercase tracking-tighter" title={order.branchName}>{order.branchName}</TableCell>}
                                                    {isVisible("status") && (
                                                        <TableCell className="px-2 2xl:px-3 py-5 text-center">
                                                            <div className="inline-flex max-w-full flex-col items-center justify-center gap-1">
                                                                <Badge
                                                                    variant="outline"
                                                                    style={{
                                                                        backgroundColor: `${STATUS_COLORS[order.status?.toUpperCase()] || '#94a3b8'}15`,
                                                                        color: STATUS_COLORS[order.status?.toUpperCase()] || '#94a3b8',
                                                                        borderColor: `${STATUS_COLORS[order.status?.toUpperCase()] || '#94a3b8'}30`
                                                                    }}
                                                                    className="max-w-full whitespace-normal text-[9px] font-black uppercase tracking-wide px-2 py-1 rounded-xl border shadow-sm transition-transform group-hover:scale-105 duration-300"
                                                                >
                                                                    {getOrderDerivedStatus(order).label}
                                                                </Badge>
                                                                {['FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(order.status?.toUpperCase()) && Number(order.refundAmountCents || 0) > 0 && (
                                                                    <Badge variant="outline" className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                                                                        Partial Refund
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                    {isVisible("deliveryStatus") && (
                                                        <TableCell className="px-2 2xl:px-3 py-5 text-center">
                                                            {getOrderStatusDisplay(order).fulfillmentStatus
                                                                ? (
                                                                    <Badge
                                                                        variant="outline"
                                                                        className={cn("max-w-full whitespace-normal rounded-xl border px-2 py-1 text-[9px] font-black uppercase tracking-wide", getFulfillmentProgressColor(order.fulfillmentStatus))}
                                                                    >
                                                                        {getOrderStatusDisplay(order).fulfillmentStatus}
                                                                    </Badge>
                                                                )
                                                                : <span className="text-[10px] font-bold text-slate-400">—</span>}
                                                        </TableCell>
                                                    )}
                                                    {isVisible("paymentStatus") && (
                                                        <TableCell className="px-2 2xl:px-3 py-5 text-center">
                                                            {getOrderStatusDisplay(order).paymentStatus
                                                                ? (
                                                                    <Badge
                                                                        variant="outline"
                                                                        className={cn("max-w-full whitespace-normal rounded-xl border px-2 py-1 text-[9px] font-black uppercase tracking-wide", getPaymentStatusColor(order.paymentStatus))}
                                                                    >
                                                                        {getOrderStatusDisplay(order).paymentStatus}
                                                                    </Badge>
                                                                )
                                                                : <span className="text-[10px] font-bold text-slate-400">—</span>}
                                                        </TableCell>
                                                    )}
                                                    {isVisible("approvalLevel") && (
                                                        <TableCell className="px-2 py-5 text-center">
                                                            {approverLevelOf(order.approvalLevel).approverLevel
                                                                ? (
                                                                    <Badge variant="outline" className="rounded-xl border-indigo-200 bg-indigo-50 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                                                                        {approverLevelOf(order.approvalLevel).approverLevel}
                                                                    </Badge>
                                                                )
                                                                : <span className="text-[10px] font-bold text-slate-400">—</span>}
                                                        </TableCell>
                                                    )}
                                                    {isVisible("financialApproverLevel") && (
                                                        <TableCell className="px-2 py-5 text-center">
                                                            {approverLevelOf(order.financialApproverLevel).approverLevel
                                                                ? (
                                                                    <Badge variant="outline" className="rounded-xl border-violet-200 bg-violet-50 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-violet-600 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">
                                                                        {approverLevelOf(order.financialApproverLevel).approverLevel}
                                                                    </Badge>
                                                                )
                                                                : <span className="text-[10px] font-bold text-slate-400">—</span>}
                                                        </TableCell>
                                                    )}
                                                    {isVisible("approver") && (
                                                        <TableCell className="px-3 2xl:px-4 py-5 whitespace-normal break-words">
                                                            {order.approverName
                                                                ? (
                                                                    <div className="flex min-w-0 flex-col gap-0.5">
                                                                        <span className="block text-[11px] font-black text-slate-900 dark:text-white uppercase tracking-tighter" title={order.approverName}>{order.approverName}</span>
                                                                        {order.approverDesignation && (
                                                                            <span className="block text-[9px] font-bold text-slate-400 uppercase tracking-wide" title={order.approverDesignation}>{order.approverDesignation}</span>
                                                                        )}
                                                                    </div>
                                                                )
                                                                : <span className="text-[10px] font-bold text-slate-400">—</span>}
                                                        </TableCell>
                                                    )}
                                                    {isVisible("quantityOrdered") && <TableCell className="px-2 py-5 text-center text-[12px] font-black font-mono text-slate-900 dark:text-white tabular-nums">{order.quantityOrdered || 0}</TableCell>}
                                                    {isVisible("quantityDelivered") && <TableCell className="px-2 py-5 text-center text-[12px] font-black font-mono text-emerald-600 dark:text-emerald-400 tabular-nums">{(order.quantityOrdered || 0) - (order.quantityRefunded || 0)}</TableCell>}
                                                    {isVisible("quantityRefunded") && <TableCell className="px-2 py-5 text-center text-[12px] font-black font-mono text-rose-500 dark:text-rose-400 tabular-nums">{order.quantityRefunded || 0}</TableCell>}
                                                    {!pricesHidden && isVisible("subtotalValue") && <TableCell className="px-3 2xl:px-4 py-5 text-right text-[11px] font-black font-mono text-slate-700 dark:text-slate-200 tabular-nums" title={formatPKR(order.subtotalCents / 100)}>{formatPKR(order.subtotalCents / 100)}</TableCell>}
                                                    {!pricesHidden && isVisible("refundValue") && <TableCell className="px-3 2xl:px-4 py-5 text-right text-[11px] font-black font-mono text-rose-500 tabular-nums" title={order.refundAmountCents > 0 ? `-${formatPKR(order.refundAmountCents / 100)}` : "—"}>{order.refundAmountCents > 0 ? `-${formatPKR(order.refundAmountCents / 100)}` : "—"}</TableCell>}
                                                    {!pricesHidden && isVisible("netTotalValue") && (
                                                        <TableCell className="px-3 2xl:px-4 py-5 text-right">
                                                            <div className="flex min-w-0 flex-col items-end">
                                                                <span className="block max-w-full text-[12px] font-black font-mono text-indigo-600 dark:text-indigo-400 tabular-nums leading-none" title={formatPKR((order.totalCents - (order.refundAmountCents || 0)) / 100)}>
                                                                    {formatPKR((order.totalCents - (order.refundAmountCents || 0)) / 100)}
                                                                </span>
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                </TableRow>
                                                {isExpanded && (
                                                    <OrderReportRowDetails
                                                        orderId={order.id}
                                                        tid={order.tid}
                                                        columnCount={visibleReportColumnCount}
                                                        onCollapse={() => toggleOrderExpansion(order.id)}
                                                    />
                                                )}
                                                </Fragment>
                                                )
                                            })
                                        )
                                        })()}
                                    </TableBody>
                                </Table>
                            </ReportTableScroll>
                            <div className="flex flex-col gap-4 border-t border-slate-100 bg-slate-50/50 px-6 py-5 dark:border-slate-900 dark:bg-slate-900/40 sm:flex-row sm:items-center sm:justify-between sm:px-8">
                                <div className="space-y-1">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic">System Generated Audit • {generatedDate}</p>
                                    <p className="text-xs font-semibold text-slate-500" aria-live="polite">
                                        Showing {firstVisibleOrder}-{lastVisibleOrder} of {totalReportOrders.toLocaleString()} orders
                                    </p>
                                </div>
                                <Pagination className="mx-0 w-auto justify-end">
                                    <PaginationContent>
                                        <PaginationItem>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="gap-1 rounded-xl"
                                                aria-label="Go to previous order-report page"
                                                disabled={currentPage <= 1 || isReportValidating}
                                                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                                            >
                                                <ChevronLeft className="h-4 w-4" />
                                                <span className="hidden sm:inline">Previous</span>
                                            </Button>
                                        </PaginationItem>
                                        <PaginationItem>
                                            <span className="flex h-9 min-w-24 items-center justify-center px-3 text-xs font-semibold text-slate-600 dark:text-slate-300">
                                                Page {currentPage} of {totalReportPages}
                                            </span>
                                        </PaginationItem>
                                        <PaginationItem>
                                            <Button
                                                type="button"
                                                variant="outline"
                                                size="sm"
                                                className="gap-1 rounded-xl"
                                                aria-label="Go to next order-report page"
                                                disabled={currentPage >= totalReportPages || totalReportOrders === 0 || isReportValidating}
                                                onClick={() => setCurrentPage((page) => Math.min(totalReportPages, page + 1))}
                                            >
                                                <span className="hidden sm:inline">Next</span>
                                                <ChevronRight className="h-4 w-4" />
                                            </Button>
                                        </PaginationItem>
                                    </PaginationContent>
                                </Pagination>
                            </div>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}

// ━━━ HELPER COMPONENTS ━━━

function MonthFilter({ selected, onChange }: Readonly<{ selected: number[], onChange: (val: number[]) => void }>) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const items = months.map((m, i) => ({ id: i + 1, label: m }))
    return (
        <MultiSelectFilter
            title="Months"
            items={items}
            selectedIds={selected}
            onChange={(ids: number[]) => onChange([...ids].sort((a, b) => a - b))}
            icon={<Filter className="h-3.5 w-3.5 text-indigo-500" />}
            placeholder="Months"
            showSearch={false}
        />
    )
}

function YearFilter({ selected, onChange, allTimeData }: Readonly<{ selected: number[], onChange: (val: number[]) => void, allTimeData: any }>) {
    const availableYears = useMemo(() => {
        if (Array.isArray(allTimeData?.years) && allTimeData.years.length > 0) {
            return Array.from(new Set<number>(allTimeData.years.map(Number).filter(Number.isInteger))).sort((a, b) => b - a)
        }
        if (!allTimeData?.orders?.length) return [new Date().getFullYear()]
        const yearsSet = new Set<number>()
        allTimeData.orders.forEach((o: any) => yearsSet.add(new Date(o.createdAt).getFullYear()))
        return Array.from(yearsSet).sort((a, b) => b - a)
    }, [allTimeData])

    const items = availableYears.map(y => ({ id: y, label: String(y) }))

    return (
        <MultiSelectFilter
            title="Years"
            items={items}
            selectedIds={selected}
            onChange={(ids: number[]) => onChange([...ids].sort((a, b) => b - a))}
            icon={<Calendar className="h-3.5 w-3.5 text-blue-500" />}
            placeholder="Years"
            showSearch={false}
        />
    )
}

function StatusMixTooltip({ active, payload }: any) {
    if (!active || !payload?.length) return null

    const data = payload[0].payload
    return (
        <div className="bg-white dark:bg-slate-900 p-3 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-1">{data.name}</p>
            <p className="text-lg font-black text-slate-900 dark:text-white">{data.value} <span className="text-xs font-medium text-slate-400">orders</span></p>
        </div>
    )
}

function BarTooltip({ active, payload, label, compare, revenueLabel, pricesHidden }: any) {
    if (active && payload?.length) {
        return (
            <div className="bg-white dark:bg-slate-900 p-4 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 min-w-[200px] backdrop-blur-xl bg-white/90 dark:bg-slate-900/90">
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                    <Calendar className="h-3.5 w-3.5 text-indigo-500" />
                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-300">{label}</p>
                </div>
                <div className="space-y-2">
                    {payload.map((p: any) => {
                        let displayName = p.name;
                        if (displayName.toLowerCase().includes('revenue')) {
                            displayName = displayName.replace(/revenue/i, revenueLabel);
                        }
                        return (
                            <div key={p.name} className="flex items-center justify-between gap-4">
                                <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: p.color }} />
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">{displayName}</span>
                                </div>
                                <span className="text-xs font-black text-slate-900 dark:text-white tabular-nums">
                                    {typeof p.value === 'number' && !pricesHidden && (p.name.toLowerCase().includes('revenue') || p.name.toLowerCase().includes(revenueLabel.toLowerCase())) ? formatPKR(p.value) : p.value}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
        )
    }
    return null
}
