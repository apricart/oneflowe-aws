"use client"

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useAppContext } from "@/components/context/app-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
    Loader2, RefreshCw, Search, FileText, FileSpreadsheet, Download, FolderTree, ShoppingBag, TrendingUp, ChevronDown, ChevronRight, Layers, LayoutGrid, Building2, Calendar, ShoppingCart, Percent, ArrowUpRight, ArrowDownRight, LayoutDashboard, Table as TableIcon, LineChart as LineChartIcon, RotateCcw
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
import { Upload } from "lucide-react"

type DateRange = { startDate: Date; endDate: Date }

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function GroupsReportPage() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const { organizationId: contextOrgId, isInitialized } = useAppContext()
    const [searchTerm, setSearchTerm] = useState("")
    const [generatedDate, setGeneratedDate] = useState("")
    const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set())
    const [activeTab, setActiveTab] = useState("analytics")

    const { data: session } = useSession()
    const role = (session?.user as any)?.role as Role
    const isBuyer = role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"
    const userOrgId = (session?.user as any)?.organizationId
    const [hasMounted, setHasMounted] = useState(false)

    useEffect(() => {
        if (hasMounted && role === "BRANCH_ADMIN") {
            router.push("/reports")
        }
    }, [hasMounted, role, router])

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
    const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>(contextOrgId ? [String(contextOrgId)] : [])
    const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
    const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([])
    const effectiveOrganizationId = selectedOrgIds[0] || contextOrgId || (role !== "SUPER_ADMIN" && userOrgId ? String(userOrgId) : "")

    useEffect(() => {
        if (role !== "SUPER_ADMIN") return
        setSelectedOrgIds(contextOrgId ? [String(contextOrgId)] : [])
        setSelectedGroupIds([])
        setSelectedBranchIds([])
    }, [contextOrgId, role])

    // ━━━ TIER 1: GLOBAL SUMMARY DATA ━━━
    const globalQueryParams = new URLSearchParams()
    if (dateRange) {
        globalQueryParams.set("startDate", dateRange.startDate.toISOString())
        globalQueryParams.set("endDate", dateRange.endDate.toISOString())
    }
    if (effectiveOrganizationId) globalQueryParams.set("organizationId", effectiveOrganizationId)
    if (selectedGroupIds.length > 0) globalQueryParams.set("groupIds", selectedGroupIds.join(","))
    if (selectedBranchIds.length > 0) globalQueryParams.set("branchIds", selectedBranchIds.join(","))
    if (selectedMonths.length > 0) globalQueryParams.set("months", selectedMonths.join(","))
    if (selectedYears.length > 0) globalQueryParams.set("years", selectedYears.join(","))
    if (compare) globalQueryParams.set("compare", "true")
    if (compareRange) {
        globalQueryParams.set("compareStartDate", compareRange.startDate.toISOString())
        globalQueryParams.set("compareEndDate", compareRange.endDate.toISOString())
    }
    if (compareMonths.length > 0) globalQueryParams.set("compareMonths", compareMonths.join(","))
    if (compareYears.length > 0) globalQueryParams.set("compareYears", compareYears.join(","))

    // Fetches are deferred until the org context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: globalData, isLoading: isGlobalLoading, mutate: mutateGlobal } = useSWR<any>(isInitialized ? `/api/v1/analytics/groups?summaryOnly=true&${globalQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 2: CHART (ANALYTICS) ━━━
    const [chartMonths, setChartMonths] = useState<number[]>([])
    const [chartYears, setChartYears] = useState<number[]>([])
    
    const chartQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (chartMonths.length > 0) chartQueryParams.set("months", chartMonths.join(","))
    if (chartYears.length > 0) chartQueryParams.set("years", chartYears.join(","))
    
    const { data: chartData, isLoading: isChartLoading, mutate: mutateChart } = useSWR<any>(isInitialized ? `/api/v1/analytics/groups?trendOnly=true&${chartQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 3: REPORT (TABLE) ━━━
    const [reportMonths, setReportMonths] = useState<number[]>([])
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportOrgIds, setReportOrgIds] = useState<string[]>([])
    const [reportSearch, setReportSearch] = useState("")

    const reportQueryParams = new URLSearchParams(globalQueryParams.toString())
    if (reportMonths.length > 0) reportQueryParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportQueryParams.set("years", reportYears.join(","))

    const { data: reportData, isLoading: isReportLoading, mutate: mutateReport } = useSWR<any>(isInitialized ? `/api/v1/analytics/groups?${reportQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ TIER 4: ALL-TIME (YEAR SELECTION) ━━━
    const { data: allTimeData } = useSWR<any>(isInitialized ? `/api/v1/analytics/groups?allTime=true&${globalQueryParams.toString()}` : null, fetcher)

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
        const defaultOrgIds = contextOrgId
            ? [String(contextOrgId)]
            : (role === "SUPER_ADMIN" ? [] : (userOrgId ? [String(userOrgId)] : []))

        setSelectedOrgIds(defaultOrgIds)
        setSelectedGroupIds([])
        setSelectedBranchIds([])
        setReportOrgIds([])
        setReportMonths(activePreset === "all" ? [...ALL_MONTHS] : [])
        setReportYears(activePreset === "all" ? [...allYears] : [])
        setReportSearch("")
        setDateRange(null)
        setActivePreset("all")
        setSelectedMonths([])
        setSelectedYears([])
        mutateReport()
    }, [activePreset, allYears, contextOrgId, mutateReport, role, userOrgId])

    const resetChartFilters = useCallback(() => {
        const defaultOrgIds = contextOrgId
            ? [String(contextOrgId)]
            : (role === "SUPER_ADMIN" ? [] : (userOrgId ? [String(userOrgId)] : []))

        setSelectedOrgIds(defaultOrgIds)
        setSelectedGroupIds([])
        setSelectedBranchIds([])
        setChartMonths(activePreset === "all" ? [...ALL_MONTHS] : [])
        setChartYears(activePreset === "all" ? [...allYears] : [])
        mutateChart()
    }, [activePreset, allYears, contextOrgId, mutateChart, role, userOrgId])

    const summary = globalData?.summary || { totalGroups: 0, totalOrders: 0, totalRevenue: 0, totalRefunds: 0 }
    const comparison = globalData?.comparison

    const revenueTrend = useMemo(() => {
        if (!compare || !comparison?.totalRevenue) return undefined
        return ((summary.totalRevenue - comparison.totalRevenue) / comparison.totalRevenue) * 100
    }, [summary.totalRevenue, comparison?.totalRevenue, compare])

    const orderTrend = useMemo(() => {
        if (!compare || !comparison?.totalOrders) return undefined
        return ((summary.totalOrders - comparison.totalOrders) / comparison.totalOrders) * 100
    }, [summary.totalOrders, comparison?.totalOrders, compare])

    const groups = reportData?.groups || []
    const filteredGroups = useMemo(() => {
        return groups.filter((g: any) => g.name?.toLowerCase().includes(reportSearch.toLowerCase()) || g.organizationName?.toLowerCase().includes(reportSearch.toLowerCase()))
    }, [groups, reportSearch])

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

    const toggleGroupExpansion = (groupId: number) => {
        setExpandedGroups((prev) => {
            const newSet = new Set(prev)
            if (newSet.has(groupId)) newSet.delete(groupId)
            else newSet.add(groupId)
            return newSet
        })
    }

    const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
        const money = (value: number | null | undefined) => ((value || 0) / 100).toFixed(2)
        const revenueHeader = isBuyer ? "Purchased (PKR)" : "Revenue (PKR)"

        // Keep exports aligned with the role-filtered table: each group row is followed by
        // only the branch rows already present in the authorized report payload.
        const headers = [
            "Group Name",
            ...(role === "SUPER_ADMIN" ? ["Organization"] : []),
            "Budget (PKR)",
            "Managed Units",
            revenueHeader,
            "Refunds (PKR)",
            "Orders",
        ]

        const exportRows = filteredGroups.flatMap((group: any) => {
            const groupRow = [
                `GROUP: ${group.name || "-"}`,
                ...(role === "SUPER_ADMIN" ? [group.organizationName || "-"] : []),
                money(group.totalBudget),
                group.branchCount || 0,
                money(group.totalAmountCents),
                money(group.totalRefundCents),
                group.totalOrders || 0,
            ]

            const branches = group.branches || []
            const branchHeadingRow = [
                `Branch details for ${group.name || "Group"}`,
                ...(role === "SUPER_ADMIN" ? [group.organizationName || "-"] : []),
                "",
                "",
                "",
                "",
                "",
            ]

            const branchRows = branches.map((branch: any) => [
                `  - ${branch.name || "-"}`,
                ...(role === "SUPER_ADMIN" ? [group.organizationName || "-"] : []),
                money(branch.totalBudget),
                branch.status || "Unknown",
                money(branch.revenue),
                money(branch.refunds),
                branch.orders || 0,
            ]).map((values: any[]) => ({ kind: "branch", values }))

            return [
                { kind: "group", values: groupRow },
                ...(branches.length > 0 ? [{ kind: "branch-heading", values: branchHeadingRow }] : []),
                ...branchRows,
            ]
        })
        const rows = exportRows.map((row: any) => row.values)

        if (format === 'pdf') {
            const doc = new jsPDF()
            doc.setFontSize(20); doc.text(isBuyer ? "Group Purchase Ledger" : "Group Performance Ledger", 14, 20)
            doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
            autoTable(doc, {
                startY: 40,
                head: [headers],
                body: rows,
                theme: 'grid',
                didParseCell: (data) => {
                    if (data.section !== "body") return

                    const rowKind = exportRows[data.row.index]?.kind
                    if (rowKind === "group") {
                        data.cell.styles.fillColor = [241, 245, 249]
                        data.cell.styles.fontStyle = "bold"
                    }
                    if (rowKind === "branch-heading") {
                        data.cell.styles.fillColor = [248, 250, 252]
                        data.cell.styles.textColor = [100, 116, 139]
                        data.cell.styles.fontStyle = "bold"
                    }
                },
            })
            doc.save(`group-report-${new Date().getTime()}.pdf`)
            return
        }

        const worksheet = XLSX.utils.aoa_to_sheet([
            sanitizeSpreadsheetRow(headers),
            ...rows.map(sanitizeSpreadsheetRow),
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Groups")
        XLSX.writeFile(workbook, `group-report-${new Date().getTime()}.${format === 'excel' ? 'xlsx' : 'csv'}`)
    }

    if (!hasMounted) return <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-slate-950"><Loader2 className="h-8 w-8 animate-spin text-indigo-500" /></div>

    return (
        <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-indigo-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
                            <FolderTree className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Group Intelligence</h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                                <LayoutGrid className="h-3 w-3" />
                                Branch Cluster Analytics
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
                        title={isBuyer ? "Group Total Purchased" : "Group Net Revenue"}
                        value={formatPKR(summary.totalRevenue / 100)}
                        icon={TrendingUp}
                        colorScheme="indigo"
                        trend={revenueTrend}
                        subtitle={isBuyer ? "Consolidated cluster purchases" : "Consolidated cluster sales"}
                        isLoading={!globalData}
                    />
                    <KPICard
                        title="Refund Impact"
                        value={formatPKR(summary.totalRefunds / 100)}
                        icon={RotateCcw}
                        colorScheme="rose"
                        subtitle="Total refunds processed"
                        isLoading={!globalData}
                    />
                    <KPICard
                        title="Clustered Orders"
                        value={summary.totalOrders.toLocaleString()}
                        icon={ShoppingBag}
                        colorScheme="violet"
                        trend={orderTrend}
                        subtitle="Total group transactions"
                        isLoading={!globalData}
                    />
                    <KPICard
                        title="Active Groups"
                        value={summary.totalGroups.toLocaleString()}
                        icon={FolderTree}
                        colorScheme="blue"
                        subtitle="Clustered entities"
                        isLoading={!globalData}
                    />
                </div>

                {/* ━━━ TABBED INTERFACE ━━━ */}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-8">
                    <div className="flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-1">
                        <TabsList className="bg-transparent h-auto p-0 gap-8">
                            <TabsTrigger value="analytics" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
                                <LayoutDashboard className="h-4 w-4 mr-2" />
                                Analytics
                            </TabsTrigger>
                            <TabsTrigger value="reports" className="bg-transparent border-b-2 border-transparent data-[state=active]:border-indigo-500 data-[state=active]:bg-transparent rounded-none px-0 pb-4 text-sm font-black uppercase tracking-widest text-slate-400 data-[state=active]:text-slate-900 dark:data-[state=active]:text-white transition-all">
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
                                            <div className="p-2 rounded-xl bg-violet-500/10 text-violet-500">
                                                <LineChartIcon className="h-4 w-4" />
                                            </div>
                                            <h3 className="font-black text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">{isBuyer ? "Group Monthly Purchases" : "Group Monthly Performance"}</h3>
                                        </div>
                                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest pl-11">{isBuyer ? "Consolidated purchase stream" : "Consolidated revenue stream"}</p>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={resetChartFilters} className="h-8 w-8 p-0 rounded-lg border-slate-200 dark:border-slate-800" aria-label="Reset analytics filters" title="Reset analytics filters">
                                        <RefreshCw className={cn("h-3.5 w-3.5 text-slate-400", isChartLoading && "animate-spin")} />
                                    </Button>
                                </div>
                                <div className="flex flex-wrap items-center gap-2.5 pt-1">
                                    {role === "SUPER_ADMIN" && (
                                        <>
                                            <OrgFilter 
                                                selectedIds={selectedOrgIds} 
                                                onChange={(ids: string[]) => { 
                                                    setSelectedOrgIds(ids); 
                                                    setSelectedGroupIds([]); 
                                                    setSelectedBranchIds([]); 
                                                }} 
                                                maxSelect={1} 
                                            />
                                            {effectiveOrganizationId && (
                                                <GroupFilter 
                                                    selectedIds={selectedGroupIds} 
                                                    onChange={(ids) => {
                                                        setSelectedGroupIds(ids);
                                                        setSelectedBranchIds([]);
                                                    }} 
                                                    organizationId={parseInt(effectiveOrganizationId)} 
                                                />
                                            )}
                                            {effectiveOrganizationId && (
                                                <BranchFilter 
                                                    selectedIds={selectedBranchIds} 
                                                    onChange={setSelectedBranchIds} 
                                                    organizationId={effectiveOrganizationId}
                                                    groupIds={selectedGroupIds}
                                                />
                                            )}
                                        </>
                                    )}
                                    {role !== "SUPER_ADMIN" && (userOrgId || contextOrgId) && (
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
                                        <div className="h-10 w-10 border-4 border-violet-500/20 border-t-violet-500 rounded-full animate-spin" />
                                        <p className="text-[10px] font-black uppercase text-slate-400">Syncing Analytics...</p>
                                    </div>
                                ) : (
                                    <div className="h-[450px] w-full">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={normalizedTrend} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.3} />
                                                <XAxis dataKey="period" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }} dy={10} />
                                                <YAxis axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 10, fontWeight: 700 }} tickFormatter={(v) => `₨${v >= 1000 ? (v/1000).toFixed(0)+'K' : v}`} />
                                                <Tooltip content={(props) => <CustomTooltip {...props} compare={compare} isBuyer={isBuyer} />} />
                                                <Legend verticalAlign="top" align="right" iconType="circle" wrapperStyle={{ paddingBottom: 30, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px' }} />
                                                <Bar dataKey="revenue" name={isBuyer ? "Total Purchased" : "Net Revenue"} fill="#8b5cf6" radius={[6, 6, 0, 0]} barSize={32} />
                                                {compare && <Bar dataKey="prevRevenue" name="Prior Period" fill="#cbd5e1" radius={[6, 6, 0, 0]} barSize={32} />}
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
                                <Input placeholder="Search groups..." value={reportSearch} onChange={(e) => setReportSearch(e.target.value)} className="pl-9 h-10 bg-slate-100/50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold font-mono" />
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
                                        selectedIds={selectedOrgIds} 
                                        onChange={(ids: string[]) => { 
                                            setSelectedOrgIds(ids); 
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
                                        organizationId={effectiveOrganizationId ? parseInt(effectiveOrganizationId) : undefined}
                                    />
                                    {effectiveOrganizationId && (
                                        <BranchFilter 
                                            selectedIds={selectedBranchIds} 
                                            onChange={setSelectedBranchIds} 
                                            organizationId={effectiveOrganizationId}
                                            groupIds={selectedGroupIds}
                                        />
                                    )}
                                </>
                            )}
                            {role !== "SUPER_ADMIN" && (userOrgId || contextOrgId) && (
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
                                        <div className="p-2 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl text-indigo-600">
                                            <LayoutGrid className="w-5 h-5" />
                                        </div>
                                        Group Performance Ledger
                                    </CardTitle>
                                    <Badge variant="outline" className="h-8 rounded-lg px-3 text-[10px] font-black uppercase tracking-widest text-slate-500 bg-slate-50 dark:bg-slate-900">
                                        {filteredGroups.length} ENTRIES
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent className="p-0">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/50 dark:bg-slate-900/50 border-b border-slate-100 dark:border-slate-800">
                                            <TableHead className="w-10 pl-6"></TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400">Group Name</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Budget</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Managed Units</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right">{isBuyer ? "Purchased (PKR)" : "Revenue (PKR)"}</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-right text-rose-500">Refunds</TableHead>
                                            <TableHead className="h-14 font-black text-[10px] uppercase tracking-[0.2em] text-slate-400 text-center">Orders</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isReportLoading ? (
                                            Array(6).fill(0).map((_, i) => (
                                                <TableRow key={i} className="h-20 animate-pulse"><TableCell colSpan={7}><div className="h-10 bg-slate-50 dark:bg-slate-900/50 rounded-xl mx-4" /></TableCell></TableRow>
                                            ))
                                        ) : filteredGroups.length === 0 ? (
                                            <TableRow><TableCell colSpan={7} className="h-60 text-center text-slate-400 text-xs font-black uppercase tracking-widest">No records found</TableCell></TableRow>
                                        ) : (
                                            filteredGroups.map((group: any) => {
                                                const isExpanded = expandedGroups.has(group.id)
                                                const hasBranches = group.branches && group.branches.length > 0
                                                return (
                                                    <Fragment key={group.id}>
                                                        <TableRow className="group hover:bg-slate-50/80 dark:hover:bg-slate-900/40 border-b border-slate-50 dark:border-slate-900 transition-all cursor-pointer h-20" onClick={() => hasBranches && toggleGroupExpansion(group.id)}>
                                                            <TableCell className="pl-6">
                                                                {hasBranches && (isExpanded ? <ChevronDown className="h-4 w-4 text-indigo-500" /> : <ChevronRight className="h-4 w-4 text-slate-300 group-hover:text-indigo-500" />)}
                                                            </TableCell>
                                                            <TableCell>
                                                                <div className="flex flex-col">
                                                                    <span className="text-sm font-black text-slate-900 dark:text-white uppercase tracking-tight group-hover:text-indigo-600 transition-colors uppercase">{group.name}</span>
                                                                    {role === "SUPER_ADMIN" && <span className="text-[10px] font-bold text-slate-400 tracking-widest uppercase italic">{group.organizationName}</span>}
                                                                </div>
                                                            </TableCell>
                                                            <TableCell className="text-center font-black">
                                                                <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(group.totalBudget / 100)}</span>
                                                            </TableCell>
                                                            <TableCell className="text-center font-black">
                                                                <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-50 dark:bg-indigo-500/10 rounded-full text-[10px]">
                                                                    <Building2 className="h-3 w-3 text-indigo-500" />
                                                                    <span className="text-indigo-600 dark:text-indigo-400 uppercase">{group.branchCount} Units</span>
                                                                </div>
                                                            </TableCell>
                                                            <TableCell className="text-right">
                                                                <span className="text-sm font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(group.totalAmountCents / 100)}</span>
                                                            </TableCell>
                                                            <TableCell className="text-right">
                                                                <span className="text-sm font-bold text-rose-500 tracking-tight">{formatPKR(group.totalRefundCents / 100)}</span>
                                                            </TableCell>
                                                            <TableCell className="text-center font-black text-sm text-slate-900 dark:text-white tracking-tight">
                                                                {group.totalOrders.toLocaleString()}
                                                            </TableCell>
                                                        </TableRow>
                                                        {isExpanded && group.branches.map((branch: any) => (
                                                            <TableRow key={`${group.id}-${branch.id}`} className="bg-slate-50/50 dark:bg-slate-900/20 border-b border-slate-100 dark:border-slate-800 transition-colors h-16">
                                                                <TableCell></TableCell>
                                                                <TableCell className="pl-10">
                                                                    <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400">
                                                                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                                                                        <span className="text-xs font-bold uppercase tracking-tight">{branch.name}</span>
                                                                    </div>
                                                                </TableCell>
                                                                <TableCell className="text-center font-black">
                                                                    <span className="text-xs font-bold text-slate-400 tracking-tight">{formatPKR(branch.totalBudget / 100)}</span>
                                                                </TableCell>
                                                                <TableCell className="text-center font-black">
                                                                    <Badge variant="outline" className={cn("text-[9px] font-black uppercase tracking-widest scale-90", branch.status === "active" ? "bg-emerald-50 text-emerald-600 border-emerald-200" : branch.status === "deleted" ? "bg-rose-50 text-rose-600 border-rose-200" : "bg-amber-50 text-amber-600 border-amber-200")}>
                                                                        {branch.status || "Unknown"}
                                                                    </Badge>
                                                                </TableCell>
                                                                <TableCell className="text-right text-xs font-bold text-slate-500">{formatPKR(branch.revenue / 100)}</TableCell>
                                                                <TableCell className="text-right text-xs font-bold text-rose-400/70">{formatPKR(branch.refunds / 100)}</TableCell>
                                                                <TableCell className="text-center text-xs font-bold text-slate-500">{branch.orders.toLocaleString()}</TableCell>
                                                            </TableRow>
                                                        ))}
                                                    </Fragment>
                                                )
                                            })
                                        )}
                                    </TableBody>
                                </Table>
                            </CardContent>
                            <div className="px-8 py-5 border-t border-slate-100 dark:border-slate-900 bg-slate-50/50 dark:bg-slate-900/40 flex items-center justify-between">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{filteredGroups.length} groups analyzed</p>
                                <p className="text-[10px] font-bold text-slate-300 dark:text-slate-700 font-mono italic" suppressHydrationWarning>GEN_TS: {generatedDate}</p>
                            </div>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}

function CustomTooltip({ active, payload, label, compare, isBuyer }: any) {
    if (active && payload && payload.length) {
        const d = payload[0].payload
        return (
            <div className="bg-white dark:bg-slate-900/95 p-4 border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl backdrop-blur-xl">
                <p className="text-[10px] font-black uppercase text-slate-400 mb-3 tracking-[0.2em]">{label}</p>
                <div className="space-y-3">
                    <div className="flex items-center justify-between gap-10">
                        <span className="text-xs font-bold text-slate-600 dark:text-slate-400 flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-indigo-500" /> {isBuyer ? "Total Purchased" : "Net Revenue"}
                        </span>
                        <span className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-tight">{formatPKR(payload[0].value)}</span>
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
    return null
}




function MonthFilter({ selected, onChange }: { selected: number[], onChange: (v: number[]) => void }) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const items = months.map((m, i) => ({ id: i + 1, label: m }))
    return <MultiSelectFilter title="Months" items={items} selectedIds={selected} onChange={(ids) => onChange(ids.sort((a, b) => a - b))} icon={<Calendar className="h-3.5 w-3.5 mr-2 text-indigo-500" />} placeholder="Months" showSearch={false} />
}

function YearFilter({ selected, onChange, availableYears }: { selected: number[], onChange: (v: number[]) => void, availableYears: number[] }) {
    const items = availableYears.map(y => ({ id: y, label: String(y) }))
    return <MultiSelectFilter title="Years" items={items} selectedIds={selected} onChange={(ids) => onChange(ids.sort((a, b) => a - b))} icon={<Layers className="h-3.5 w-3.5 mr-2 text-indigo-500" />} placeholder="Years" showSearch={false} />
}
