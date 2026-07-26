"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useAppContext } from "@/components/context/app-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
    Loader2, Building2, TrendingUp, Search, Download, FileText, FileSpreadsheet, RefreshCw, Trophy, Crown, BarChart3, Calculator, ChevronDown, ShoppingBag, RotateCcw, LayoutGrid, Calendar, Layers, MapPin, ArrowUpRight, ArrowDownRight, LayoutDashboard, Table as TableIcon, LineChart as LineChartIcon
} from "lucide-react"
import * as XLSX from "xlsx"
import { sanitizeSpreadsheetRow } from "@/lib/spreadsheet"
import { formatPKR, cn } from "@/lib/utils"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import { Badge } from "@/components/ui/badge"
import { Role } from "@/lib/rbac"
import { useSession } from "next-auth/react"
import { Input } from "@/components/ui/input"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts"
import { GlobalDateFilter, type FilterPreset } from "@/components/dashboard/global-date-filter"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { OrganizationFilter as OrgFilter } from "@/components/reports/organization-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { KPICard } from "@/components/reports/kpi-card"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { Upload } from "lucide-react"

type DateRange = { startDate: Date; endDate: Date }

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function BranchReportsPage() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const { data: session, status: sessionStatus } = useSession()
    const { 
        organizationId: contextOrgId,
        userBranchId: sessionUserBranchId,
        branchId: contextBranchId,
        branchIds: contextBranchIds,
        setBranchIds: setContextBranchIds,
        isInitialized
    } = useAppContext()

    const role = (session?.user as any)?.role as Role
    const userOrgId = (session?.user as any)?.organizationId
    const userBranchId = sessionUserBranchId || (session?.user as any)?.branchId
    const isBuyer = role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"

    // Role-based terminology
    const revenueLabel = isBuyer ? "Purchase" : "Revenue"
    const avgLabel = "Avg Order Value"
    const revenueHeader = isBuyer ? "Purchase" : "Revenue"
    const orderLabel = "Orders"
    const [hasMounted, setHasMounted] = useState(false)

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
    
    const [selectedMonths, setSelectedMonths] = useState<number[]>([])
    const [selectedYears, setSelectedYears] = useState<number[]>([])
    const [compareMonths, setCompareMonths] = useState<number[]>([])
    const [compareYears, setCompareYears] = useState<number[]>([])
    
    const [selectedOrgId, setSelectedOrgId] = useState<string>(contextOrgId ? String(contextOrgId) : (userOrgId ? String(userOrgId) : ""))
    const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
    const lastSyncedBranchIds = useRef<string[]>([])

    // ━━━ SMART SYNC (Global to Local) ━━━
    useEffect(() => {
        const hasGlobalChanged = JSON.stringify(contextBranchIds) !== JSON.stringify(lastSyncedBranchIds.current)
        if (hasGlobalChanged && contextBranchIds.length > 0) {
            setSelectedBranchIds([...contextBranchIds])
            lastSyncedBranchIds.current = [...contextBranchIds]
        }
    }, [contextBranchIds])
    const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>(
        role === "BRANCH_ADMIN" && userBranchId ? [String(userBranchId)] : []
    )
    
    const [generatedDate, setGeneratedDate] = useState("")
    const [activeTab, setActiveTab] = useState("analytics")

    // ━━━ TIER 1: GLOBAL SUMMARY DATA ━━━
    const globalQueryParams = new URLSearchParams()
    if (dateRange) {
        globalQueryParams.set("startDate", dateRange.startDate.toISOString())
        globalQueryParams.set("endDate", dateRange.endDate.toISOString())
    }

    // Security Isolation: Override all filters if role is BRANCH_ADMIN
    if (role === "BRANCH_ADMIN" && userBranchId) {
        if (userOrgId) globalQueryParams.set("organizationId", String(userOrgId))
        globalQueryParams.set("branchIds", String(userBranchId))
    } else {
        if (selectedOrgId) globalQueryParams.set("organizationId", selectedOrgId)
        if (selectedGroupIds.length > 0) globalQueryParams.set("groupIds", selectedGroupIds.join(","))
        if (selectedBranchIds.length > 0) globalQueryParams.set("branchIds", selectedBranchIds.join(","))
    }

    if (selectedMonths.length > 0) globalQueryParams.set("months", selectedMonths.join(","))
    if (selectedYears.length > 0) globalQueryParams.set("years", selectedYears.join(","))
    if (compare) globalQueryParams.set("compare", "true")
    if (compareRange) {
        globalQueryParams.set("compareStartDate", compareRange.startDate.toISOString())
        globalQueryParams.set("compareEndDate", compareRange.endDate.toISOString())
    }
    if (compareMonths.length > 0) globalQueryParams.set("compareMonths", compareMonths.join(","))
    if (compareYears.length > 0) globalQueryParams.set("compareYears", compareYears.join(","))

    // Fetches are deferred until the org/branch context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: globalData, isLoading: isGlobalLoading, mutate: mutateGlobal } = useSWR<any>(isInitialized ? `/api/v1/analytics/branches/performance?summaryOnly=true&${globalQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 2: CHART (ANALYTICS) ━━━
    const [chartMonths, setChartMonths] = useState<number[]>([])
    const [chartYears, setChartYears] = useState<number[]>([])
    
    const chartQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (chartMonths.length > 0) chartQueryParams.set("months", chartMonths.join(","))
    if (chartYears.length > 0) chartQueryParams.set("years", chartYears.join(","))
    
    const { data: chartData, isLoading: isChartLoading, mutate: mutateChart } = useSWR<any>(isInitialized ? `/api/v1/analytics/branches/performance?trendOnly=true&${chartQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 3: REPORT (TABLE) ━━━
    const [reportMonths, setReportMonths] = useState<number[]>([])
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportSearch, setReportSearch] = useState("")

    const reportQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (reportMonths.length > 0) reportQueryParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportQueryParams.set("years", reportYears.join(","))

    const { data: reportData, isLoading: isReportLoading, mutate: mutateReport } = useSWR<any>(isInitialized ? `/api/v1/analytics/branches/performance?${reportQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 4: ALL-TIME (YEAR SELECTION) ━━━
    const { data: allTimeData } = useSWR<any>(isInitialized ? `/api/v1/analytics/branches/performance?allTime=true&${globalQueryParams.toString()}` : null, fetcher)

    const isInitialLoad = useRef(true)

    useEffect(() => {
        setHasMounted(true)
        setGeneratedDate(new Date().toLocaleString())
    }, [])

    const allYears = useMemo(() => {
        const years = allTimeData?.years || []
        if (years.length === 0) return [new Date().getFullYear()]
        return years.sort((a: number, b: number) => b - a)
    }, [allTimeData])

    useEffect(() => {
        if (hasMounted && isInitialLoad.current && allYears.length > 0) {
            if (activePreset === "all") {
                setChartMonths([...ALL_MONTHS])
                setChartYears([...allYears])
                setReportMonths([...ALL_MONTHS])
                setReportYears([...allYears])
            }
            isInitialLoad.current = false
        }
    }, [hasMounted, allYears, activePreset])

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

    const resetReportFilters = useCallback(() => {
        const defaultOrgId = contextOrgId ? String(contextOrgId) : (userOrgId ? String(userOrgId) : "")
        const defaultBranchIds = role === "BRANCH_ADMIN" && userBranchId
            ? [String(userBranchId)]
            : (contextBranchIds.length > 0 ? [...contextBranchIds] : [])

        setSelectedOrgId(defaultOrgId)
        setSelectedGroupIds([])
        setSelectedBranchIds(defaultBranchIds)
        setReportMonths(activePreset === "all" ? [...ALL_MONTHS] : [])
        setReportYears(activePreset === "all" ? [...allYears] : [])
        setReportSearch("")
        setDateRange(null)
        setActivePreset("all")
        setSelectedMonths([])
        setSelectedYears([])
        mutateReport()
    }, [activePreset, allYears, contextBranchIds, contextOrgId, mutateReport, role, userBranchId, userOrgId])

    const resetChartFilters = useCallback(() => {
        const defaultOrgId = contextOrgId ? String(contextOrgId) : (userOrgId ? String(userOrgId) : "")
        const defaultBranchIds = role === "BRANCH_ADMIN" && userBranchId
            ? [String(userBranchId)]
            : (contextBranchIds.length > 0 ? [...contextBranchIds] : [])

        setSelectedOrgId(defaultOrgId)
        setSelectedGroupIds([])
        setSelectedBranchIds(defaultBranchIds)
        setChartMonths(activePreset === "all" ? [...ALL_MONTHS] : [])
        setChartYears(activePreset === "all" ? [...allYears] : [])
        mutateChart()
    }, [activePreset, allYears, contextBranchIds, contextOrgId, mutateChart, role, userBranchId, userOrgId])

    const summary = globalData?.summary || { totalOrders: 0, totalRevenue: 0, totalRefunds: 0, activeBranches: 0 }
    const comparison = globalData?.comparison

    const revenueTrend = useMemo(() => {
        if (!compare || !comparison?.totalRevenue) return undefined
        return ((summary.totalRevenue - comparison.totalRevenue) / comparison.totalRevenue) * 100
    }, [summary.totalRevenue, comparison?.totalRevenue, compare])

    const orderTrend = useMemo(() => {
        if (!compare || !comparison?.totalOrders) return undefined
        return ((summary.totalOrders - comparison.totalOrders) / comparison.totalOrders) * 100
    }, [summary.totalOrders, comparison?.totalOrders, compare])

    const branches = reportData?.items || []
    const filteredBranches = useMemo(() => {
        let list = branches.filter((b: any) => b.name?.toLowerCase().includes(reportSearch.toLowerCase()) || b.groupName?.toLowerCase().includes(reportSearch.toLowerCase()))
        
        // Security Fallback: Client-side filtering to ensure only authorized branch is shown
        if (role === "BRANCH_ADMIN" && userBranchId) {
            list = list.filter((b: any) => String(b.id) === String(userBranchId))
        }
        
        return list
    }, [branches, reportSearch, role, userBranchId])

    const normalizedTrend = useMemo(() => {
        const trend = chartData?.trend || []
        const currentYear = new Date().getFullYear()
        
        if (chartYears.length > 1) {
            return chartYears.sort((a,b) => a-b).map(year => {
                const yearData = trend.filter((t: any) => t.date.startsWith(String(year)))
                const compData = chartData?.compareTrend?.filter((t: any) => t.date.startsWith(String(year))) || []
                return {
                    period: String(year),
                    revenue: yearData.reduce((sum: number, t: any) => sum + (t.revenue || 0), 0) / 100,
                    orders: yearData.reduce((sum: number, t: any) => sum + (t.orders || 0), 0),
                    prevRevenue: compData.reduce((sum: number, t: any) => sum + (t.revenue || 0), 0) / 100
                }
            })
        }

        const activeYear = chartYears.length === 1 ? chartYears[0] : currentYear
        const monthsToShow = chartMonths.length > 0 && chartMonths.length < 12 ? [...chartMonths].sort((a,b) => a-b) : [1,2,3,4,5,6,7,8,9,10,11,12]
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

        return monthsToShow.map(m => {
            const periodKey = `${activeYear}-${String(m).padStart(2, '0')}`
            const monthData = trend.find((t: any) => t.date === periodKey)
            const compData = chartData?.compareTrend?.find((t: any) => t.date === periodKey)
            return {
                period: monthNames[m-1],
                revenue: (monthData?.revenue || 0) / 100,
                orders: monthData?.orders || 0,
                prevRevenue: (compData?.revenue || 0) / 100
            }
        })
    }, [chartData, chartMonths, chartYears])

    const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
        // Unified column definition matching the UI Table exactly
        const columns = [
            { label: "Rank",               value: (b: any, idx: number) => idx + 1 },
            { label: "Branch Name",        value: (b: any) => b.name || "-" },
            { label: "Status",             value: (b: any) => b.status?.toLowerCase() === 'active' ? 'Active' : b.status?.toLowerCase() === 'deleted' ? 'Deleted' : 'Inactive' },
            ...(role !== "BRANCH_ADMIN" ? [{ label: "Cluster / Group", value: (b: any) => b.groupName || "UNGROUPED" }] : []),
            ...(!pricesHidden ? [
                { label: `${revenueHeader} (PKR)`, value: (b: any) => (b.revenue / 100).toFixed(2) },
                { label: "Refunds (PKR)",      value: (b: any) => (b.refunds / 100).toFixed(2) },
            ] : []),
            { label: "Orders",             value: (b: any) => b.totalOrders || 0 },
            { label: "Fulfillment",        value: (b: any) => `${b.fulfilledOrders} / ${b.totalOrders}` }
        ]

        const headers = columns.map(c => c.label)
        const rows = filteredBranches.map((b: any, idx: number) => columns.map(c => c.value(b, idx)))

        if (format === 'pdf') {
            const doc = new jsPDF()
            doc.setFontSize(20); doc.text(isBuyer ? "Branch Purchase Ledger" : "Branch Performance Ledger", 14, 20)
            doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
            autoTable(doc, { startY: 40, head: [headers], body: rows, theme: 'grid' })
            doc.save(`branch-report-${new Date().getTime()}.pdf`)
            return
        }

        const worksheet = XLSX.utils.aoa_to_sheet([
            sanitizeSpreadsheetRow(headers),
            ...rows.map(sanitizeSpreadsheetRow),
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Branches")
        XLSX.writeFile(workbook, `branch-report-${new Date().getTime()}.${format === 'excel' ? 'xlsx' : 'csv'}`)
    }

    const pricesHidden = Boolean((globalData as any)?.pricesHidden || (chartData as any)?.pricesHidden || (reportData as any)?.pricesHidden)
    const priceVisibilityKnown = [globalData, chartData, reportData].some((data: any) => typeof data?.pricesHidden === "boolean")
    const isPriceVisibilityPending = role === "BRANCH_ADMIN" && !priceVisibilityKnown

    if (!hasMounted || sessionStatus === "loading" || isPriceVisibilityPending) return <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-slate-950"><Loader2 className="h-8 w-8 animate-spin text-emerald-500" /></div>

    return (
        <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-emerald-600 to-teal-700 flex items-center justify-center shadow-lg shadow-emerald-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
                            <MapPin className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">
                                {role === "BRANCH_ADMIN" ? "Branch Performance" : "Branch Intelligence"}
                            </h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                                <Building2 className="h-3 w-3" />
                                {role === "BRANCH_ADMIN" ? "Unit Performance Hub" : "Multi-Unit Performance Hub"}
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
                        {/* Filters moved to local tabs */}
                        {role !== "BRANCH_ADMIN" && (contextOrgId || userOrgId) && (
                            <>
                                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
                                <MultiBranchFilter organizationId={contextOrgId || userOrgId} selectedBranchIds={contextBranchIds} onChange={setContextBranchIds} />
                            </>
                        )}
                        <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-emerald-500 transition-colors" onClick={resetGlobalDateFilter}>
                            <RefreshCw className={cn("h-4 w-4", isGlobalLoading && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="max-w-[1600px] mx-auto px-6 pt-10 space-y-10">
                {/* ━━━ BENTO KPI GRID ━━━ */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {!pricesHidden && (
                        <KPICard
                            title={revenueLabel}
                            value={formatPKR(summary.totalRevenue / 100)}
                            icon={TrendingUp}
                            colorScheme="emerald"
                            trend={revenueTrend}
                            isLoading={!globalData}
                        />
                    )}
                    {!pricesHidden && (
                        <KPICard
                            title={avgLabel}
                            value={formatPKR(summary.totalOrders > 0 ? (summary.totalRevenue / summary.totalOrders) / 100 : 0)}
                            icon={Calculator}
                            colorScheme="blue"
                            isLoading={!globalData}
                        />
                    )}
                    <KPICard
                        title="Fulfilled Orders"
                        value={(summary.fulfilledOrders ?? 0).toLocaleString()}
                        icon={ShoppingBag}
                        colorScheme="indigo"
                        trend={orderTrend}
                        isLoading={!globalData}
                    />
                    <KPICard
                        title={role === "BRANCH_ADMIN" ? "Branch Unit" : "Active Units"}
                        value={summary.activeBranches.toLocaleString()}
                        icon={Building2}
                        colorScheme="amber"
                        isLoading={!globalData}
                    />
                </div>

                {/* ━━━ TABBED INTERFACE ━━━ */}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
                    <div className="flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-1">
                        <TabsList className="bg-transparent h-auto p-0 gap-8">
                            <TabsTrigger value="analytics" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-emerald-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
                                <LayoutDashboard className="h-4 w-4 mr-2" />
                                Analytics
                            </TabsTrigger>
                            <TabsTrigger value="reports" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-emerald-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
                                <TableIcon className="h-4 w-4 mr-2" />
                                Reports
                            </TabsTrigger>
                        </TabsList>
                    </div>

                    <TabsContent value="analytics" className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-2xl bg-white dark:bg-slate-900/50 backdrop-blur-3xl rounded-[2rem] relative group transition-all duration-700">
                            <div className="px-8 py-7 border-b border-slate-100 dark:border-slate-800 space-y-5">
                                <div className="flex items-center justify-between">
                                    <div className="space-y-1">
                                        <div className="flex items-center gap-2.5">
                                            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-500">
                                                <LineChartIcon className="h-4 w-4" />
                                            </div>
                                            <h3 className="font-black text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">Branch Monthly Trend</h3>
                                        </div>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-11">Comparative output analysis</p>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={resetChartFilters} className="h-8 w-8 p-0 rounded-lg border-slate-200 dark:border-slate-800" aria-label="Reset analytics filters" title="Reset analytics filters">
                                        <RefreshCw className={cn("h-3.5 w-3.5 text-slate-400", isChartLoading && "animate-spin")} />
                                    </Button>
                                </div>
                                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                                    {role === "SUPER_ADMIN" && (
                                        <>
                                            <OrgFilter 
                                                selectedIds={selectedOrgId ? [selectedOrgId] : []} 
                                                onChange={(ids: string[]) => { 
                                                    setSelectedOrgId(ids[0] || ""); 
                                                    setSelectedGroupIds([]); 
                                                    setSelectedBranchIds([]); 
                                                }} 
                                                maxSelect={1} 
                                            />
                                            {selectedOrgId && (
                                                <GroupFilter 
                                                    selectedIds={selectedGroupIds} 
                                                    onChange={(ids) => {
                                                        setSelectedGroupIds(ids);
                                                        setSelectedBranchIds([]);
                                                    }} 
                                                    organizationId={parseInt(selectedOrgId)} 
                                                />
                                            )}
                                            {selectedOrgId && (
                                                <BranchFilter 
                                                    selectedIds={selectedBranchIds} 
                                                    onChange={setSelectedBranchIds} 
                                                    organizationId={selectedOrgId}
                                                    groupIds={selectedGroupIds}
                                                />
                                            )}
                                        </>
                                    )}
                                    {role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && (userOrgId || contextOrgId) && (
                                        <>
                                            <GroupFilter 
                                                selectedIds={selectedGroupIds} 
                                                onChange={(ids) => {
                                                    setSelectedGroupIds(ids);
                                                    setSelectedBranchIds([]);
                                                }} 
                                                organizationId={parseInt(String(userOrgId || contextOrgId))} 
                                            />
                                            <BranchFilter 
                                                selectedIds={selectedBranchIds} 
                                                onChange={setSelectedBranchIds} 
                                                organizationId={String(userOrgId || contextOrgId)}
                                                groupIds={selectedGroupIds}
                                            />
                                        </>
                                    )}
                                    <MonthFilter selected={chartMonths} onChange={setChartMonths} />
                                     <YearFilter selected={chartYears} onChange={setChartYears} availableYears={allYears} />
                                </div>
                            </div>
                            <CardContent className="p-8">
                                {(isChartLoading || !normalizedTrend.length) ? (
                                    <div className="h-[450px] flex flex-col items-center justify-center gap-4 animate-pulse">
                                        <div className="h-10 w-10 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
                                        <p className="text-[10px] font-black uppercase text-slate-400">Syncing Analytics...</p>
                                    </div>
                                ) : (
                                    <div className="h-[450px] w-full">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={normalizedTrend} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.3} />
                                                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }} dy={10} />
                                                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }} tickFormatter={(v) => `₨${v >= 1000 ? (v/1000).toFixed(0)+'K' : v}`} />
                                                <Tooltip content={(props) => <CustomTooltip {...props} compare={compare} revenueLabel={revenueLabel} pricesHidden={pricesHidden} />} />
                                                <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ paddingBottom: 30, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px' }} />
                                                <Bar dataKey={pricesHidden ? "orders" : "revenue"} name={pricesHidden ? "Orders" : revenueLabel} fill="#10b981" radius={[6, 6, 0, 0]} barSize={32} />
                                                {compare && !pricesHidden && <Bar dataKey="prevRevenue" name={`Prior ${revenueLabel}`} fill="#cbd5e1" radius={[6, 6, 0, 0]} barSize={32} />}
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    </TabsContent>

                    <TabsContent value="reports" className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
                        <div className="flex flex-wrap items-center gap-2.5 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm">
                             <div className="relative flex-1 min-w-[240px]">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                                <Input placeholder="Search branches..." value={reportSearch} onChange={(e) => setReportSearch(e.target.value)} className="pl-9 h-10 bg-slate-100/50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold font-mono" />
                            </div>
                            <GlobalDateFilter
                                value={dateRange}
                                onChange={(range, preset, nextCompare, nextCompareRange, months, years, nextCompareMonths, nextCompareYears) => {
                                    handleDateChange(range, preset, nextCompare, nextCompareRange, months, years, nextCompareMonths, nextCompareYears)
                                    setReportMonths(months ?? [])
                                    setReportYears(years ?? [])
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
                            {role === "SUPER_ADMIN" && (
                                <>
                                    <OrgFilter 
                                        selectedIds={selectedOrgId ? [selectedOrgId] : []} 
                                        onChange={(ids: string[]) => { 
                                            setSelectedOrgId(ids[0] || ""); 
                                            setSelectedGroupIds([]); 
                                            setSelectedBranchIds([]); 
                                        }} 
                                        maxSelect={1} 
                                    />
                                    <GroupFilter
                                        selectedIds={selectedGroupIds}
                                        onChange={(ids: string[]) => {
                                            setSelectedGroupIds(ids);
                                            setSelectedBranchIds([]);
                                        }}
                                        organizationId={selectedOrgId ? parseInt(selectedOrgId) : undefined}
                                    />
                                    {selectedOrgId && (
                                        <BranchFilter 
                                            selectedIds={selectedBranchIds} 
                                            onChange={setSelectedBranchIds} 
                                            organizationId={selectedOrgId}
                                            groupIds={selectedGroupIds}
                                        />
                                    )}
                                </>
                            )}
                            {role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && (userOrgId || contextOrgId) && (
                                <>
                                    <GroupFilter 
                                        selectedIds={selectedGroupIds} 
                                        onChange={(ids) => {
                                            setSelectedGroupIds(ids);
                                            setSelectedBranchIds([]);
                                        }} 
                                        organizationId={parseInt(String(userOrgId || contextOrgId))} 
                                    />
                                    <BranchFilter 
                                        selectedIds={selectedBranchIds} 
                                        onChange={setSelectedBranchIds} 
                                        organizationId={String(userOrgId || contextOrgId)}
                                        groupIds={selectedGroupIds}
                                    />
                                </>
                            )}
                            <MonthFilter selected={reportMonths} onChange={setReportMonths} />
                             <YearFilter selected={reportYears} onChange={setReportYears} availableYears={allYears} />
                            <Button variant="outline" size="sm" onClick={resetReportFilters} className="h-10 w-10 p-0 rounded-xl" aria-label="Reset report filters" title="Reset report filters">
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

                        <Card className="rounded-[2rem] border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 shadow-2xl overflow-hidden min-h-[600px]">
                            <CardHeader className="px-8 pt-8 pb-4 border-b border-slate-100 dark:border-slate-800">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-slate-900 dark:text-white font-black tracking-tight flex items-center gap-3">
                                        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/30 rounded-xl text-emerald-600">
                                            <Trophy className="w-5 h-5" />
                                        </div>
                                        Branch Performance Rankings
                                    </CardTitle>
                                    <Badge variant="outline" className="h-8 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-50 dark:bg-slate-900">
                                        {filteredBranches.length} ENTRIES
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800">
                                            <TableHead className="pl-8 h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400">Rank & Branch</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Status</TableHead>
                                            {role !== "BRANCH_ADMIN" && <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400">Cluster / Group</TableHead>}
                                            {!pricesHidden && <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right">{revenueHeader} (PKR)</TableHead>}
                                            {!pricesHidden && <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right text-rose-500">Refunds</TableHead>}
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right">Orders</TableHead>
                                            <TableHead className="px-8 h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Fulfillment</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isReportLoading ? (
                                            Array(6).fill(0).map((_, i) => (
                                                <TableRow key={i} className="h-20 animate-pulse"><TableCell colSpan={role === "BRANCH_ADMIN" ? 6 : 7}><div className="h-10 bg-slate-50 dark:bg-slate-900/50 rounded-xl mx-4" /></TableCell></TableRow>
                                            ))
                                        ) : filteredBranches.length === 0 ? (
                                            <TableRow><TableCell colSpan={role === "BRANCH_ADMIN" ? 6 : 7} className="h-60 text-center text-slate-400 text-xs font-black uppercase tracking-widest">No branch records found</TableCell></TableRow>
                                        ) : (
                                            filteredBranches.map((branch: any, idx: number) => (
                                                <TableRow key={branch.id} className="group hover:bg-slate-50/80 dark:hover:bg-slate-900/40 border-b border-slate-50 dark:border-slate-900 transition-all h-20">
                                                    <TableCell className="pl-8">
                                                        <div className="flex items-center gap-4">
                                                            <div className={cn("h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold border", idx === 0 ? "bg-amber-100 border-amber-200 text-amber-700 shadow-sm" : idx === 1 ? "bg-slate-100 border-slate-200 text-slate-700" : "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-400")}>
                                                                {idx === 0 ? <Crown className="h-3.5 w-3.5" /> : idx + 1}
                                                            </div>
                                                            <div className="flex flex-col">
                                                                <span className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight group-hover:text-emerald-600 transition-colors uppercase">{branch.name}</span>
                                                                {role === "SUPER_ADMIN" && <span className="text-[10px] font-bold text-slate-400 tracking-widest uppercase italic">{branch.organizationName}</span>}
                                                            </div>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center font-black">
                                                        <Badge variant="outline" className={cn("text-[10px] font-black uppercase tracking-widest", branch.status?.toLowerCase() === "active" ? "bg-emerald-50 text-emerald-600 border-emerald-200" : branch.status?.toLowerCase() === "deleted" ? "bg-rose-50 text-rose-600 border-rose-200" : "bg-slate-50 text-slate-600 border-slate-200")}>
                                                            {branch.status?.toLowerCase() === 'active' ? 'Active' : branch.status?.toLowerCase() === 'deleted' ? 'Deleted' : 'Inactive'}
                                                        </Badge>
                                                    </TableCell>
                                                    {role !== "BRANCH_ADMIN" && (
                                                        <TableCell>
                                                            <Badge variant="secondary" className="bg-slate-100 dark:bg-slate-800 text-[10px] font-bold border-none uppercase tracking-tighter">
                                                                {branch.groupName || "UNGROUPED"}
                                                            </Badge>
                                                        </TableCell>
                                                    )}
                                                    {!pricesHidden && (
                                                        <TableCell className="text-right">
                                                            <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(branch.revenue / 100)}</span>
                                                        </TableCell>
                                                    )}
                                                    {!pricesHidden && (
                                                        <TableCell className="text-right">
                                                            <span className="text-sm font-bold text-rose-500 tracking-tight">{formatPKR(branch.refunds / 100)}</span>
                                                        </TableCell>
                                                    )}
                                                    <TableCell className="text-right font-black text-sm text-slate-900 dark:text-white tracking-tight">
                                                        {branch.totalOrders.toLocaleString()}
                                                    </TableCell>
                                                    <TableCell className="px-8 text-center font-black">
                                                        <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-50 dark:bg-emerald-500/10 rounded-full text-[10px] text-emerald-600">
                                                            {branch.fulfilledOrders} / {branch.totalOrders}
                                                        </div>
                                                    </TableCell>
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                            <div className="px-8 py-5 border-t border-slate-100 dark:border-slate-900 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{filteredBranches.length} units listed</p>
                                <p className="text-[10px] font-bold text-slate-300 dark:text-slate-700 font-mono italic" suppressHydrationWarning>GEN_TS: {generatedDate}</p>
                            </div>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}

function CustomTooltip({ active, payload, label, compare, revenueLabel, pricesHidden }: any) {
    if (active && payload && payload.length) {
        const d = payload[0].payload
        return (
            <div className="bg-white dark:bg-slate-900/95 p-4 border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl backdrop-blur-xl">
                <p className="text-[10px] font-black uppercase text-slate-400 mb-3 tracking-[0.2em]">{label}</p>
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-10">
                        <span className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-emerald-500" /> {pricesHidden ? "Orders" : revenueLabel}
                        </span>
                        <span className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-tight">{pricesHidden ? Number(payload[0].value || 0).toLocaleString() : formatPKR(payload[0].value)}</span>
                    </div>
                    {!pricesHidden && compare && (
                        <div className="flex items-center justify-between gap-10">
                            <span className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                                <div className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" /> Prior {revenueLabel}
                            </span>
                            <span className="text-xs font-black text-slate-500">{formatPKR(d.prevRevenue)}</span>
                        </div>
                    )}
                    <div className="pt-2 mt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                        <span className="text-[10px] font-black text-slate-400 uppercase">Orders</span>
                        <span className="text-xs font-black text-emerald-600">{d.orders}</span>
                    </div>
                </div>
            </div>
        )
    }
    return null
}




function MonthFilter({ selected, onChange }: { selected: number[], onChange: (v: number[]) => void }) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const items = months.map((m, i) => ({ id: i + 1, label: m }))
    return <MultiSelectFilter title="Months" items={items} selectedIds={selected} onChange={(ids) => onChange(ids.sort((a, b) => a - b))} icon={<Calendar className="h-3.5 w-3.5 mr-2 text-emerald-500" />} placeholder="Months" showSearch={false} />
}

function YearFilter({ selected, onChange, availableYears }: { selected: number[], onChange: (v: number[]) => void, availableYears: number[] }) {
    const items = availableYears.map(y => ({ id: y, label: String(y) }))
    return <MultiSelectFilter title="Years" items={items} selectedIds={selected} onChange={(ids) => onChange(ids.sort((a, b) => a - b))} icon={<Layers className="h-3.5 w-3.5 mr-2 text-emerald-500" />} placeholder="Years" showSearch={false} />
}
