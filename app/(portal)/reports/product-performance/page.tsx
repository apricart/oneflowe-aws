"use client"

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import useSWR from "swr"
import { format } from "date-fns"
import { useAppContext } from "@/components/context/app-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
    Loader2, RefreshCw, Search, FileText, FileSpreadsheet, Download, LineChart, Package, Tags, AlertOctagon, TrendingUp, History, Layers, Calculator, ChevronDown, Check, ArrowUpRight, ArrowDownRight, ChartBar as ChartBarIcon, ShieldCheck, ShieldX, Eye, Building2, Filter, RotateCcw, X, LayoutGrid, LayoutDashboard, Database
} from "lucide-react"
import {
    ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell
} from "recharts"
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

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Checkbox } from "@/components/ui/checkbox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

import { GlobalDateFilter, type FilterPreset } from "@/components/dashboard/global-date-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { useBranches, useGlobalProducts, useOrganizations } from "@/lib/hooks/use-api"

import { ExpandableRowDrawer, type DetailField } from "@/components/reports/expandable-row-drawer"
import { ColumnSelector, useColumnSelector, type ColumnDef } from "@/components/reports/column-selector"
import { ProductFilter } from "@/components/reports/product-filter"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import { KPICard } from "@/components/reports/kpi-card"
import { Upload } from "lucide-react"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

const CHART_COLORS = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#818cf8', '#7c3aed', '#4f46e5', '#4338ca', '#6d28d9', '#5b21b6']
const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

const LEDGER_COLUMNS: ColumnDef[] = [
    { key: "date", label: "Date", defaultVisible: true },
    { key: "item", label: "Item / SKU", defaultVisible: true },
    { key: "branch", label: "Branch Context", defaultVisible: true },
    { key: "qty", label: "Qty", defaultVisible: true },
    { key: "unit_price", label: "Unit Price", defaultVisible: true },
    { key: "total", label: "Net Total", defaultVisible: true },
    { key: "tid", label: "Trans ID", defaultVisible: true },
    { key: "status", label: "Status", defaultVisible: true },
]

export default function ProductPerformancePage() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const { visibleKeys, isVisible, setVisibleKeys } = useColumnSelector(LEDGER_COLUMNS, "product-intelligence-ledger")

    const {
        organizationId,
        branchId: contextBranchId,
        branchIds: contextBranchIds,
        setBranchIds: setContextBranchIds,
        isInitialized
    } = useAppContext()

    const [searchTerm, setSearchTerm] = useState("")
    const [reportSearchTerm, setReportSearchTerm] = useState("")
    const [generatedDate, setGeneratedDate] = useState("")
    const [selectedRow, setSelectedRow] = useState<any>(null)
    const [drawerOpen, setDrawerOpen] = useState(false)
    const tabFromUrl = (searchParams.get("tab") as "analytics" | "reports") || "analytics"
    const [activeTab, setActiveTab] = useState<"analytics" | "reports">(tabFromUrl)

    useEffect(() => {
        if (tabFromUrl !== activeTab) {
            setActiveTab(tabFromUrl)
        }
    }, [tabFromUrl])
    const [expandedRow, setExpandedRow] = useState<string | null>(null)

    const { data: session, status: sessionStatus } = useSession()
    const role = (session?.user as any)?.role as Role
    const isBuyer = role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"
    const [hasMounted, setHasMounted] = useState(false)

    // Role-based terminology
    const kpiRevenueLabel = isBuyer ? "Total Purchased" : "Total Revenue"
    const chartTitleLabel = isBuyer ? "Top Products by Purchase" : "Top Products by Revenue"
    const tableRevenueHeader = isBuyer ? "Purchased" : "Revenue"
    const drawerRevenueLabel = isBuyer ? "Amount Purchased" : "Revenue Generated"
    const exportRevenueHeader = isBuyer ? "Purchased" : "Revenue"
    const barChartLegendLabel = isBuyer ? "PURCHASED" : "REVENUE"
    const revenueShortLabel = isBuyer ? "Purchased" : "Revenue"
    const analyticsSubtitleLabel = isBuyer ? "Consolidated purchase stream" : "Consolidated revenue stream"

    // URL States for filtering
    const presetFromUrl = (searchParams.get("preset") as FilterPreset) || "all"
    const startFromUrl = searchParams.get("startDate") || ""
    const endFromUrl = searchParams.get("endDate") || ""
    const compareFromUrl = searchParams.get("compare") === "true"

    const [compare, setCompare] = useState(compareFromUrl)
    const [compareRange, setCompareRange] = useState<{ startDate: Date; endDate: Date } | null>(null)

    // Multi-select month/year states
    const [selectedMonths, setSelectedMonths] = useState<number[]>(
        searchParams.get("months")?.split(",").map(Number).filter(n => !isNaN(n)) || []
    )
    const [selectedYears, setSelectedYears] = useState<number[]>(
        searchParams.get("years")?.split(",").map(Number).filter(n => !isNaN(n)) || []
    )
    const [compareMonths, setCompareMonths] = useState<number[]>(
        searchParams.get("compareMonths")?.split(",").map(Number).filter(n => !isNaN(n)) || []
    )
    const [compareYears, setCompareYears] = useState<number[]>(
        searchParams.get("compareYears")?.split(",").map(Number).filter(n => !isNaN(n)) || []
    )

    // Chart-local filters
    const [chartYears, setChartYears] = useState<number[]>([])
    const [chartMonths, setChartMonths] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const [chartBranchIds, setChartBranchIds] = useState<string[]>([])
    const [chartGroupIds, setChartGroupIds] = useState<string[]>([])
    const [chartOrgIds, setChartOrgIds] = useState<string[]>([])
    const [chartProductIds, setChartProductIds] = useState<string[]>([])
    const [globalGroupId, setGlobalGroupId] = useState<string>("")
    const hasInitializedChartDefaults = useRef(false)

    // Report-local filters
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportMonths, setReportMonths] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const [reportBranchIds, setReportBranchIds] = useState<string[]>([])
    const [reportGroupIds, setReportGroupIds] = useState<string[]>([])
    const [reportProductIds, setReportProductIds] = useState<string[]>([])
    const [reportOrganizationIds, setReportOrganizationIds] = useState<string[]>([])

    const lastSyncedBranchIds = useRef<string[]>([])

    // ━━━ SMART SYNC (Global to Local) ━━━
    useEffect(() => {
        const hasGlobalChanged = JSON.stringify(contextBranchIds) !== JSON.stringify(lastSyncedBranchIds.current)
        if (hasGlobalChanged && contextBranchIds.length > 0) {
            setChartBranchIds([...contextBranchIds])
            setReportBranchIds([...contextBranchIds])
            lastSyncedBranchIds.current = [...contextBranchIds]
        }
    }, [contextBranchIds])

    // ━━━ CASCADING SELECTION CLEARING ━━━
    useEffect(() => {
        setChartProductIds([])
        setChartBranchIds([])
        setChartGroupIds([])
        setChartOrgIds([])
        setReportProductIds([])
        setReportBranchIds([])
        setReportGroupIds([])
        setReportOrganizationIds([])
        lastSyncedBranchIds.current = [] // Reset sync tracking on org change
    }, [organizationId])

    useEffect(() => {
        setChartProductIds([])
        setChartBranchIds([])
        setChartGroupIds([])
    }, [chartOrgIds])

    useEffect(() => {
        setChartProductIds([])
        setChartBranchIds([])
    }, [chartGroupIds])

    useEffect(() => {
        setChartProductIds([])
    }, [chartBranchIds])

    useEffect(() => {
        setReportProductIds([])
        setReportBranchIds([])
        setReportGroupIds([])
    }, [reportOrganizationIds])

    useEffect(() => {
        setReportProductIds([])
        setReportBranchIds([])
    }, [reportGroupIds])

    useEffect(() => {
        setReportProductIds([])
    }, [reportBranchIds])

    const CHART_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    const toggleChartYear = (year: number) => setChartYears(prev => prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year])
    const toggleChartMonth = (month: number) => setChartMonths(prev => prev.includes(month) ? prev.filter(m => m !== month) : [...prev, month])
    const toggleChartBranch = (branchId: string) => setChartBranchIds(prev => prev.includes(branchId) ? prev.filter(b => b !== branchId) : [...prev, branchId])
    const toggleChartGroup = (groupId: string) => setChartGroupIds(prev => prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId])

    const toggleReportYear = (year: number) => setReportYears(prev => prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year])
    const toggleReportMonth = (month: number) => setReportMonths(prev => prev.includes(month) ? prev.filter(m => m !== month) : [...prev, month])
    const toggleReportBranch = (branchId: string) => setReportBranchIds(prev => prev.includes(branchId) ? prev.filter(b => b !== branchId) : [...prev, branchId])
    const toggleReportGroup = (groupId: string) => setReportGroupIds(prev => prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId])

    // ━━━ DATA FOR DYNAMIC FILTERS (All-Time) ━━━
    const allTimeQueryParams = new URLSearchParams()
    if (organizationId) allTimeQueryParams.set("organizationId", organizationId.toString())
    allTimeQueryParams.set("preset", "all")
    const { data: allTimeData } = useSWR<any>(isInitialized ? `/api/v1/analytics/products/performance?${allTimeQueryParams.toString()}` : null, fetcher)

    const { data: groupsData } = useSWR(organizationId ? `/api/v1/groups?organizationId=${organizationId}` : "/api/v1/groups", fetcher)
    const availableGroups = groupsData?.groups || []
    const { data: branchesData } = useSWR(organizationId ? `/api/v1/branches?organizationId=${organizationId}` : "/api/v1/branches", fetcher)
    const availableBranches = branchesData?.items || []

    // Organizations for filter display names
    const { data: orgsData } = useOrganizations()
    const availableOrgs = orgsData?.items || []

    // Products for filter display names
    const { data: productsData } = useGlobalProducts(organizationId ? String(organizationId) : undefined)
    const availableProducts = productsData?.items || []

    const validChartBranches = availableGroups.length > 0 && chartGroupIds.length > 0
        ? availableBranches.filter((b: any) => chartGroupIds.includes(String(b.groupId)))
        : availableBranches;

    const validReportBranches = availableGroups.length > 0 && reportGroupIds.length > 0
        ? availableBranches.filter((b: any) => reportGroupIds.includes(String(b.groupId)))
        : availableBranches;

    const availableChartYears = useMemo(() => {
        const years = new Set<number>()
        const currentY = new Date().getFullYear();

        // Derive from ALL-TIME trend data if available
        if (allTimeData?.trend?.length) {
            allTimeData.trend.forEach((d: any) => {
                const y = parseInt(d.date.split("-")[0]);
                if (!isNaN(y)) years.add(y);
            });
        }

        // Ensure at least current year
        if (years.size === 0) {
            years.add(currentY);
        }

        return Array.from(years).sort((a, b) => a - b)
    }, [allTimeData?.trend])

    // Smart defaults logic
    useEffect(() => {
        if (!hasInitializedChartDefaults.current && availableChartYears.length > 0) {
            const currentYear = new Date().getFullYear();
            if (availableChartYears.includes(currentYear)) {
                setChartYears([currentYear])
                setReportYears([currentYear])
            } else {
                setChartYears([availableChartYears[availableChartYears.length - 1]])
                setReportYears([availableChartYears[availableChartYears.length - 1]])
            }
            hasInitializedChartDefaults.current = true
        }
    }, [availableChartYears])

    const activePreset = presetFromUrl
    const dateRange = useMemo(() => {
        if (startFromUrl && endFromUrl) {
            return { startDate: new Date(startFromUrl), endDate: new Date(endFromUrl) }
        }
        return null
    }, [startFromUrl, endFromUrl])

    const handleDateChange = useCallback((
        range: { startDate: Date; endDate: Date } | null,
        preset: FilterPreset,
        compareMode?: boolean,
        compRange?: { startDate: Date; endDate: Date } | null,
        months: number[] = [],
        years: number[] = [],
        cMonths: number[] = [],
        cYears: number[] = []
    ) => {
        const params = new URLSearchParams(searchParams.toString())
        params.set("preset", preset)
        if (compareMode !== undefined) {
            params.set("compare", String(compareMode))
            setCompare(compareMode)
        }
        if (compRange !== undefined) {
            setCompareRange(compRange)
        }

        setSelectedMonths(months)
        setSelectedYears(years)
        setCompareMonths(cMonths)
        setCompareYears(cYears)

        if (months.length > 0) params.set("months", months.join(","))
        else params.delete("months")

        if (years.length > 0) params.set("years", years.join(","))
        else params.delete("years")

        if (cMonths.length > 0) params.set("compareMonths", cMonths.join(","))
        else params.delete("compareMonths")

        if (cYears.length > 0) params.set("compareYears", cYears.join(","))
        else params.delete("compareYears")

        if (range) {
            params.set("startDate", range.startDate.toISOString())
            params.set("endDate", range.endDate.toISOString())
        } else {
            params.delete("startDate")
            params.delete("endDate")
        }
        router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    }, [searchParams, pathname, router])

    const handleBranchChange = useCallback((ids: string[]) => {
        setContextBranchIds(ids)
    }, [setContextBranchIds])

    const getDefaultReportYears = useCallback(() => {
        const currentYear = new Date().getFullYear()
        if (availableChartYears.includes(currentYear)) return [currentYear]
        const latestYear = availableChartYears[availableChartYears.length - 1]
        return latestYear ? [latestYear] : []
    }, [availableChartYears])

    const getDefaultChartYears = useCallback(() => {
        const currentYear = new Date().getFullYear()
        if (availableChartYears.includes(currentYear)) return [currentYear]
        const latestYear = availableChartYears[availableChartYears.length - 1]
        return latestYear ? [latestYear] : []
    }, [availableChartYears])

    // ━━━ GLOBAL DATA (Bento Grid) ━━━
    const globalQueryParams = new URLSearchParams()
    
    // Security Isolation: Force branch if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) globalQueryParams.set("organizationId", organizationId.toString())
        if (adminBranchId) globalQueryParams.set("branchIds", String(adminBranchId))
    } else {
        if (organizationId) globalQueryParams.set("organizationId", organizationId.toString())
        if (contextBranchIds.length > 0) globalQueryParams.set("branchIds", contextBranchIds.join(","))
        if (globalGroupId) globalQueryParams.set("groupIds", globalGroupId)
    }

    if (selectedMonths.length > 0) globalQueryParams.set("months", selectedMonths.join(","))
    if (selectedYears.length > 0) globalQueryParams.set("years", selectedYears.join(","))
    if (dateRange) {
        globalQueryParams.set("startDate", dateRange.startDate.toISOString())
        globalQueryParams.set("endDate", dateRange.endDate.toISOString())
    }
    if (compare) globalQueryParams.set("compare", "true")

    // Fetches are deferred until the org/branch context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: globalPerfData, isLoading: isGlobalPerfLoading, mutate: mutateGlobalPerf } = useSWR<any>(isInitialized ? `/api/v1/analytics/products/performance?${globalQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ CHART DATA (Local Filtered) ━━━
    const isChartProductView = chartProductIds.length > 1
    const chartQueryParams = new URLSearchParams()
    
    // Security Isolation: Force branch if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) chartQueryParams.set("organizationIds", organizationId.toString())
        if (adminBranchId) chartQueryParams.set("branchIds", String(adminBranchId))
    } else {
        if (chartOrgIds.length > 0) chartQueryParams.set("organizationIds", chartOrgIds.join(","))
        else if (organizationId) chartQueryParams.set("organizationIds", organizationId.toString())
        if (chartBranchIds.length > 0) chartQueryParams.set("branchIds", chartBranchIds.join(","))
        if (chartGroupIds.length > 0) chartQueryParams.set("groupIds", chartGroupIds.join(","))
    }

    if (chartProductIds.length > 0) chartQueryParams.set("productIds", chartProductIds.join(","))
    if (chartMonths.length > 0) chartQueryParams.set("months", chartMonths.join(","))
    if (chartYears.length > 0) chartQueryParams.set("years", chartYears.join(","))
    if (compare) chartQueryParams.set("compare", "true")

    const { data: chartPerfData, isLoading: isChartPerfLoading, mutate: mutateChart } = useSWR<any>(isInitialized ? `/api/v1/analytics/products/performance?${chartQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    const resetChartFilters = useCallback(() => {
        setChartYears(getDefaultChartYears())
        setChartMonths([...ALL_MONTHS])
        setChartBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        setChartGroupIds([])
        setChartOrgIds([])
        setChartProductIds([])
        mutateChart()
    }, [contextBranchIds, getDefaultChartYears, mutateChart])

    // ━━━ REPORT DATA (Local Filtered) ━━━
    const reportQueryParams = new URLSearchParams()
    
    // Security Isolation: Force branch if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) reportQueryParams.set("organizationId", organizationId.toString())
        if (adminBranchId) reportQueryParams.set("branchIds", String(adminBranchId))
    } else {
        if (organizationId) reportQueryParams.set("organizationId", organizationId.toString())
        if (reportBranchIds.length > 0) reportQueryParams.set("branchIds", reportBranchIds.join(","))
        if (reportGroupIds.length > 0) reportQueryParams.set("groupIds", reportGroupIds.join(","))
        if (reportOrganizationIds.length > 0) reportQueryParams.set("organizationIds", reportOrganizationIds.join(","))
    }

    if (dateRange) {
        reportQueryParams.set("startDate", dateRange.startDate.toISOString())
        reportQueryParams.set("endDate", dateRange.endDate.toISOString())
    }
    if (reportProductIds.length > 0) reportQueryParams.set("productIds", reportProductIds.join(","))
    if (reportMonths.length > 0) reportQueryParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportQueryParams.set("years", reportYears.join(","))
    if (reportSearchTerm) reportQueryParams.set("searchTerm", reportSearchTerm)

    const { data: ledgerData, isLoading: isLedgerLoading, mutate: mutateLedger } = useSWR<any>(isInitialized ? `/api/v1/analytics/orders/itemized?${reportQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    const resetReportFilters = useCallback(() => {
        setReportYears(getDefaultReportYears())
        setReportMonths([...ALL_MONTHS])
        setReportBranchIds([])
        setReportGroupIds([])
        setReportProductIds([])
        setReportOrganizationIds([])
        setReportSearchTerm("")
        setExpandedRow(null)
        handleDateChange(null, "all")
        mutateLedger()
    }, [getDefaultReportYears, handleDateChange, mutateLedger])

    useEffect(() => {
        setHasMounted(true)
        setGeneratedDate(new Date().toLocaleString())

        if (!startFromUrl && !endFromUrl && selectedMonths.length === 0 && selectedYears.length === 0) {
            handleDateChange(null, "all")
        }
    }, [])

    const products = useMemo(() => {
        const p = globalPerfData?.data || []
        return [...p].sort((a: any, b: any) => (b.revenueGeneratedCents || 0) - (a.revenueGeneratedCents || 0))
    }, [globalPerfData])

    const chartProducts = useMemo(() => {
        const p = chartPerfData?.data || []
        return [...p].sort((a: any, b: any) => (b.revenueGeneratedCents || 0) - (a.revenueGeneratedCents || 0))
    }, [chartPerfData])

    const ledgerItems = useMemo(() => {
        const items = ledgerData?.data || []
        return [...items].sort((a: any, b: any) => new Date(b.orderCreatedAt).getTime() - new Date(a.orderCreatedAt).getTime())
    }, [ledgerData])

    const filteredLedger = useMemo(() => {
        if (!reportSearchTerm) return ledgerItems
        const term = reportSearchTerm.toLowerCase()
        return ledgerItems.filter((i: any) =>
            (i.itemCode || "").toLowerCase().includes(term) ||
            (i.itemDetails || "").toLowerCase().includes(term) ||
            (i.organizationName || "").toLowerCase().includes(term) ||
            (i.branchName || "").toLowerCase().includes(term) ||
            (i.userName || "").toLowerCase().includes(term) ||
            (i.userEmail || "").toLowerCase().includes(term) ||
            (i.tid || "").toLowerCase().includes(term) ||
            (i.employeeId && String(i.employeeId).toLowerCase().includes(term)) ||
            (i.userId && i.userId.toLowerCase().includes(term))
        )
    }, [ledgerItems, reportSearchTerm])

    const filteredProducts = products.filter((p: any) =>
        (p.productName || p.productCode || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (p.category || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (p.subCategory || "").toLowerCase().includes(searchTerm.toLowerCase())
    )

    const totalRevenue = products.reduce((sum: number, p: any) => sum + (p.revenueGeneratedCents || 0), 0)
    const totalOrdered = products.reduce((sum: number, p: any) => sum + (p.qtyOrdered || 0), 0)
    const totalVolume = products.reduce((sum: number, p: any) => sum + (p.qtyFulfilled || 0), 0)
    const totalRefunds = products.reduce((sum: number, p: any) => sum + (p.qtyRefunded || 0), 0)
    const totalRefundLoss = products.reduce((sum: number, p: any) => sum + (p.refundLossCents || 0), 0)
    const fulfillmentRate = totalOrdered > 0 ? (totalVolume / totalOrdered) * 100 : 0
    const refundRate = totalOrdered > 0 ? (totalRefunds / totalOrdered) * 100 : 0
    const activeProductCount = products.filter((p: any) => p.status === 'active').length
    const inactiveProductCount = products.filter((p: any) => p.status === 'inactive').length
    const deletedProductCount = products.filter((p: any) => p.status === 'deleted').length

    // Comparison Trends
    const comparison = globalPerfData?.comparison
    const getTrend = (current: number, prev: number) => {
        if (!prev || prev === 0) return undefined
        return ((current - prev) / prev) * 100
    }
    const revenueTrend = getTrend(totalRevenue, comparison?.totalRevenue || 0)
    const volumeTrend = getTrend(totalVolume, comparison?.totalVolume || 0)
    const refundTrend = getTrend(totalRefunds, comparison?.totalRefunds || 0)

    // ━━━ CHART DATA: Normalized trends ━━━
    const chartData = useMemo(() => {
        if (isChartProductView) {
            let productsData = chartPerfData?.data || []

            // Strictly filter by selected product IDs if provided
            if (chartProductIds.length > 0) {
                productsData = productsData.filter((p: any) =>
                    chartProductIds.includes(String(p.productId)) ||
                    chartProductIds.includes(String(p.id))
                )
            } else {
                // Otherwise only show products with some activity to avoid cluttered bars
                productsData = productsData.filter((p: any) => (p.qtyOrdered || 0) > 0)
            }

            // Slice to Top 20 for chart readability
            return productsData
                .sort((a: any, b: any) => (b.revenueGeneratedCents || 0) - (a.revenueGeneratedCents || 0))
                .slice(0, 20)
                .map((p: any) => ({
                    name: p.productName || p.productCode || "N/A",
                    revenue: Math.round((p.revenueGeneratedCents || 0) / 100),
                    compareRevenue: Math.round((p.compareRevenue || 0) / 100),
                    ordered: p.qtyOrdered || 0,
                    fulfilled: p.qtyFulfilled || 0,
                    refunded: p.qtyRefunded || 0,
                    fulfillRate: (p.qtyOrdered || 0) > 0 ? ((p.qtyFulfilled / p.qtyOrdered) * 100).toFixed(1) : "0.0",
                    fullName: p.productName
                }))
        }

        const trend = chartPerfData?.trend || []

        // If multiple years selected, show years on X-axis
        if (chartYears.length > 1) {
            return chartYears.sort((a, b) => a - b).map(year => {
                const yearStr = String(year);
                const yearData = trend.filter((d: any) => d.date.startsWith(yearStr));
                return {
                    name: yearStr,
                    revenue: Math.round(yearData.reduce((sum: number, d: any) => sum + (d.revenue || 0), 0) / 100),
                    compareRevenue: Math.round(yearData.reduce((sum: number, d: any) => sum + (d.compareRevenue || 0), 0) / 100),
                    ordered: yearData.reduce((sum: number, d: any) => sum + (d.qtyOrdered || 0), 0),
                    fulfilled: yearData.reduce((sum: number, d: any) => sum + (d.qtyFulfilled || 0), 0),
                    refunded: yearData.reduce((sum: number, d: any) => sum + (d.qtyRefunded || 0), 0),
                    fulfillRate: yearData.reduce((sum: number, d: any) => sum + (d.qtyOrdered || 0), 0) > 0
                        ? ((yearData.reduce((sum: number, d: any) => sum + (d.qtyFulfilled || 0), 0) / yearData.reduce((sum: number, d: any) => sum + (d.qtyOrdered || 0), 0)) * 100).toFixed(1)
                        : "0.0",
                    fullName: `${yearStr} Annual Performance`
                }
            });
        }

        const activeYear = chartYears.length === 1 ? chartYears[0] : new Date().getFullYear();
        const monthsToShow = chartMonths.length > 0 && chartMonths.length < 12
            ? [...chartMonths].sort((a, b) => a - b)
            : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

        return monthsToShow.map(m => {
            const dateStr = `${activeYear}-${String(m).padStart(2, '0')}`;
            const dataPoint = trend.find((d: any) => d.date === dateStr);
            return {
                name: CHART_MONTH_NAMES[m - 1],
                revenue: dataPoint ? Math.round(dataPoint.revenue / 100) : 0,
                compareRevenue: dataPoint ? Math.round((dataPoint.compareRevenue || 0) / 100) : 0,
                fullName: `${CHART_MONTH_NAMES[m - 1]} ${activeYear}`,
                ordered: dataPoint?.qtyOrdered || 0,
                fulfilled: dataPoint?.qtyFulfilled || 0,
                refunded: dataPoint?.qtyRefunded || 0,
                fulfillRate: dataPoint?.qtyOrdered > 0 ? ((dataPoint.qtyFulfilled / dataPoint.qtyOrdered) * 100).toFixed(1) : "0.0"
            }
        });
    }, [chartPerfData, chartYears, chartMonths, CHART_MONTH_NAMES, chartProductIds, isChartProductView])

    const isPriceCustom = reportGroupIds.length > 0 || reportOrganizationIds.length > 0
    const priceLabel = isBuyer ? "Unit Price" : (isPriceCustom ? "Price" : "Base Price")

    const handleRowClick = (item: any) => {
        setSelectedRow(item)
        setDrawerOpen(true)
    }

    const getDrawerFields = (item: any): DetailField[] => [
        { key: "s2", label: "Product Details", value: "", type: "section" },
        {
            key: "status", label: "Status", value: (
                <Badge className={cn(
                    "border-none text-[10px] uppercase font-black tracking-widest px-2.5 py-0.5",
                    item.status === "active" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" :
                        item.status === "inactive" ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" :
                            "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                )}>
                    {item.status}
                </Badge>
            )
        },
        { key: "productCode", label: "Product Code", value: item.productCode || "-", type: "mono" },
        { key: "productName", label: "Product Name", value: item.productName || "-" },
        { key: "category", label: "Category", value: item.categoryName || "-" },
        ...(!pricesHidden ? [{ key: "price", label: priceLabel, value: formatPKR((item.unitPriceCents || item.basePriceCents) / 100), type: "currency" as const }] : []),
        { key: "unit", label: "Unit", value: item.unit || "unit" },
        { key: "s3", label: pricesHidden ? "Quantities" : "Quantities & Revenue", value: "", type: "section" },
        { key: "qtyOrdered", label: "Qty Ordered", value: String(item.qtyOrdered || 0) },
        { key: "qtyFulfilled", label: "Qty Fulfilled", value: String(item.qtyFulfilled || 0) },
        ...(!pricesHidden ? [{ key: "revenue", label: drawerRevenueLabel, value: formatPKR(item.revenueGeneratedCents / 100), type: "currency" as const }] : []),
    ]

    const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
        const isReports = activeTab === "reports"
        const exportData = isReports ? filteredLedger : filteredProducts

        // ── Performance tab columns (all roles same, simple product summary) ──
        const performanceColumns = [
            { label: "Product Code",   value: (p: any) => p.productCode || "-" },
            { label: "Product Name",   value: (p: any) => p.productName || "-" },
            { label: "Category",       value: (p: any) => p.category || "-" },
            { label: "Sub-category",   value: (p: any) => p.subCategory || "-" },
            { label: "Status",         value: (p: any) => p.status || "active" },
            { label: "Qty Ordered",    value: (p: any) => p.qtyOrdered || 0 },
            { label: "Fulfilled",      value: (p: any) => p.qtyFulfilled || 0 },
            { label: "Refunded",       value: (p: any) => p.qtyRefunded || 0 },
            ...(!pricesHidden ? [
                { label: isBuyer ? "Unit Price (PKR)" : "Base Price (PKR)", value: (p: any) => ((p.unitPriceCents || p.basePriceCents || 0) / 100).toFixed(2) },
                { label: exportRevenueHeader, value: (p: any) => ((p.revenueGeneratedCents || 0) / 100).toFixed(2) },
            ] : []),
        ]

        // ── Reports/Ledger tab columns (role-aware) ──
        const ledgerColumns = [
            ...(role === "SUPER_ADMIN" ? [{ label: "Organization", value: (p: any) => p.organizationName || "N/A" }] : []),
            ...(role !== "BRANCH_ADMIN" ? [{ label: "Branch",      value: (p: any) => p.branchName || "-" }] : []),
            { label: "Order ID",       value: (p: any) => p.orderId || p.tid || "-" },
            { label: "Trans ID",       value: (p: any) => p.tid || "-" },
            { label: "Order Date",     value: (p: any) => new Date(p.orderCreatedAt).toLocaleDateString() },
            ...(role !== "BRANCH_ADMIN" ? [{ label: "Group",       value: (p: any) => p.group || "N/A" }] : []),
            ...(!pricesHidden ? [{ label: "Discount",       value: (_p: any) => "0" }] : []),
            { label: "User Info",      value: (p: any) => `${p.userName || ""}${p.userEmail ? ` (${p.userEmail})` : ""}`.trim() || "-" },
            { label: "Employee ID",    value: (p: any) => p.employeeId || (p.userId ? String(p.userId).split('-')[0] : "N/A") },
            { label: "Item Details",   value: (p: any) => `${p.itemDetails || "-"}${p.itemCode ? ` (${p.itemCode})` : ""}` },
            { label: "Qty Ordered",    value: (p: any) => p.qtyOrdered || 0 },
            { label: "Item Refunded",  value: (p: any) => (p.qtyOrdered || 0) - (p.qtyDelivered || 0) },
            { label: "Net Items",      value: (p: any) => p.qtyDelivered || 0 },
            ...(!pricesHidden ? [
                { label: "Unit Price (PKR)", value: (p: any) => ((p.priceCents || 0) / 100).toFixed(2) },
                { label: exportRevenueHeader, value: (p: any) => ((p.netTotalCents || 0) / 100).toFixed(2) },
            ] : []),
        ]

        const columns = isReports ? ledgerColumns : performanceColumns
        const headers = columns.map(c => c.label)
        const rows = exportData.map((p: any) => columns.map(c => c.value(p)))

        if (format === 'pdf') {
            const doc = new jsPDF('landscape')
            const reportTitle = isBuyer ? "Product Purchase Intelligence Report" : "Product Intelligence Report"
            doc.setFontSize(20); doc.text(reportTitle, 14, 20)
            doc.setFontSize(10); doc.text(`Generated: ${new Date().toLocaleString()} | Tab: ${activeTab.toUpperCase()}`, 14, 28)
            autoTable(doc, { startY: 40, head: [headers], body: rows, theme: 'grid' })
            doc.save(`${isBuyer ? 'product-purchase' : 'product-intelligence'}-${activeTab}-${new Date().getTime()}.pdf`)
            return
        }

        const worksheet = XLSX.utils.aoa_to_sheet([
            sanitizeSpreadsheetRow(headers),
            ...rows.map(sanitizeSpreadsheetRow),
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Performance")
        XLSX.writeFile(workbook, `${isBuyer ? 'product-purchase' : 'product-intelligence'}-${activeTab}-${new Date().getTime()}.${format === 'excel' ? 'xlsx' : 'csv'}`)
    }

    // Custom tooltip for horizontal bar chart
    const CustomBarTooltip = ({ active, payload }: any) => {
        if (!active || !payload?.length) return null
        const d = payload[0]?.payload
        return (
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl p-4 min-w-[220px]">
                <p className="font-bold text-sm text-slate-900 dark:text-white mb-2">{d.fullName}</p>
                <div className="space-y-1.5">
                    {!pricesHidden && (
                        <div className="flex justify-between text-xs">
                            <span className="text-slate-500">{revenueShortLabel}</span>
                            <span className="font-bold text-indigo-600">{formatPKR(d.revenue)}</span>
                        </div>
                    )}
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Ordered</span>
                        <span className="font-semibold">{d.ordered}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Fulfilled</span>
                        <span className="font-semibold text-emerald-600">{d.fulfilled}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                        <span className="text-slate-500">Refunded</span>
                        <span className="font-semibold text-rose-500">{d.refunded}</span>
                    </div>
                    <div className="pt-1 border-t border-slate-100 dark:border-slate-800 flex justify-between text-xs">
                        <span className="text-slate-500">Fulfillment</span>
                        <span className="font-bold text-emerald-600">{d.fulfillRate}%</span>
                    </div>
                </div>
            </div>
        )
    }

    const pricesHidden = Boolean((globalPerfData as any)?.pricesHidden || (chartPerfData as any)?.pricesHidden || (ledgerData as any)?.pricesHidden)
    const priceVisibilityKnown = [globalPerfData, chartPerfData, ledgerData].some((data: any) => typeof data?.pricesHidden === "boolean")
    const isPriceVisibilityPending = role === "BRANCH_ADMIN" && !priceVisibilityKnown

    if (!hasMounted || sessionStatus === "loading" || isPriceVisibilityPending) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-violet-600 to-indigo-700 flex items-center justify-center shadow-lg shadow-indigo-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
                            <TrendingUp className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Product Intelligence</h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                                <LayoutGrid className="h-3 w-3" />
                                Unified view of product performance
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
                        {role !== "BRANCH_ADMIN" && organizationId && (
                            <>
                                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
                                <MultiBranchFilter organizationId={organizationId} selectedBranchIds={contextBranchIds} onChange={setContextBranchIds} />
                            </>
                        )}
                        <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-indigo-500 transition-colors" onClick={() => { handleDateChange(null, "all", false, null, [], [], [], []); mutateGlobalPerf(); mutateLedger(); mutateChart(); }}>
                            <RefreshCw className={cn("h-4 w-4", (isGlobalPerfLoading || isLedgerLoading || isChartPerfLoading) && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="max-w-[1600px] mx-auto px-6 pt-10 space-y-10">
                {/* ━━━ KPI BENTO GRID ━━━ */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                    {!pricesHidden && (
                        <KPICard
                            title={kpiRevenueLabel}
                            value={formatPKR(totalRevenue / 100)}
                            icon={TrendingUp}
                            colorScheme="emerald"
                            trend={revenueTrend}
                            comparisonLabel="Prior"
                            comparisonValue={comparison ? formatPKR(comparison.totalRevenue / 100) : undefined}
                            isLoading={!globalPerfData}
                        />
                    )}
                    <KPICard
                        title="Qty Fulfilled"
                        value={totalVolume.toLocaleString()}
                        icon={Package}
                        colorScheme="blue"
                        trend={volumeTrend}
                        comparisonLabel="Prior"
                        comparisonValue={comparison ? comparison.totalVolume.toLocaleString() : undefined}
                        isLoading={!globalPerfData}
                    />
                    <KPICard
                        title={pricesHidden ? "Qty Refunded" : "Refund Loss"}
                        value={pricesHidden ? totalRefunds.toLocaleString() : formatPKR(totalRefundLoss / 100)}
                        icon={AlertOctagon}
                        colorScheme="rose"
                        trend={refundTrend}
                        comparisonLabel="Prior"
                        comparisonValue={comparison ? `${comparison.totalRefunds.toLocaleString()} items` : undefined}
                        isLoading={!globalPerfData}
                    />

                      <KPICard
                        title="Product Catalog"
                        value={products.length.toLocaleString()}
                        icon={Layers}
                        colorScheme="indigo"
                        trend={undefined}
                        comparisonLabel="Prior"
                        comparisonValue={comparison ? `${comparison.products.toLocaleString()} items` : undefined}
                        isLoading={!globalPerfData}
                    />
                 
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
                        {/* Revenue Chart */}
                        {/* Revenue Chart with Filters */}
                        <Card className="overflow-hidden border border-slate-200/80 dark:border-slate-800 shadow-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-3xl rounded-[2rem] relative group transition-all duration-700 hover:shadow-indigo-500/10 hover:border-indigo-400/40">
                            <CardHeader className="relative z-10 pb-4 border-b border-slate-100/80 dark:border-slate-800/50 space-y-4 bg-gradient-to-r from-slate-50/50 via-white/50 to-indigo-50/20 dark:from-slate-950/20 dark:via-slate-900/80 dark:to-indigo-950/10">
                                <div className="flex flex-row items-center justify-between">
                                    <div className="flex items-center gap-4">
                                        <CardTitle className="text-sm font-bold flex items-center gap-2.5 uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                            <div className="p-1.5 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
                                                <ChartBarIcon className="h-3.5 w-3.5" />
                                            </div>
                                            {chartTitleLabel}
                                        </CardTitle>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={resetChartFilters}
                                        className="h-7 text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-full px-3 gap-1 transition-all duration-200 hover:scale-105"
                                        aria-label="Reset analytics filters"
                                        title="Reset analytics filters"
                                    >
                                        <RefreshCw className={cn("h-3 w-3", isChartPerfLoading && "animate-spin")} /> Reset Defaults
                                    </Button>
                                </div>

                                {/* ── Chart Filters ── */}
                                <div className="flex flex-wrap items-center gap-3">
                                    <MultiSelectFilter
                                        title="Months"
                                        items={CHART_MONTH_NAMES.map((name, i) => ({ id: i + 1, label: name }))}
                                        selectedIds={chartMonths}
                                        onChange={(ids) => setChartMonths(ids.sort((a, b) => a - b))}
                                        icon={<Filter className="h-3.5 w-3.5 text-emerald-500" />}
                                        placeholder="Months"
                                        showSearch={false}
                                    />
                                    <MultiSelectFilter
                                        title="Years"
                                        items={availableChartYears.map(y => ({ id: y, label: String(y) }))}
                                        selectedIds={chartYears}
                                        onChange={(ids) => setChartYears(ids.sort((a, b) => b - a))}
                                        icon={<History className="h-3.5 w-3.5 text-indigo-500" />}
                                        placeholder="Years"
                                        showSearch={false}
                                    />
                                    {role === "SUPER_ADMIN" && (
                                        <>
                                            <OrganizationFilter
                                                selectedIds={chartOrgIds}
                                                onChange={setChartOrgIds}
                                                placeholder="Organizations"
                                            />
                                            {(chartOrgIds.length > 0 || organizationId) && (
                                                <>
                                                    <GroupFilter
                                                        selectedIds={chartGroupIds}
                                                        onChange={setChartGroupIds}
                                                        organizationId={organizationId || undefined}
                                                        organizationIds={chartOrgIds.length > 0 ? chartOrgIds : undefined}
                                                        disabled={chartBranchIds.length > 0}
                                                        placeholder="Groups"
                                                    />
                                                    <BranchFilter
                                                        selectedIds={chartBranchIds}
                                                        onChange={setChartBranchIds}
                                                        organizationId={organizationId || undefined}
                                                        organizationIds={chartOrgIds.length > 0 ? chartOrgIds : undefined}
                                                        groupIds={chartGroupIds}
                                                        placeholder="Branches"
                                                    />
                                                </>
                                            )}
                                            <ProductFilter
                                                selectedIds={chartProductIds}
                                                onChange={setChartProductIds}
                                                organizationId={organizationId || undefined}
                                                organizationIds={chartOrgIds.length > 0 ? chartOrgIds : undefined}
                                                groupIds={chartGroupIds}
                                                branchIds={chartBranchIds}
                                                placeholder="Products"
                                            />
                                        </>
                                    )}
                                    {role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && organizationId && (
                                        <>
                                            <GroupFilter
                                                selectedIds={chartGroupIds}
                                                onChange={setChartGroupIds}
                                                organizationId={organizationId}
                                                disabled={chartBranchIds.length > 0}
                                                placeholder="Groups"
                                            />
                                            <BranchFilter
                                                selectedIds={chartBranchIds}
                                                onChange={setChartBranchIds}
                                                organizationId={organizationId}
                                                groupIds={chartGroupIds}
                                                placeholder="Branches"
                                            />
                                            <ProductFilter
                                                selectedIds={chartProductIds}
                                                onChange={setChartProductIds}
                                                organizationId={organizationId}
                                                groupIds={chartGroupIds}
                                                branchIds={chartBranchIds}
                                                placeholder="Products"
                                            />
                                        </>
                                    )}
                                </div>

                                {/* Active Filters Badges */}
                                {chartYears.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 ml-1">
                                        {chartYears.map(y => (
                                            <Badge key={y} className="text-[10px] font-bold bg-gradient-to-r from-indigo-500 to-violet-500 text-white border-0 gap-1 cursor-pointer shadow-sm px-2.5 py-0.5 rounded-full" onClick={() => toggleChartYear(y)}>
                                                {y} <X className="h-2.5 w-2.5" />
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                {chartMonths.length > 0 && chartMonths.length < 12 && (
                                    <div className="flex flex-wrap gap-1.5 ml-1">
                                        {chartMonths.map(m => (
                                            <Badge key={m} className="text-[10px] font-bold bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0 gap-1 cursor-pointer shadow-sm px-2.5 py-0.5 rounded-full" onClick={() => toggleChartMonth(m)}>
                                                {CHART_MONTH_NAMES[m - 1]} <X className="h-2.5 w-2.5" />
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                {chartGroupIds.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 ml-1">
                                        {chartGroupIds.map(gid => {
                                            const gr = availableGroups.find((g: any) => String(g.id) === gid)
                                            return (
                                                <Badge key={gid} className="text-[10px] font-bold bg-gradient-to-r from-sky-500 to-blue-500 text-white border-0 gap-1 cursor-pointer shadow-sm px-2.5 py-0.5 rounded-full" onClick={() => toggleChartGroup(gid)}>
                                                    {gr?.name || gid} <X className="h-2.5 w-2.5" />
                                                </Badge>
                                            )
                                        })}
                                    </div>
                                )}
                                {chartBranchIds.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 ml-1">
                                        {chartBranchIds.map(bid => {
                                            const br = availableBranches.find((b: any) => String(b.id) === bid)
                                            return (
                                                <Badge key={bid} className="text-[10px] font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0 gap-1 cursor-pointer shadow-sm px-2.5 py-0.5 rounded-full" onClick={() => toggleChartBranch(bid)}>
                                                    {br?.name || bid} <X className="h-2.5 w-2.5" />
                                                </Badge>
                                            )
                                        })}
                                    </div>
                                )}
                            </CardHeader>
                            <CardContent className="pt-6 pb-6 pr-6 pl-0">
                                {isChartPerfLoading || isGlobalPerfLoading ? (
                                    <div className="h-[320px] flex items-center justify-center">
                                        <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
                                    </div>
                                ) : (
                                    <div className="h-[320px] w-full ml-4">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.3} />
                                                <XAxis
                                                    dataKey="name"
                                                    axisLine={false}
                                                    tickLine={false}
                                                    tick={{ fill: '#475569', fontSize: 11, fontWeight: 600 }}
                                                    dy={10}
                                                />
                                                <YAxis
                                                    axisLine={false}
                                                    tickLine={false}
                                                    tick={{ fill: '#94a3b8', fontSize: 10 }}
                                                    tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toString()}
                                                    dx={-10}
                                                />
                                                <Tooltip content={<CustomBarTooltip />} cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }} />
                                                <Legend
                                                    verticalAlign="top"
                                                    align="right"
                                                    iconType="circle"
                                                    wrapperStyle={{ paddingBottom: 20, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px' }}
                                                />
                                                <Bar
                                                    dataKey={pricesHidden ? "fulfilled" : "revenue"}
                                                    name={pricesHidden ? "FULFILLED QTY" : barChartLegendLabel}
                                                    fill="#6366f1"
                                                    radius={[6, 6, 0, 0]}
                                                    barSize={24}
                                                />
                                                {compare && (
                                                    <Bar
                                                        dataKey={pricesHidden ? "compareQty" : "compareRevenue"}
                                                        name="PRIOR PERIOD"
                                                        fill="#94a3b8"
                                                        fillOpacity={0.4}
                                                        radius={[6, 6, 0, 0]}
                                                        barSize={24}
                                                    />
                                                )}
                                            </ComposedChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Product Table */}
                        <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900">
                            <div className="p-4 border-b border-slate-100 dark:border-slate-800/50 flex flex-wrap justify-between items-center gap-3">
                                <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200 flex items-center gap-2">
                                    <Package className="h-4 w-4 text-indigo-500" />
                                    All Products
                                    <Badge variant="secondary" className="text-[10px] ml-1 font-mono">{filteredProducts.length}</Badge>
                                </h3>

                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="relative">
                                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                        <Input
                                            placeholder="Search products, employee #, or name..."
                                            className="pl-8 h-8 w-44 text-xs bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 rounded-lg"
                                            value={searchTerm}
                                            onChange={(e) => setSearchTerm(e.target.value)}
                                        />
                                    </div>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button size="sm" className="h-8 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5 px-3 rounded-lg shadow-lg shadow-indigo-600/20" disabled={isGlobalPerfLoading}>
                                                <Upload className="h-3.5 w-3.5" /> EXPORT
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="end" className="w-40 rounded-xl">
                                            <DropdownMenuItem onClick={() => handleExport('csv')} className="text-xs py-2 cursor-pointer font-bold"><FileText className="mr-2 h-4 w-4 text-slate-400" /> CSV</DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => handleExport('excel')} className="text-xs py-2 cursor-pointer font-bold"><FileSpreadsheet className="mr-2 h-4 w-4 text-emerald-500" /> Excel</DropdownMenuItem>
                                            <DropdownMenuItem onClick={() => handleExport('pdf')} className="text-xs py-2 cursor-pointer font-bold"><FileText className="mr-2 h-4 w-4 text-rose-500" /> PDF</DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/50 dark:bg-slate-800/30 border-b border-slate-200 dark:border-slate-800">
                                            <TableHead className="pl-6 h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500">Code</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500">Product Name</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500">Category</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500">Sub-category</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">Status</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">{compare ? "Qty Ord (A/B)" : "Qty Ordered"}</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center text-emerald-600">{compare ? "Fulfilled (A/B)" : "Fulfilled"}</TableHead>
                                            <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center text-rose-500">{compare ? "Refunded (A/B)" : "Refunded"}</TableHead>
                                            {!pricesHidden && <TableHead className="h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 text-center">{priceLabel}</TableHead>}
                                            {!pricesHidden && <TableHead className="text-right pr-6 h-10 text-[10px] font-bold uppercase tracking-wider text-slate-500 font-mono">{compare ? `${tableRevenueHeader} (A/B)` : tableRevenueHeader}</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isGlobalPerfLoading ? (
                                            <TableRow><TableCell colSpan={8} className="h-32 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-amber-500" /></TableCell></TableRow>
                                        ) : filteredProducts.length === 0 ? (
                                            <TableRow><TableCell colSpan={8} className="h-32 text-center text-slate-500 text-sm">No products found.</TableCell></TableRow>
                                        ) : (
                                            filteredProducts.map((p: any) => (
                                                <TableRow key={p.productId} className="hover:bg-amber-50/40 dark:hover:bg-amber-900/10 border-b border-slate-100 dark:border-slate-800/50">
                                                    <TableCell className="font-mono text-[11px] pl-6 text-slate-500 font-semibold">{p.productCode}</TableCell>
                                                    <TableCell className="font-medium text-xs text-slate-900 dark:text-slate-200">
                                                        <div className="flex flex-col">
                                                            <span>{p.productName}</span>
                                                            <span className="text-[10px] text-slate-400 bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded w-fit mt-1">{p.unit}</span>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-xs text-slate-600 dark:text-slate-400">{p.category}</TableCell>
                                                    <TableCell className="text-xs text-slate-600 dark:text-slate-400">{p.subCategory}</TableCell>
                                                    <TableCell className="text-center">
                                                        <Badge
                                                            className={cn(
                                                                "text-[9px] uppercase px-2 py-0.5 rounded-full border-none font-bold tracking-wider",
                                                                (p.status === 'active' || !p.status)
                                                                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                                                                    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                                                            )}
                                                        >
                                                            {p.status || 'ACTIVE'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="text-center font-mono text-xs">
                                                        <div className="flex flex-col items-center">
                                                            <span>{p.qtyOrdered}</span>
                                                            {compare && <span className="text-[10px] text-slate-400 border-t border-slate-100 mt-0.5">{p.compareQtyOrdered || 0}</span>}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">
                                                        <div className="flex flex-col items-center">
                                                            <span>{p.qtyFulfilled}</span>
                                                            {compare && <span className="text-[10px] text-slate-400 border-t border-slate-100 mt-0.5 font-normal">{p.compareQty || 0}</span>}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell className="text-center font-mono font-bold text-xs text-rose-500">
                                                        <div className="flex flex-col items-center">
                                                            <span>{p.qtyRefunded}</span>
                                                            {compare && <span className="text-[10px] text-slate-400 border-t border-slate-100 mt-0.5 font-normal">{p.compareQtyRefunded || 0}</span>}
                                                        </div>
                                                    </TableCell>
                                                    {!pricesHidden && (
                                                        <TableCell className="text-center font-mono text-xs text-slate-600 dark:text-slate-400">
                                                            {formatPKR((p.unitPriceCents || p.basePriceCents) / 100)}
                                                        </TableCell>
                                                    )}
                                                    {!pricesHidden && (
                                                        <TableCell className="text-right font-mono font-bold text-xs text-slate-900 dark:text-white">
                                                            <div className="flex flex-col items-end">
                                                                <span>{formatPKR(p.revenueGeneratedCents / 100)}</span>
                                                                {compare && <span className="text-[10px] text-slate-400 border-t border-slate-100 mt-0.5 font-normal">{formatPKR((p.compareRevenue || 0) / 100)}</span>}
                                                            </div>
                                                        </TableCell>
                                                    )}
                                                </TableRow>
                                            ))
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </Card>
                    </TabsContent>
                    <TabsContent value="reports" className="space-y-6 animate-in fade-in slide-in-from-bottom-2">
                        {/* ━━━ REPORTS TAB ━━━ */}
                        <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900">
                            <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <History className="h-4 w-4 text-indigo-500" />
                                        <h3 className="font-bold text-sm uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                            {role === "SUPER_ADMIN" ? "Product Wise Sale" : "Product Wise Purchase"}
                                        </h3>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={resetReportFilters}
                                        className="h-7 text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-full px-3 gap-1 transition-all duration-200 hover:scale-105"
                                        aria-label="Reset report filters"
                                        title="Reset report filters"
                                    >
                                        <RotateCcw className="h-3 w-3" /> Reset Defaults
                                    </Button>
                                </div>

                                <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                                    {/* ── Report Filters ── */}
                                    <div className="flex flex-wrap items-center gap-3">
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
                                        <MultiSelectFilter
                                            title="Months"
                                            items={CHART_MONTH_NAMES.map((name, i) => ({ id: i + 1, label: name }))}
                                            selectedIds={reportMonths}
                                            onChange={(ids) => setReportMonths(ids.sort((a, b) => a - b))}
                                            icon={<Filter className="h-3.5 w-3.5 text-emerald-500" />}
                                            placeholder="Months"
                                            showSearch={false}
                                        />
                                        <MultiSelectFilter
                                            title="Years"
                                            items={availableChartYears.map(y => ({ id: y, label: String(y) }))}
                                            selectedIds={reportYears}
                                            onChange={(ids) => setReportYears(ids.sort((a, b) => b - a))}
                                            icon={<History className="h-3.5 w-3.5 text-indigo-500" />}
                                            placeholder="Years"
                                            showSearch={false}
                                        />
                                        {role === "SUPER_ADMIN" && (
                                            <>
                                                <OrganizationFilter
                                                    selectedIds={reportOrganizationIds}
                                                    onChange={(ids: string[]) => {
                                                        setReportOrganizationIds(ids)
                                                        setReportGroupIds([])
                                                        setReportBranchIds([])
                                                    }}
                                                    placeholder="Organizations"
                                                />
                                                <GroupFilter
                                                    selectedIds={reportGroupIds}
                                                    onChange={(ids: string[]) => {
                                                        setReportGroupIds(ids)
                                                        setReportBranchIds([])
                                                    }}
                                                    organizationId={organizationId || undefined}
                                                    organizationIds={reportOrganizationIds.length > 0 ? reportOrganizationIds : undefined}
                                                    disabled={reportBranchIds.length > 0}
                                                    placeholder="Groups"
                                                />
                                                {(reportOrganizationIds.length > 0 || organizationId) && (
                                                    <BranchFilter
                                                        selectedIds={reportBranchIds}
                                                        onChange={setReportBranchIds}
                                                        organizationId={organizationId || undefined}
                                                        organizationIds={reportOrganizationIds.length > 0 ? reportOrganizationIds : undefined}
                                                        groupIds={reportGroupIds}
                                                        placeholder="Branches"
                                                    />
                                                )}
                                            </>
                                        )}
                                        {role !== "SUPER_ADMIN" && role !== "BRANCH_ADMIN" && organizationId && (
                                            <>
                                                <GroupFilter
                                                    selectedIds={reportGroupIds}
                                                    onChange={setReportGroupIds}
                                                    organizationId={organizationId}
                                                    disabled={reportBranchIds.length > 0}
                                                    placeholder="Groups"
                                                />
                                                <BranchFilter
                                                    selectedIds={reportBranchIds}
                                                    onChange={setReportBranchIds}
                                                    organizationId={organizationId}
                                                    groupIds={reportGroupIds}
                                                    placeholder="Branches"
                                                />
                                            </>
                                        )}
                                        <ProductFilter
                                            selectedIds={reportProductIds}
                                            onChange={setReportProductIds}
                                            organizationId={organizationId || undefined}
                                            organizationIds={reportOrganizationIds}
                                            groupIds={reportGroupIds}
                                            branchIds={reportBranchIds}
                                            placeholder="Products"
                                        />
                                    </div>

                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                        <div className="relative w-full sm:w-[34rem] max-w-full">
                                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                                            <Input 
                                            placeholder="Search by employee #, code, product, user..."
                                            className="pl-8 h-8 w-full text-xs bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-700 rounded-lg"
                                            value={reportSearchTerm}
                                            onChange={(e) => setReportSearchTerm(e.target.value)}
                                        />    
                                        </div>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button size="sm" className="h-8 text-[11px] font-bold bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5 px-3 rounded-lg shadow-lg shadow-indigo-600/20" disabled={isLedgerLoading}>
                                                    <Upload className="h-3.5 w-3.5" /> EXPORT
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-40 rounded-xl">
                                                <DropdownMenuItem onClick={() => handleExport('csv')} className="text-xs py-2 cursor-pointer font-bold"><FileText className="mr-2 h-4 w-4 text-slate-400" /> CSV</DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => handleExport('excel')} className="text-xs py-2 cursor-pointer font-bold"><FileSpreadsheet className="mr-2 h-4 w-4 text-emerald-500" /> Excel</DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => handleExport('pdf')} className="text-xs py-2 cursor-pointer font-bold"><FileText className="mr-2 h-4 w-4 text-rose-500" /> PDF</DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                </div>

                                {/* Active Filters Badges */}
                                <div className="flex flex-wrap gap-2">
                                    {reportYears.length > 0 && reportYears.map(y => (
                                        <Badge key={y} className="text-[10px] font-bold bg-indigo-500 text-white gap-1 cursor-pointer rounded-full px-2.5 py-0.5" onClick={() => toggleReportYear(y)}>
                                            {y} <X className="h-2.5 w-2.5" />
                                        </Badge>
                                    ))}
                                    {reportMonths.length > 0 && reportMonths.length < 12 && reportMonths.map(m => (
                                        <Badge key={m} className="text-[10px] font-bold bg-emerald-500 text-white gap-1 cursor-pointer rounded-full px-2.5 py-0.5" onClick={() => toggleReportMonth(m)}>
                                            {CHART_MONTH_NAMES[m - 1]} <X className="h-2.5 w-2.5" />
                                        </Badge>
                                    ))}
                                    {reportGroupIds.length > 0 && reportGroupIds.map(gid => {
                                        const gr = availableGroups.find((g: any) => String(g.id) === gid)
                                        return (
                                            <Badge key={gid} className="text-[10px] font-bold bg-sky-500 text-white gap-1 cursor-pointer rounded-full px-2.5 py-0.5" onClick={() => toggleReportGroup(gid)}>
                                                {gr?.name || gid} <X className="h-2.5 w-2.5" />
                                            </Badge>
                                        )
                                    })}
                                    {reportBranchIds.length > 0 && reportBranchIds.map(bid => {
                                        const br = availableBranches.find((b: any) => String(b.id) === bid)
                                        return (
                                            <Badge key={bid} className="text-[10px] font-bold bg-amber-500 text-white gap-1 cursor-pointer rounded-full px-2.5 py-0.5" onClick={() => toggleReportBranch(bid)}>
                                                {br?.name || bid} <X className="h-2.5 w-2.5" />
                                            </Badge>
                                        )
                                    })}
                                    {reportOrganizationIds.length > 0 && reportOrganizationIds.map(oid => {
                                        const org = availableOrgs.find((o: any) => String(o.id) === oid)
                                        return (
                                            <Badge key={oid} className="text-[10px] font-bold bg-indigo-600 text-white gap-1 cursor-pointer rounded-full px-2.5 py-0.5" onClick={() => setReportOrganizationIds(prev => prev.filter(p => p !== oid))}>
                                                Org: {org?.name || oid} <X className="h-2.5 w-2.5" />
                                            </Badge>
                                        )
                                    })}
                                </div>
                            </div>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="bg-slate-50/20 dark:bg-slate-800/10">
                                            {role === "SUPER_ADMIN" && (
                                                <TableHead className="pl-6 h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">Organization</TableHead>
                                            )}
                                            {role !== "BRANCH_ADMIN" && <TableHead className={cn("h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap", role !== "SUPER_ADMIN" && "pl-6")}>Branch</TableHead>}
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">Order ID</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">Trans ID</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">Order Date</TableHead>
                                            {role !== "BRANCH_ADMIN" && <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">Group</TableHead>}
                                            {!pricesHidden && <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-center">Discount</TableHead>}
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap">User Details</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 min-w-[150px]">Item Details</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-center">Qty Ordered</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-center text-rose-500">Refunded</TableHead>
                                            <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-center text-emerald-600">Net Items</TableHead>
                                            {!pricesHidden && <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-center">Unit Price</TableHead>}
                                            {!pricesHidden && <TableHead className="h-10 text-[9px] font-black uppercase tracking-widest text-slate-400 whitespace-nowrap text-right pr-6">{exportRevenueHeader}</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {isLedgerLoading ? (
                                            <TableRow><TableCell colSpan={role === "SUPER_ADMIN" ? 14 : role === "BRANCH_ADMIN" ? 11 : 13} className="h-32 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-indigo-300" /></TableCell></TableRow>
                                        ) : filteredLedger.length === 0 ? (
                                            <TableRow><TableCell colSpan={role === "SUPER_ADMIN" ? 14 : role === "BRANCH_ADMIN" ? 11 : 13} className="h-32 text-center text-slate-400 text-xs">No itemized orders found.</TableCell></TableRow>
                                        ) : (
                                            filteredLedger.map((item: any) => {
                                                return (
                                                    <TableRow key={`${item.id}-${item.tid}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                                                        {role === "SUPER_ADMIN" && (
                                                            <TableCell className="pl-6 py-3 text-[10px] whitespace-nowrap text-slate-700 dark:text-slate-300 font-bold">
                                                                {item.organizationName || 'N/A'}
                                                            </TableCell>
                                                        )}
                                                        {role !== "BRANCH_ADMIN" && (
                                                            <TableCell className={cn("py-3 text-[10px] whitespace-nowrap text-slate-700 dark:text-slate-300 font-bold", role !== "SUPER_ADMIN" && "pl-6")}>
                                                                {item.branchName}
                                                            </TableCell>
                                                        )}
                                                        <TableCell className="py-3 text-[10px] whitespace-nowrap font-mono text-slate-500">
                                                            {item.orderId || item.tid}
                                                        </TableCell>
                                                        <TableCell className="py-3 text-[10px] whitespace-nowrap font-mono text-slate-500">
                                                            {item.tid}
                                                        </TableCell>
                                                        <TableCell className="py-3 text-[10px] whitespace-nowrap text-slate-600 dark:text-slate-400">
                                                            {new Date(item.orderCreatedAt).toLocaleDateString()}
                                                        </TableCell>
                                                        {role !== "BRANCH_ADMIN" && (
                                                            <TableCell className="py-3 text-[10px] whitespace-nowrap text-slate-600 dark:text-slate-400">
                                                                {item.group || "N/A"}
                                                            </TableCell>
                                                        )}
                                                        {!pricesHidden && (
                                                            <TableCell className="py-3 text-[10px] whitespace-nowrap text-center text-slate-400 font-mono">
                                                                0
                                                            </TableCell>
                                                        )}
                                                        <TableCell className="py-3 text-[10px] whitespace-nowrap">
                                                            <div className="flex flex-col">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="font-black text-indigo-500 font-mono text-[9px]">#{item.employeeId || (item.userId ? item.userId.split('-')[0] : 'N/A')}</span>
                                                                </div>
                                                                <span className="font-bold text-slate-900 dark:text-white uppercase truncate max-w-[120px]">{item.userName || "Unknown"}</span>
                                                                <span className="text-[9px] text-slate-500 truncate max-w-[120px]">{item.userEmail || "No Email"}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="py-3 max-w-[200px]">
                                                            <div className="flex flex-col">
                                                                <span className="font-bold text-[10px] text-slate-900 dark:text-white uppercase truncate" title={item.itemDetails}>
                                                                    {item.itemDetails}
                                                                </span>
                                                                <span className="text-[9px] text-slate-400 font-mono truncate">{item.itemCode}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell className="text-center font-mono text-[11px] font-bold text-slate-600 dark:text-slate-400">
                                                            {item.qtyOrdered}
                                                        </TableCell>
                                                        <TableCell className="text-center font-mono text-[11px] font-bold text-rose-500">
                                                            {item.qtyOrdered - item.qtyDelivered}
                                                        </TableCell>
                                                        <TableCell className="text-center font-mono text-[11px] font-bold text-emerald-600">
                                                            {item.qtyDelivered}
                                                        </TableCell>
                                                        {!pricesHidden && (
                                                            <TableCell className="text-center font-mono text-[11px] font-bold text-slate-600 dark:text-slate-400">
                                                                {formatPKR(item.priceCents / 100)}
                                                            </TableCell>
                                                        )}
                                                        {!pricesHidden && (
                                                            <TableCell className="text-right pr-6 font-mono text-[11px] font-black text-indigo-600">
                                                                {formatPKR(item.netTotalCents / 100)}
                                                            </TableCell>
                                                        )}
                                                    </TableRow>
                                                )
                                            })
                                        )}
                                    </TableBody>
                                </Table>
                            </div>
                        </Card>
                    </TabsContent>
                </Tabs>
            </div>

            <ExpandableRowDrawer
                open={drawerOpen} onClose={() => setDrawerOpen(false)}
                title={selectedRow?.productName || "Product Transaction"}
                subtitle={`${selectedRow?.branchName} • ${selectedRow?.productCode}`}
                fields={selectedRow ? getDrawerFields(selectedRow) : []}
            />
        </div>
    )
}
