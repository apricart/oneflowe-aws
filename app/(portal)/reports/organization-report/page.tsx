"use client"

import { useState, useMemo } from "react"
import useSWR from "swr"
import { useAppContext } from "@/components/context/app-context"
import { fetcher } from "@/lib/fetcher"
import { formatPKR, cn } from "@/lib/utils"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { GlobalDateFilter, FilterPreset } from "@/components/dashboard/global-date-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { DateRange } from "@/lib/hooks/use-sales-performance"
import { startOfMonth, endOfMonth, startOfDay, endOfDay } from "date-fns"
import { Badge } from "@/components/ui/badge"
import {
    ResponsiveContainer,
    ComposedChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    Cell,
    Line
} from "recharts"
import {
    Building2,
    Users,
    TrendingUp,
    RefreshCw,
    CheckCircle2,
    RotateCcw,
    BarChart3,
    ListOrdered,
    LayoutDashboard,
    LayoutGrid,
    Database,
    Search,
    FileSpreadsheet,
    FileText,
    Upload,
    Download,
    Calculator,
    Package,
    ShoppingBag,
    Calendar,
    Hash,
    Store,
    Layers,
    ChevronRight,
    ArrowUpRight,
    ArrowDownRight,
    MoreHorizontal,
    Table as TableIcon,
    LineChart as LineChartIcon,
    PieChart as PieChartIcon
} from "lucide-react"
import { KPICard } from "@/components/reports/kpi-card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useSession } from "next-auth/react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import { useCallback, useEffect, useRef } from "react"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import { resolveOrganizationReportScope } from "@/lib/organization-report-scope"



const getDefaultDateRange = (): DateRange => ({
    startDate: startOfMonth(new Date()),
    endDate: endOfMonth(new Date()),
})

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const formatTrendPeriodLabel = (period: string) => {
    const [year, month, day] = period.split("-")
    const monthIndex = month ? Number(month) - 1 : -1
    const monthLabel = monthIndex >= 0 && monthIndex < MONTH_LABELS.length ? MONTH_LABELS[monthIndex] : month

    if (year && monthLabel && day) return `${day} ${monthLabel} ${year}`
    if (year && monthLabel) return `${monthLabel} ${year}`
    return period
}

export default function OrganizationReportPage() {
    const { data: session } = useSession()
    const role = (session?.user as any)?.role
    const isBuyer = role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"
    const userOrgId = (session?.user as any)?.organizationId
    const router = useRouter()
    const searchParams = useSearchParams()
    const {
        organizationId: contextOrgId,
        branchId: contextBranchId,
        branchIds: contextBranchIds,
        isInitialized,
    } = useAppContext()

    // STATE DECLARATIONS
    const [generatedDate, setGeneratedDate] = useState("")
    const [activeTab, setActiveTab] = useState(searchParams.get("tab") || "analytics")
    const [hasMounted, setHasMounted] = useState(false)
    const pathname = usePathname()

    useEffect(() => {
        setHasMounted(true)
        setGeneratedDate(new Date().toLocaleString())
    }, [])

    useEffect(() => {
        if (hasMounted && (session?.user as any)?.role === "BRANCH_ADMIN") {
            router.push("/reports")
        }
    }, [hasMounted, session, router])

    // ━━━ GLOBAL CONTEXT FILTERS ━━━
    const startFromUrl = searchParams.get("startDate")
    const endFromUrl = searchParams.get("endDate")
    const [dateRange, setDateRange] = useState<DateRange | null>(
        startFromUrl && endFromUrl
            ? { startDate: new Date(startFromUrl), endDate: new Date(endFromUrl) }
            : null
    )
    const [activePreset, setActivePreset] = useState<FilterPreset>((searchParams.get("preset") as FilterPreset) || "all")
    const [compare, setCompare] = useState(searchParams.get("compare") === "true")
    const [compareRange, setCompareRange] = useState<DateRange | null>(null)

    // Global Multi-Selects
    const [selectedMonths, setSelectedMonths] = useState<number[]>([])
    const [selectedYears, setSelectedYears] = useState<number[]>([])
    const [compareMonths, setCompareMonths] = useState<number[]>([])
    const [compareYears, setCompareYears] = useState<number[]>([])

    // Branch/Organization Scope
    const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([])
    const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([])
    const [statusFilter, setStatusFilter] = useState<string>("all")

    // ━━━ TIER 1: GLOBAL SUMMARY DATA ━━━
    // Page-level selections take precedence when present; otherwise inherit the
    // tenant scope selected in the application header.
    const {
        organizationIds: effectiveGlobalOrgIds,
        branchIds: effectiveGlobalBranchIds,
    } = resolveOrganizationReportScope({
        selectedOrganizationIds: selectedOrgIds,
        selectedBranchIds,
        contextOrganizationId: contextOrgId,
        contextBranchId,
        contextBranchIds,
    })

    const globalQueryParams = new URLSearchParams()
    if (dateRange) {
        globalQueryParams.set("startDate", dateRange.startDate.toISOString())
        globalQueryParams.set("endDate", dateRange.endDate.toISOString())
    }
    if (effectiveGlobalOrgIds.length > 0) globalQueryParams.set("organizationIds", effectiveGlobalOrgIds.join(","))
    if (effectiveGlobalBranchIds.length > 0) globalQueryParams.set("branchIds", effectiveGlobalBranchIds.join(","))
    if (selectedMonths.length > 0) globalQueryParams.set("months", selectedMonths.join(","))
    if (selectedYears.length > 0) globalQueryParams.set("years", selectedYears.join(","))
    if (compare) globalQueryParams.set("compare", "true")

    // Fetches are deferred until the org/branch context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: globalData, isLoading: isGlobalLoading, mutate: mutateGlobal } = useSWR<any>(isInitialized ? `/api/v1/analytics/organization-stats?${globalQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 2: CHART (ANALYTICS) LOCAL STATE ━━━
    const [chartMonths, setChartMonths] = useState<number[]>([])
    const [chartYears, setChartYears] = useState<number[]>([])
    const [chartBranchIds, setChartBranchIds] = useState<string[]>([])
    const [chartOrgIds, setChartOrgIds] = useState<string[]>([])

    const chartQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (chartMonths.length > 0) chartQueryParams.set("months", chartMonths.join(","))
    if (chartYears.length > 0) chartQueryParams.set("years", chartYears.join(","))
    if (chartBranchIds.length > 0) chartQueryParams.set("branchIds", chartBranchIds.join(","))
    if (chartOrgIds.length > 0) chartQueryParams.set("organizationIds", chartOrgIds.join(","))

    const { data: chartData, isLoading: isChartLoading, mutate: mutateChart } = useSWR<any>(isInitialized ? `/api/v1/analytics/organization-stats?${chartQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 3: REPORT (TABLE) LOCAL STATE ━━━
    const [reportMonths, setReportMonths] = useState<number[]>([])
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportBranchIds, setReportBranchIds] = useState<string[]>([])
    const [reportOrgIds, setReportOrgIds] = useState<string[]>([])
    const [reportGroupIds, setReportGroupIds] = useState<string[]>([])
    const [reportSearch, setReportSearch] = useState("")

    const reportQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (reportMonths.length > 0) reportQueryParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportQueryParams.set("years", reportYears.join(","))
    if (reportGroupIds.length > 0) reportQueryParams.set("groupIds", reportGroupIds.join(","))
    if (reportBranchIds.length > 0) reportQueryParams.set("branchIds", reportBranchIds.join(","))
    if (reportOrgIds.length > 0) reportQueryParams.set("organizationIds", reportOrgIds.join(","))

    const { data: reportData, isLoading: isReportLoading, mutate: mutateReport } = useSWR<any>(isInitialized ? `/api/v1/analytics/organization-stats?${reportQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 4: ALL-TIME (FOR YEAR SELECTION) ━━━
    const { data: allTimeData } = useSWR<any>(isInitialized ? `/api/v1/analytics/organization-stats?allTime=true` : null, fetcher)

    const isInitialLoad = useRef(true)
    const lastSyncedBranchIds = useRef<string[]>([])

    // ━━━ SMART SYNC (Global to Local) ━━━
    useEffect(() => {
        const headerBranchIds = contextBranchIds.length > 0
            ? contextBranchIds
            : contextBranchId
                ? [contextBranchId]
                : []
        const hasGlobalChanged = JSON.stringify(headerBranchIds) !== JSON.stringify(lastSyncedBranchIds.current)
        if (hasGlobalChanged) {
            setChartBranchIds([...headerBranchIds])
            setReportBranchIds([...headerBranchIds])
            lastSyncedBranchIds.current = [...headerBranchIds]
        }
    }, [contextBranchId, contextBranchIds])

    const organizationId = userOrgId || (selectedOrgIds.length === 1 ? selectedOrgIds[0] : null)

    const handleDateChange = useCallback((range: DateRange | null, preset: FilterPreset, c?: boolean, cr?: DateRange | null, m?: number[], y?: number[], cm?: number[], cy?: number[]) => {
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
        mutateGlobal()
        mutateChart()
        mutateReport()
    }, [mutateGlobal, mutateChart, mutateReport])

    const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
        // Structured columns matching the UI table exactly
        const columns = [
            { label: "Organization Name",  value: (org: any) => org.organizationName || "-" },
            { label: "Status",             value: (org: any) => org.organizationStatus || "active" },
            { label: "Active Branches",    value: (org: any) => org.activeBranchCount || 0 },
            { label: "Inactive Branches",  value: (org: any) => org.inactiveBranchCount || 0 },
            { label: "Managed Users",      value: (org: any) => org.totalUserCount || 0 },
            { label: isBuyer ? "Purchase (PKR)" : "Revenue (PKR)", value: (org: any) => (org.revenue / 100).toFixed(2) },
            { label: "Orders",             value: (org: any) => org.orderCount || 0 },
            { label: "Fulfilled Orders",   value: (org: any) => org.fulfilledCount || 0 },
            { label: "Refunded Orders",    value: (org: any) => org.refundedCount || 0 },
            // { label: "Fulfillment Rate",   value: (org: any) => org.fulfillmentRate ? `${org.fulfillmentRate.toFixed(1)}%` : "N/A" },
        ]

        const headers = columns.map(c => c.label)
        const rows = filteredStats.map((org: any) => columns.map(c => c.value(org)))

        if (format === 'pdf') {
            const doc = new jsPDF()
            doc.setFontSize(20); doc.text(isBuyer ? "Organization Purchase Ledger" : "Organization Performance Ledger", 14, 20)
            doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
            autoTable(doc, { startY: 40, head: [headers], body: rows, theme: 'grid' })
            doc.save(`organization-report-${new Date().getTime()}.pdf`)
            return
        }

        const worksheet = XLSX.utils.aoa_to_sheet([
            sanitizeSpreadsheetRow(headers),
            ...rows.map(sanitizeSpreadsheetRow),
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Organizations")
        XLSX.writeFile(workbook, `organization-report-${new Date().getTime()}.${format === 'excel' ? 'xlsx' : 'csv'}`)
    }

    const handleBranchChange = (ids: string[]) => setSelectedBranchIds(ids)

    // ━━━ YEAR RANGE CALCULATION ━━━
    const allYears = useMemo(() => {
        const trend = allTimeData?.trend || []
        const years = new Set<number>()
        trend.forEach((t: any) => {
            const y = parseInt(t.period.split('-')[0])
            if (!isNaN(y)) years.add(y)
        })
        if (years.size === 0) years.add(new Date().getFullYear())
        return Array.from(years).sort((a, b = a) => b - a)
    }, [allTimeData])

    const resetChartFilters = useCallback(() => {
        setChartMonths([])
        setChartYears([])
        setChartOrgIds([])
        setChartBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        mutateChart()
    }, [contextBranchIds, mutateChart])

    const resetReportFilters = useCallback(() => {
        const defaultMonths = activePreset === "all" ? ALL_MONTHS : []
        const defaultYears = activePreset === "all" ? allYears : []

        setReportMonths([...defaultMonths])
        setReportYears([...defaultYears])
        setReportOrgIds([])
        setReportGroupIds([])
        setReportBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        setReportSearch("")
        setDateRange(null)
        setActivePreset("all")
        setSelectedMonths([])
        setSelectedYears([])
        mutateReport()
    }, [activePreset, allYears, contextBranchIds, mutateReport])

    useEffect(() => {
        if (hasMounted && isInitialLoad.current && allYears.length > 0) {
            if (activePreset === "all") {
                setChartMonths([])
                setChartYears([])
                setReportMonths([...ALL_MONTHS])
                setReportYears([...allYears])
            }
            isInitialLoad.current = false
        }
    }, [hasMounted, allYears, activePreset])

    const chartYearsAvailable = allYears
    const reportYearsAvailable = allYears

    const stats = reportData?.items || []
    const normalizedTrend = useMemo(() => {
        const trend = chartData?.trend || []
        const comparisonTrend = chartData?.comparisonTrend || []
        const currentYear = new Date().getFullYear()
        const getComparisonRevenue = (period: string) =>
            comparisonTrend.find((t: any) => t.period === period)?.revenue || 0

        if (chartYears.length === 0 || (chartYears.length === 1 && chartMonths.length === 1)) {
            return trend.map((t: any) => ({
                period: formatTrendPeriodLabel(String(t.period)),
                revenue: t.revenue || 0,
                orders: t.orders || 0,
                prevRevenue: getComparisonRevenue(String(t.period))
            }))
        }

        // Case A: Multiple years -> Show Years on X-Axis
        if (chartYears.length > 1) {
            return [...chartYears].sort((a, b) => a - b).map(year => {
                const yearData = trend.filter((t: any) => t.period.startsWith(String(year)))
                const compData = comparisonTrend.filter((t: any) => t.period.startsWith(String(year)))

                return {
                    period: String(year),
                    revenue: yearData.reduce((sum: number, t: any) => sum + (t.revenue || 0), 0),
                    orders: yearData.reduce((sum: number, t: any) => sum + (t.orders || 0), 0),
                    prevRevenue: compData.reduce((sum: number, t: any) => sum + (t.revenue || 0), 0)
                }
            })
        }

        // Case B: Single year (or default) -> Show Months on X-Axis
        const activeYear = chartYears.length === 1 ? chartYears[0] : currentYear
        const monthsToShow = chartMonths.length > 0 && chartMonths.length < 12
            ? [...chartMonths].sort((a, b) => a - b)
            : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

        return monthsToShow.map(m => {
            const periodKey = `${activeYear}-${String(m).padStart(2, '0')}`
            const monthData = trend.find((t: any) => t.period === periodKey)
            const compData = comparisonTrend.find((t: any) => t.period === periodKey)

            return {
                period: MONTH_LABELS[m - 1],
                revenue: monthData?.revenue || 0,
                orders: monthData?.orders || 0,
                prevRevenue: compData?.revenue || 0
            }
        })
    }, [chartData, chartMonths, chartYears])

    const statsData = stats // renaming to avoid conflict if any

    const summary = globalData?.items?.reduce((acc: any, curr: any) => ({
        revenue: acc.revenue + curr.revenue,
        orders: acc.orders + curr.orderCount,
        users: acc.users + curr.totalUserCount,
        orgs: acc.orgs + 1
    }), { revenue: 0, orders: 0, users: 0, orgs: 0 }) || { revenue: 0, orders: 0, users: 0, orgs: 0 }

    // Comparison Trends
    const comparisonSummary = globalData?.items?.reduce((acc: any, curr: any) => ({
        revenue: acc.revenue + (curr.comparison?.revenue || 0),
        orders: acc.orders + (curr.comparison?.orderCount || 0)
    }), { revenue: 0, orders: 0 }) || { revenue: 0, orders: 0 }

    const revenueTrend = useMemo(() => {
        if (!compare || comparisonSummary.revenue === 0) return null
        const pct = ((summary.revenue - comparisonSummary.revenue) / comparisonSummary.revenue) * 100
        return { value: Math.abs(pct).toFixed(1), isUp: pct > 0, isDown: pct < 0 }
    }, [summary.revenue, comparisonSummary.revenue, compare])

    const orderTrend = useMemo(() => {
        if (!compare || comparisonSummary.orders === 0) return null
        const pct = ((summary.orders - comparisonSummary.orders) / comparisonSummary.orders) * 100
        return { value: Math.abs(pct).toFixed(1), isUp: pct > 0, isDown: pct < 0 }
    }, [summary.orders, comparisonSummary.orders, compare])

    const filteredStats = useMemo(() => {
        return stats.filter((s: any) =>
            s.organizationName.toLowerCase().includes(reportSearch.toLowerCase()) ||
            s.organizationId.toString().includes(reportSearch)
        )
    }, [stats, reportSearch])

    return (
        <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] transition-colors duration-500 pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-700 flex items-center justify-center shadow-lg shadow-indigo-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
                            <Building2 className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Organization Intelligence</h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                                <LayoutGrid className="h-3 w-3" />
                                Unified organization performance metrics
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <div className="hidden lg:flex items-center gap-2 p-1.5 bg-slate-100 dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-inner">
                            <GlobalDateFilter
                                value={dateRange}
                                activePreset={activePreset}
                                compare={compare}
                                compareRange={compareRange}
                                months={selectedMonths}
                                years={selectedYears}
                                compareMonths={compareMonths}
                                compareYears={compareYears}
                                onChange={handleDateChange}
                            />
                        </div>
                        <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-indigo-500 transition-colors" onClick={resetGlobalDateFilter}>
                            <RefreshCw className={cn("h-4 w-4", isGlobalLoading && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="max-w-[1600px] mx-auto px-6 pt-10 space-y-10">
                {/* ━━━ BENTO KPI GRID ━━━ */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    <KPICard
                        title={isBuyer ? "Total Purchase" : "Net Revenue"}
                        value={formatPKR(summary.revenue)}
                        icon={TrendingUp}
                        colorScheme="indigo"
                        trend={revenueTrend?.value ? Number(revenueTrend.value) * (revenueTrend.isUp ? 1 : -1) : undefined}
                        subtitle={isBuyer ? "Consolidated net purchases" : "Consolidated net revenue"}
                        comparisonLabel="Prior Period"
                        comparisonValue={compare ? formatPKR(comparisonSummary.revenue) : undefined}
                        isLoading={!globalData}
                    />
                    <KPICard
                        title="Total Orders"
                        value={summary.orders.toLocaleString()}
                        icon={ShoppingBag}
                        colorScheme="blue"
                        trend={orderTrend?.value ? Number(orderTrend.value) * (orderTrend.isUp ? 1 : -1) : undefined}
                        subtitle="Completed transactions"
                        comparisonLabel="Prior Period"
                        comparisonValue={compare ? comparisonSummary.orders.toLocaleString() : undefined}
                        isLoading={!globalData}
                    />
                    <KPICard
                        title="Total Users"
                        value={summary.users.toLocaleString()}
                        icon={Users}
                        colorScheme="violet"
                        subtitle="Across all branches"
                        isLoading={!globalData}
                    />
                    {role === "SUPER_ADMIN" && (
                        <KPICard
                            title="Total Companies"
                            value={summary.orgs.toLocaleString()}
                            icon={Building2}
                            colorScheme="emerald"
                            subtitle="Active organizations"
                            isLoading={!globalData}
                        />
                    )}
                </div>

                <Tabs value={activeTab} onValueChange={(val) => {
                    setActiveTab(val as any)
                    const params = new URLSearchParams(searchParams.toString())
                    params.set("tab", val)
                    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
                }} className="space-y-8">

                    <div className="flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-1">
                        <TabsList className="bg-transparent h-auto p-0 gap-8">
                            <TabsTrigger value="analytics" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
                                <LayoutDashboard className="h-4 w-4 mr-2" />
                                Analytics
                            </TabsTrigger>
                            <TabsTrigger value="reports" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
                                <Database className="h-4 w-4 mr-2" />
                                Reports
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="analytics" className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900/50 backdrop-blur-3xl rounded-[2rem] relative group transition-all duration-700 hover:shadow-indigo-500/10">
                            {/* Analytics Header */}
                            <div className="px-8 py-7 border-b border-slate-100 dark:border-slate-800 space-y-5">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2.5">
                                            <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500">
                                                <LineChartIcon className="h-4 w-4" />
                                            </div>
                                            <h3 className="font-black text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                                Growth & Comparison Trend
                                            </h3>
                                        </div>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-11"></p>
                                    </div>
                                    {/* <Button variant="outline" size="sm" onClick={resetChartFilters} className="h-8 w-8 p-0 rounded-lg border-slate-200 dark:border-slate-800" aria-label="Reset analytics filters" title="Reset analytics filters">
                                        <RefreshCw className={cn("h-3.5 w-3.5 text-slate-400", isChartLoading && "animate-spin")} />
                                    </Button> */}
                                </div>

                                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                                    <MonthFilter selected={chartMonths} onChange={setChartMonths} />
                                    <YearFilter selected={chartYears} onChange={setChartYears} availableYears={chartYearsAvailable} />
                                    <div className="h-6 w-[1px] bg-slate-200 dark:bg-slate-800 mx-1" />
                                    {role === "SUPER_ADMIN" && (
                                        <div className="flex items-center gap-2.5">
                                            <OrgFilter selectedIds={chartOrgIds} onChange={setChartOrgIds} />
                                            {chartOrgIds.length > 0 && (
                                                <BranchFilter
                                                    selectedIds={chartBranchIds}
                                                    onChange={setChartBranchIds}
                                                    organizationIds={chartOrgIds}
                                                    placeholder="Branches"
                                                />
                                            )}
                                        </div>
                                    )}
                                    {role !== "SUPER_ADMIN" && userOrgId && (
                                        <BranchFilter
                                            selectedIds={chartBranchIds}
                                            onChange={setChartBranchIds}
                                            organizationIds={[String(userOrgId)]}
                                            placeholder="Branches"
                                        />
                                    )}
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={resetChartFilters}
                                        className="h-11 gap-2 rounded-xl border-slate-200 px-4 text-[11px] font-bold uppercase tracking-wider text-slate-600 shadow-sm hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800"
                                    >
                                        <RotateCcw className="h-3.5 w-3.5" />
                                        Reset Filters
                                    </Button>
                                </div>
                            </div>

                            <CardContent className="p-8">
                                {isChartLoading ? (
                                    <div className="h-[450px] flex flex-col items-center justify-center gap-4">
                                        <div className="h-10 w-10 border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
                                        <p className="text-[10px] font-black uppercase text-slate-400 animate-pulse">Synchronizing Analytics...</p>
                                    </div>
                                ) : !normalizedTrend.length ? (
                                    <div className="h-[450px] flex flex-col items-center justify-center gap-4 text-center">
                                        <div className="h-14 w-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                                            <BarChart3 className="h-7 w-7 text-slate-300 dark:text-slate-600" />
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">No analytics data available</p>
                                            <p className="max-w-sm text-xs font-semibold text-slate-400 dark:text-slate-500">
                                                Try adjusting the date, year, month, organization, or branch filters.
                                            </p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="h-[450px] w-full">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={normalizedTrend} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                                <defs>
                                                    <linearGradient id="orgRevenue" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="0%" stopColor="#6366f1" stopOpacity={0.1} />
                                                        <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.3} />
                                                <XAxis
                                                    dataKey="period"
                                                    axisLine={false}
                                                    tickLine={false}
                                                    tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }}
                                                    dy={10}
                                                />
                                                <YAxis
                                                    axisLine={false}
                                                    tickLine={false}
                                                    tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }}
                                                    tickFormatter={(v) => `₨${v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v}`}
                                                />
                                                <Tooltip
                                                    content={({ active, payload, label }: any) => {
                                                        if (active && payload && payload.length) {
                                                            const d = payload[0].payload;
                                                            return (
                                                                <div className="bg-white dark:bg-slate-900/95 p-4 border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl backdrop-blur-xl">
                                                                    <p className="text-[10px] font-black uppercase text-slate-400 mb-3 tracking-[0.2em]">{label}</p>
                                                                    <div className="space-y-3">
                                                                        <div className="flex items-center justify-between gap-10">
                                                                            <span className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                                                                                <div className="h-2 w-2 rounded-full bg-indigo-500" /> {isBuyer ? "Total Purchase" : "Net Revenue"}
                                                                            </span>
                                                                            <span className="text-xs font-black text-slate-900 dark:text-white">{formatPKR(payload[0].value as number)}</span>
                                                                        </div>
                                                                        {compare && (
                                                                            <div className="flex items-center justify-between gap-10">
                                                                                <span className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                                                                                    <div className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" /> {isBuyer ? "Prior Purchase" : "Prior Revenue"}
                                                                                </span>
                                                                                <span className="text-xs font-black text-slate-500">{formatPKR(d.prevRevenue)}</span>
                                                                            </div>
                                                                        )}
                                                                        <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                                                                            <span className="text-[10px] font-black text-slate-400 uppercase">Orders</span>
                                                                            <span className="text-xs font-black text-indigo-600">{d.orders}</span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            )
                                                        }
                                                        return null;
                                                    }}
                                                />
                                                <Legend
                                                    verticalAlign="top"
                                                    align="right"
                                                    iconType="circle"
                                                    wrapperStyle={{ paddingBottom: 30, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px' }}
                                                />
                                                <Bar dataKey="revenue" name={isBuyer ? "Total Purchase" : "Net Revenue"} fill="#6366f1" radius={[6, 6, 0, 0]} barSize={32} />
                                                {compare && (
                                                    <Bar dataKey="prevRevenue" name="Prior Period" fill="#cbd5e1" radius={[6, 6, 0, 0]} barSize={32} />
                                                )}
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* ━━━ TOP ORGANIZATIONS BY VOLUME ━━━ */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900/50 backdrop-blur-3xl rounded-[2rem] transition-all duration-700 hover:shadow-indigo-500/10 h-full">
                                <CardHeader className="px-8 py-7 border-b border-slate-100 dark:border-slate-800">
                                    <div className="flex items-center gap-2.5">
                                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500">
                                            <TrendingUp className="h-4 w-4" />
                                        </div>
                                        <div className="space-y-1">
                                            <CardTitle className="font-black text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                                Top Orgs by Order Volume
                                            </CardTitle>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Highest performing organizations</p>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-0">
                                    <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
                                        {[...statsData]
                                            .sort((a: any, b: any) => b.orderCount - a.orderCount)
                                            .slice(0, 5)
                                            .map((org: any, idx: number) => (
                                                <div key={org.organizationId} className="flex items-center justify-between p-6 hover:bg-slate-50 dark:hover:bg-slate-800/20 transition-colors group">
                                                    <div className="flex items-center gap-4">
                                                        <div className={cn(
                                                            "h-10 w-10 rounded-2xl flex items-center justify-center font-black text-sm shadow-sm",
                                                            idx === 0 ? "bg-amber-100 text-amber-600 dark:bg-amber-500/20" :
                                                                idx === 1 ? "bg-slate-200 text-slate-500 dark:bg-slate-700" :
                                                                    idx === 2 ? "bg-orange-100 text-orange-600 dark:bg-orange-500/20" :
                                                                        "bg-indigo-50 text-indigo-500 dark:bg-indigo-500/10"
                                                        )}>
                                                            #{idx + 1}
                                                        </div>
                                                        <div>
                                                            <p className="font-black text-sm text-slate-900 dark:text-white uppercase tracking-tight group-hover:text-indigo-500 transition-colors">
                                                                {org.organizationName}
                                                            </p>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                                                                {org.activeBranchCount} Active Branches
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-black text-lg text-slate-900 dark:text-white tracking-tighter">
                                                            {org.orderCount.toLocaleString()}
                                                        </p>
                                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Orders</p>
                                                    </div>
                                                </div>
                                            ))}
                                        {statsData.length === 0 && (
                                            <div className="p-12 flex flex-col items-center justify-center text-slate-400">
                                                <Store className="h-8 w-8 mb-3 opacity-20" />
                                                <p className="text-[10px] font-black uppercase tracking-widest">No data available</p>
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900/50 backdrop-blur-3xl rounded-[2rem] transition-all duration-700 hover:shadow-indigo-500/10 h-full">
                                <CardHeader className="px-8 py-7 border-b border-slate-100 dark:border-slate-800">
                                    <div className="flex items-center gap-2.5">
                                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-500">
                                            <BarChart3 className="h-4 w-4" />
                                        </div>
                                        <div className="space-y-1">
                                            <CardTitle className="font-black text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                                Top Orgs by Revenue
                                            </CardTitle>
                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Highest grossing organizations</p>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-0">
                                    <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
                                        {[...statsData]
                                            .sort((a: any, b: any) => b.revenue - a.revenue)
                                            .slice(0, 5)
                                            .map((org: any, idx: number) => (
                                                <div key={org.organizationId} className="flex items-center justify-between p-6 hover:bg-slate-50 dark:hover:bg-slate-800/20 transition-colors group">
                                                    <div className="flex items-center gap-4">
                                                        <div className={cn(
                                                            "h-10 w-10 rounded-2xl flex items-center justify-center font-black text-sm shadow-sm",
                                                            idx === 0 ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20" :
                                                                "bg-blue-50 text-blue-500 dark:bg-blue-500/10"
                                                        )}>
                                                            #{idx + 1}
                                                        </div>
                                                        <div>
                                                            <p className="font-black text-sm text-slate-900 dark:text-white uppercase tracking-tight group-hover:text-blue-500 transition-colors">
                                                                {org.organizationName}
                                                            </p>
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{org.totalUserCount} Managed Users</p>
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="font-black text-lg text-slate-900 dark:text-white tracking-tight">
                                                            {formatPKR(org.revenue)}
                                                        </p>
                                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{isBuyer ? "Total Purchase" : "Net Revenue"}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        {statsData.length === 0 && (
                                            <div className="p-12 flex flex-col items-center justify-center text-slate-400">
                                                <Store className="h-8 w-8 mb-3 opacity-20" />
                                                <p className="text-[10px] font-black uppercase tracking-widest">No data available</p>
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value="reports" className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        {/* ━━━ LOCAL REPORT FILTERS ━━━ */}
                        <div className="flex flex-wrap items-center gap-2.5 p-4 bg-white dark:bg-slate-900 text-slate-900 dark:text-white border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm">
                            <div className="relative flex-1 min-w-[240px]">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                                <Input
                                    placeholder="Search companies..."
                                    value={reportSearch}
                                    onChange={(e) => setReportSearch(e.target.value)}
                                    className="pl-9 h-10 bg-slate-100/50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold font-mono placeholder:font-sans focus:ring-2 focus:ring-indigo-500/20"
                                />
                            </div>
                            <div className="h-6 w-[1px] bg-slate-200 dark:bg-slate-800 mx-1 lg:block hidden" />
                            <GlobalDateFilter
                                value={dateRange}
                                activePreset={activePreset}
                                customRangeOnly
                                onChange={(range, preset, nextCompare, nextCompareRange, months, years, nextCompareMonths, nextCompareYears) => {
                                    handleDateChange(range, preset, nextCompare, nextCompareRange, months, years, nextCompareMonths, nextCompareYears)
                                    setReportMonths(months ?? [])
                                    setReportYears(years ?? [])
                                }}
                                compare={compare}
                                compareRange={compareRange}
                                months={selectedMonths}
                                years={selectedYears}
                                compareMonths={compareMonths}
                                compareYears={compareYears}
                            />
                            <MonthFilter selected={reportMonths} onChange={setReportMonths} />
                            <YearFilter selected={reportYears} onChange={setReportYears} availableYears={reportYearsAvailable} />
                            {role === "SUPER_ADMIN" && (
                                <div className="flex items-center gap-2.5">
                                    <OrgFilter
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
                                        organizationIds={reportOrgIds}
                                        disabled={reportBranchIds.length > 0}
                                        placeholder="Groups"
                                    />
                                    {reportOrgIds.length > 0 && (
                                        <BranchFilter
                                            selectedIds={reportBranchIds}
                                            onChange={setReportBranchIds}
                                            organizationIds={reportOrgIds}
                                            groupIds={reportGroupIds}
                                            placeholder="Branches"
                                        />
                                    )}
                                </div>
                            )}
                            {role !== "SUPER_ADMIN" && userOrgId && (
                                <>
                                    <GroupFilter
                                        selectedIds={reportGroupIds}
                                        onChange={(ids: string[]) => {
                                            setReportGroupIds(ids)
                                            setReportBranchIds([])
                                        }}
                                        organizationIds={[String(userOrgId)]}
                                        disabled={reportBranchIds.length > 0}
                                        placeholder="Groups"
                                    />
                                    <BranchFilter
                                        selectedIds={reportBranchIds}
                                        onChange={setReportBranchIds}
                                        organizationIds={[String(userOrgId)]}
                                        groupIds={reportGroupIds}
                                        placeholder="Branches"
                                    />
                                </>
                            )}
                            <Button variant="outline" size="sm" onClick={resetReportFilters} className="h-10 w-10 p-0 rounded-xl border-slate-200 dark:border-slate-800" aria-label="Reset report filters" title="Reset report filters">
                                <RefreshCw className={cn("h-3.5 w-3.5 text-slate-400", isReportLoading && "animate-spin")} />
                            </Button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="outline" className="h-10 rounded-xl font-black text-[10px] tracking-widest uppercase">
                                        <Upload className="h-3.5 w-3.5 mr-2" /> Export
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="rounded-xl border-slate-200">
                                    <DropdownMenuItem onClick={() => handleExport('csv')} className="text-[10px] font-black uppercase">CSV</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleExport('excel')} className="text-[10px] font-black uppercase">Excel</DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleExport('pdf')} className="text-[10px] font-black uppercase">PDF</DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>

                        <Card className="rounded-[2rem] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl overflow-hidden min-h-[600px] flex flex-col">
                            <CardHeader className="px-8 pt-8 pb-4 border-b border-slate-100 dark:border-slate-800">
                                <div className="flex items-center justify-between flex-wrap gap-4">
                                    <CardTitle className="text-slate-900 dark:text-white font-black tracking-tight flex items-center gap-3">
                                        <div className="p-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl">
                                            <ListOrdered className="w-5 h-5 text-indigo-600" />
                                        </div>
                                        Organization Performance Ledger
                                    </CardTitle>
                                    <div className="flex items-center gap-2">
                                        <Badge variant="outline" className="h-8 rounded-lg px-3 bg-slate-50 dark:bg-slate-900 text-[10px] font-black border-slate-200 dark:border-slate-800 uppercase tracking-widest text-slate-500">
                                            {filteredStats.length} ENTRIES
                                        </Badge>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0 flex-1 overflow-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-900/50">
                                            <TableHead className="pl-8 h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400">Organization</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Status</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Branches (Act/Ina)</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Managed Users</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right">{isBuyer ? "Purchase (PKR)" : "Revenue (PKR)"}</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right">Orders</TableHead>
                                            <TableHead className="px-8 h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Fulfillment</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isReportLoading ? (
                                            Array(6).fill(0).map((_, i) => (
                                                <TableRow key={i} className="h-20 animate-pulse border-b border-slate-50 dark:border-slate-900">
                                                    <TableCell colSpan={7}><div className="h-10 bg-slate-50 dark:bg-slate-900/50 rounded-xl mx-4" /></TableCell>
                                                </TableRow>
                                            ))
                                        ) : filteredStats.length === 0 ? (
                                            <TableRow>
                                                <TableCell colSpan={7} className="h-60 text-center">
                                                    <div className="flex flex-col items-center gap-4 opacity-30">
                                                        <Database className="h-12 w-12" />
                                                        <p className="text-xs font-black uppercase tracking-widest">No records found</p>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ) : (
                                            filteredStats.map((org: any) => (
                                                <TableRow key={org.organizationId} className="group hover:bg-slate-50/80 dark:hover:bg-slate-900/40 border-b border-slate-50 dark:border-slate-900 transition-all duration-200 h-20">
                                                    <TableCell className="pl-8">
                                                        <div className="flex flex-col">
                                                            <span className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight group-hover:text-indigo-600 transition-colors uppercase">{org.organizationName}</span>
                                                            <span className="text-[10px] font-bold text-slate-400 font-mono tracking-tight uppercase tracking-widest">ID: {org.organizationId}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center font-black">
                                                        <Badge variant="outline" className={cn("text-[10px] font-black uppercase tracking-widest", org.organizationStatus === "active" ? "bg-emerald-50 text-emerald-600 border-emerald-200" : org.organizationStatus === "deleted" ? "bg-rose-50 text-rose-600 border-rose-200" : "bg-amber-50 text-amber-600 border-amber-200")}>
                                                            {org.organizationStatus || "Unknown"}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center font-black">
                                                        <div className="flex items-center justify-center gap-6">
                                                            <div className="flex flex-col items-center">
                                                                <span className="text-sm text-emerald-600">{org.activeBranchCount}</span>
                                                                <span className="text-[8px] text-slate-400 uppercase tracking-widest font-black">Active</span>
                                                            </div>
                                                            <div className="h-6 w-[1px] bg-slate-100 dark:bg-slate-800" />
                                                            <div className="flex flex-col items-center">
                                                                <span className="text-sm text-slate-400 font-black">{org.inactiveBranchCount}</span>
                                                                <span className="text-[8px] text-slate-400 uppercase tracking-widest font-black">Inactive</span>
                                                            </div>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center">
                                                        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-indigo-50/50 dark:bg-indigo-500/10 rounded-xl border border-indigo-100 dark:border-indigo-500/10">
                                                            <Users className="h-3 w-3 text-indigo-500" />
                                                            <span className="text-sm font-black text-indigo-600 dark:text-indigo-400">{org.totalUserCount}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        <div className="flex flex-col items-end">
                                                            <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(org.revenue)}</span>
                                                            {compare && (
                                                                <div className={cn("text-[8px] font-black uppercase tracking-widest flex items-center gap-1",
                                                                    (org.comparison?.revenue > 0 && org.revenue > org.comparison?.revenue) ? "text-emerald-500" : "text-rose-500")}>
                                                                    {org.revenue > org.comparison?.revenue ? <ArrowUpRight className="h-2 w-2" /> : <ArrowDownRight className="h-2 w-2" />}
                                                                    SR {formatPKR(org.comparison?.revenue || 0)}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-right font-black text-sm text-slate-900 dark:text-white tracking-tight">
                                                        {org.orderCount.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="px-8 text-center">
                                                        <div className="flex items-center justify-center gap-8">
                                                            <div className="flex flex-col items-center">
                                                                <div className="flex items-center gap-1.5 text-emerald-600">
                                                                    <CheckCircle2 className="h-3 w-3" />
                                                                    <span className="text-sm font-black">{org.fulfilledCount}</span>
                                                                </div>
                                                                <span className="text-[8px] text-slate-400 uppercase tracking-widest font-black">Fulfilled</span>
                                                            </div>
                                                            <div className="flex flex-col items-center">
                                                                <div className="flex items-center gap-1.5 text-rose-500">
                                                                    <RotateCcw className="h-3 w-3" />
                                                                    <span className="text-sm font-black">{org.refundedCount}</span>
                                                                </div>
                                                                <span className="text-[8px] text-slate-400 uppercase tracking-widest font-black">Refunded</span>
                                                            </div>
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                            <div className="px-8 py-5 border-t border-slate-100 dark:border-slate-900 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                                    {filteredStats.length} {role === "SUPER_ADMIN" ? `organization${filteredStats.length !== 1 ? 's' : ''}` : `record${filteredStats.length !== 1 ? 's' : ''}`} listed
                                </p>
                                <p className="text-[10px] font-bold text-slate-300 dark:text-slate-700 font-mono italic" suppressHydrationWarning>
                                    GEN_TS: {generatedDate}
                                </p>
                            </div>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}

// ━━━ STANDARDIZED COMPONENTS ━━━


function OrgFilter({ selectedIds, onChange }: any) {
    const { data: orgs } = useSWR<any>(`/api/v1/organizations`, fetcher)
    const items = ((orgs as any)?.items || []).map((o: any) => ({ id: String(o.id), label: o.name }))

    return (
        <MultiSelectFilter
            title="Organizations"
            items={items}
            selectedIds={selectedIds}
            onChange={onChange}
            icon={<Building2 className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
            placeholder="Organizations"
        />
    )
}


function MonthFilter({ selected, onChange }: { selected: number[], onChange: (v: number[]) => void }) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const items = months.map((m, i) => ({ id: i + 1, label: m }))

    return (
        <MultiSelectFilter
            title="Months"
            items={items}
            selectedIds={selected}
            onChange={(ids) => onChange(ids.sort((a, b) => a - b))}
            icon={<Calendar className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
            placeholder="Months"
            showSearch={false}
        />
    )
}

function YearFilter({ selected, onChange, availableYears }: { selected: number[], onChange: (v: number[]) => void, availableYears: number[] }) {
    const items = availableYears.map(y => ({ id: y, label: String(y) }))

    return (
        <MultiSelectFilter
            title="Years"
            items={items}
            selectedIds={selected}
            onChange={(ids) => onChange(ids.sort((a, b) => b - a))}
            icon={<Layers className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
            placeholder="Years"
            showSearch={false}
        />
    )
}
