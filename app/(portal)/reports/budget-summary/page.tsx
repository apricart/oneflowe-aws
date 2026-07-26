"use client"

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { useRouter, useSearchParams, usePathname } from "next/navigation"
import useSWR from "swr"
import { format, parse } from "date-fns"
import { fetcher } from "@/lib/fetcher"
import { useAppContext } from "@/components/context/app-context"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
    Filter, Building2, ChevronDown, RotateCcw, X, ReceiptText, FileText, DownloadIcon, Search, Calendar, Loader2,
    Wallet, LayoutGrid, RefreshCw, PiggyBank, LayoutDashboard, Database, Eye, EyeOff
} from "lucide-react"
import { motion, AnimatePresence } from "framer-motion"
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
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

import { GlobalDateFilter, type FilterPreset, getPresetLabel } from "@/components/dashboard/global-date-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { KPICard } from "@/components/reports/kpi-card"

import {
    ResponsiveContainer,
    ComposedChart,
    Area,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip as RechartsTooltip,
    Legend
} from 'recharts'
import { Upload } from "lucide-react"

interface BudgetSummaryResponse {
    pricesHidden?: boolean;
    summary: {
        totalAllocated: number;
        totalSpent: number;
        totalHeld: number;
        totalCredited: number;
        totalRemaining: number;
    };
    insights: {
        spentGrowth: number;
        allocationGrowth: number;
    };
    categories: Array<{
        categoryId: number;
        categoryName: string;
        allocated: number;
        spent: number;
        held: number;
        remaining: number;
        utilization: number;
    }>;
    branchBreakdown: Array<{
        branchId: number;
        branchName: string;
        allocated: number;
        spent: number;
        held: number;
        remaining: number;
        utilization: number;
        baselineAmount: number;
    }>;
    chartData: Array<{
        date: string;
        spentCents: number;
    }>;
}

const formatChartAxisPKR = (value: number) => {
    if (value >= 1000000) {
        const millions = value / 1000000;
        return `₨ ${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
    }

    if (value >= 1000) {
        const thousands = value / 1000;
        return `₨ ${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
    }

    return `₨ ${Number.isInteger(value) ? value : value.toFixed(0)}`;
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

export default function BudgetSummaryPage() {
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    const {
        organizationId,
        branchId: contextBranchId,
        branchIds: contextBranchIds,
        setBranchIds: setContextBranchIds,
        isInitialized
    } = useAppContext()

    const [searchTerm, setSearchTerm] = useState("")
    const [generatedDate, setGeneratedDate] = useState("")

    // Chart-local filters — default state
    const [chartYears, setChartYears] = useState<number[]>([]) // Will be initialized by useEffect
    const [chartMonths, setChartMonths] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const [chartBranchIds, setChartBranchIds] = useState<string[]>([])
    const [showBudgetBar, setShowBudgetBar] = useState(false)
    const hasInitializedChartDefaults = useRef(false)

    // Report-local filters
    const [reportYears, setReportYears] = useState<number[]>([])
    const [reportMonths, setReportMonths] = useState<number[]>([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const [reportBranchIds, setReportBranchIds] = useState<string[]>([])
    const [reportGroupIds, setReportGroupIds] = useState<string[]>([])

    const { data: session } = useSession()
    const role = (session?.user as any)?.role as Role
    const [hasMounted, setHasMounted] = useState(false)

    // URL States for filtering
    const presetFromUrl = (searchParams.get("preset") as FilterPreset) || "all"
    const startFromUrl = searchParams.get("startDate") || ""
    const endFromUrl = searchParams.get("endDate") || ""
    const activeTab = searchParams.get("tab") || "analytics"
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
        if (preset) params.set("preset", preset)

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

    // Build query string
    const queryParams = new URLSearchParams()

    // Security Isolation: Force branch/org if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) queryParams.set("organizationId", organizationId.toString())
        if (adminBranchId) queryParams.set("branchIds", String(adminBranchId))
    } else {
        if (organizationId) queryParams.set("organizationId", organizationId.toString())
        if (contextBranchIds.length > 0) {
            queryParams.set("branchIds", contextBranchIds.join(","))
        } else if (contextBranchId) {
            queryParams.set("branchId", contextBranchId)
        }
    }

    if (startFromUrl) queryParams.set("startDate", startFromUrl)
    if (endFromUrl) queryParams.set("endDate", endFromUrl)
    queryParams.set("preset", activePreset)
    if (selectedMonths.length > 0) queryParams.set("months", selectedMonths.join(","))
    if (selectedYears.length > 0) queryParams.set("years", selectedYears.join(","))
    if (compareMonths.length > 0) queryParams.set("compareMonths", compareMonths.join(","))
    if (compareYears.length > 0) queryParams.set("compareYears", compareYears.join(","))

    if (compare) {
        queryParams.set("compare", "true")
        if (compareRange) {
            queryParams.set("compareStartDate", compareRange.startDate.toISOString())
            queryParams.set("compareEndDate", compareRange.endDate.toISOString())
        }
    }

    const diffMs = dateRange ? (dateRange.endDate.getTime() - dateRange.startDate.getTime()) : 0;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    const granularity: "daily" | "monthly" | "yearly" = activePreset === "all" ? "yearly" : diffDays > 365 ? "yearly" : diffDays > 31 ? "monthly" : "daily";
    queryParams.set("granularity", granularity);

    // ━━━ PAGE DATA (Global) ━━━
    // Fetches are deferred until the org/branch context has hydrated, and
    // keepPreviousData keeps the current numbers on screen during filter changes
    const { data: pageData, isLoading: isPageLoading, mutate: mutatePage } = useSWR<BudgetSummaryResponse>(isInitialized ? `/api/v1/analytics/budgets/summary?${queryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    // ━━━ CHART DATA (All-Time Independent) ━━━
    const chartQueryParams = new URLSearchParams()

    // Security Isolation: Force branch/org if BRANCH_ADMIN
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) chartQueryParams.set("organizationId", organizationId.toString())
        if (adminBranchId) chartQueryParams.set("branchIds", String(adminBranchId))
    } else {
        if (organizationId) chartQueryParams.set("organizationId", organizationId.toString())
        if (contextBranchIds.length > 0) chartQueryParams.set("branchIds", contextBranchIds.join(","))
        else if (contextBranchId) chartQueryParams.set("branchId", contextBranchId)
    }

    chartQueryParams.set("preset", "all")
    chartQueryParams.set("granularity", "monthly")

    const { data: chartApiData, isLoading: isChartLoading } = useSWR<BudgetSummaryResponse>(isInitialized ? `/api/v1/analytics/budgets/summary?${chartQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    const reportQueryParams = new URLSearchParams()
    if (role === "BRANCH_ADMIN") {
        const adminBranchId = contextBranchId || (session?.user as any)?.branchId
        if (organizationId) reportQueryParams.set("organizationId", organizationId.toString())
        if (adminBranchId) reportQueryParams.set("branchIds", String(adminBranchId))
    } else {
        if (organizationId) reportQueryParams.set("organizationId", organizationId.toString())
        if (reportBranchIds.length > 0) reportQueryParams.set("branchIds", reportBranchIds.join(","))
        else if (contextBranchIds.length > 0) reportQueryParams.set("branchIds", contextBranchIds.join(","))
        else if (contextBranchId) reportQueryParams.set("branchId", contextBranchId)
    }
    if (reportGroupIds.length > 0) reportQueryParams.set("groupIds", reportGroupIds.join(","))
    if (startFromUrl) reportQueryParams.set("startDate", startFromUrl)
    if (endFromUrl) reportQueryParams.set("endDate", endFromUrl)
    reportQueryParams.set("preset", activePreset)
    if (reportMonths.length > 0) reportQueryParams.set("months", reportMonths.join(","))
    if (reportYears.length > 0) reportQueryParams.set("years", reportYears.join(","))
    reportQueryParams.set("granularity", "monthly")

    const { data: budgetReportData, isLoading: isReportLoading, mutate: mutateReport } = useSWR<BudgetSummaryResponse>(isInitialized ? `/api/v1/analytics/budgets/summary?${reportQueryParams.toString()}` : null, fetcher, { keepPreviousData: true })

    useEffect(() => {
        setHasMounted(true)
        setGeneratedDate(new Date().toLocaleString())

        // If no explicit preset/dates, force "All Time" filter
        if (!startFromUrl && !endFromUrl && !searchParams.has("preset")) {
            handleDateChange(null, "all")
        }
    }, [startFromUrl, endFromUrl, searchParams, handleDateChange])

    // ━━━ GLOBAL TO LOCAL FILTER SYNC ━━━
    // Use refs to track last synced values to prevent local overrides from being reverted
    const lastSyncedMonths = useRef([...selectedMonths])
    const lastSyncedYears = useRef([...selectedYears])
    const lastSyncedBranches = useRef([...contextBranchIds])

    useEffect(() => {
        const isActuallyChanged = JSON.stringify(selectedMonths) !== JSON.stringify(lastSyncedMonths.current)
        if (isActuallyChanged) {
            setChartMonths([...selectedMonths])
            setReportMonths([...selectedMonths])
            lastSyncedMonths.current = [...selectedMonths]
        }
    }, [selectedMonths])

    useEffect(() => {
        const isActuallyChanged = JSON.stringify(selectedYears) !== JSON.stringify(lastSyncedYears.current)
        if (isActuallyChanged) {
            setChartYears([...selectedYears])
            setReportYears([...selectedYears])
            lastSyncedYears.current = [...selectedYears]
        }
    }, [selectedYears])

    useEffect(() => {
        const isActuallyChanged = JSON.stringify(contextBranchIds) !== JSON.stringify(lastSyncedBranches.current)
        if (isActuallyChanged) {
            setChartBranchIds([...contextBranchIds])
            setReportBranchIds([...contextBranchIds])
            lastSyncedBranches.current = [...contextBranchIds]
        }
    }, [contextBranchIds])

    // Reset local filters when organization changes
    useEffect(() => {
        setChartBranchIds([])
        setReportBranchIds([])
    }, [organizationId])
    const MONTHS = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ]


    const handleMonthYearChange = (monthIdx: number, year: number) => {
        const startDate = new Date(year, monthIdx, 1)
        const endDate = new Date(year, monthIdx + 1, 0)
        handleDateChange({ startDate, endDate }, "custom")
    }

    const currentYear = dateRange?.startDate.getFullYear() || new Date().getFullYear()
    const currentMonthIdx = dateRange?.startDate.getMonth() || new Date().getMonth()

    const summary = pageData?.summary || { totalAllocated: 0, totalSpent: 0, totalHeld: 0, totalCredited: 0, totalRemaining: 0 }
    const insights = pageData?.insights || { spentGrowth: 0, allocationGrowth: 0 }
    const categories = pageData?.categories || []
    const branchBreakdown = pageData?.branchBreakdown || []

    const filteredCategories = categories.filter((c: any) =>
        (c.categoryName || "Uncategorized").toLowerCase().includes(searchTerm.toLowerCase())
    )

    const filteredBranches = branchBreakdown.filter((b: any) =>
        (b.branchName || "").toLowerCase().includes(searchTerm.toLowerCase())
    )



    const transformedChartData = useMemo(() => {
        if (!chartApiData?.chartData?.length) return []
        return chartApiData.chartData.map((d: any) => {
            const item: any = {
                date: format(new Date(d.date + "-01"), chartYears.length <= 1 ? "MMM" : "MMM yyyy"),
                rawDate: d.date,
                totalSpent: 0,
                totalBaseline: 0,
                totalAddon: 0,
                branches: d.branches || []
            };
            if (d.branches) {
                d.branches.forEach((b: any) => {
                    const baseline = b.baseline / 100;
                    const addon = b.addon / 100;
                    const spent = (b.spent || 0) / 100;
                    item[`${b.branchId}_baseline`] = baseline;
                    item[`${b.branchId}_addon`] = addon;
                    item[`${b.branchId}_spent`] = spent;
                    item.totalSpent += spent;
                    item.totalBaseline += baseline;
                    item.totalAddon += addon;
                });
            }
            item.totalLimit = item.totalBaseline + item.totalAddon;
            return item;
        })
    }, [chartApiData?.chartData, granularity, chartYears.length])

    const availableChartYears = useMemo(() => {
        const years = new Set<number>()
        const currentY = new Date().getFullYear();

        // Find earliest year in data
        let minYear = currentY;
        transformedChartData.forEach((d: any) => {
            if (d.rawDate) {
                const y = parseInt(d.rawDate.slice(0, 4))
                if (!isNaN(y)) {
                    years.add(y)
                    if (y < minYear) minYear = y;
                }
            }
        });

        // Ensure we show at least the range from minYear to current year
        for (let y = minYear; y <= currentY; y++) {
            years.add(y);
        }

        return Array.from(years).sort((a, b) => a - b)
    }, [transformedChartData])

    const uniqueBranches = useMemo(() => {
        const branches: { id: string; name: string }[] = []
        if (!chartApiData?.chartData) return []
        chartApiData.chartData.forEach((d: any) => {
            if (d.branches) {
                d.branches.forEach((b: any) => {
                    if (!branches.find(br => br.id === b.branchId)) {
                        branches.push({ id: b.branchId, name: b.branchName });
                    }
                });
            }
        });
        return branches;
    }, [chartApiData?.chartData])

    const calculatedReportBranches = useMemo(() => {
        if (!transformedChartData.length) return []

        const branchMap: Record<string, any> = {}

        transformedChartData.forEach((d: any) => {
            if (!d.rawDate) return;
            const yr = parseInt(d.rawDate.slice(0, 4))
            const mo = parseInt(d.rawDate.split("-")[1])

            // Apply reports-specific Year/Month filters
            if (reportYears.length > 0 && !reportYears.includes(yr)) return
            if (reportMonths.length > 0 && !reportMonths.includes(mo)) return

            if (d.branches) {
                d.branches.forEach((b: any) => {
                    // Apply reports-specific Branch filter
                    if (reportBranchIds.length > 0 && !reportBranchIds.includes(String(b.branchId))) return

                    if (!branchMap[b.branchId]) {
                        branchMap[b.branchId] = {
                            branchId: b.branchId,
                            branchName: b.branchName,
                            baselineAmount: 0,
                            spent: 0,
                            credited: 0,
                            held: 0
                        }
                    }
                    branchMap[b.branchId].baselineAmount += (b.baseline || 0)
                    branchMap[b.branchId].spent += (b.spent || 0)
                    branchMap[b.branchId].credited += (b.addon || 0)
                    branchMap[b.branchId].held += (b.held || 0)
                })
            }
        })

        return Object.values(branchMap)
    }, [transformedChartData, reportYears, reportMonths, reportBranchIds])

    const reportBranches = useMemo(() => {
        return budgetReportData ? (budgetReportData.branchBreakdown || []) : calculatedReportBranches
    }, [budgetReportData, calculatedReportBranches])

    const filteredReportBranches = useMemo(() => {
        return reportBranches.filter((b: any) =>
            (b.branchName || "").toLowerCase().includes(searchTerm.toLowerCase())
        )
    }, [reportBranches, searchTerm])

    // Smart defaults: if no year is selected, pick the CURRENT year if available, else latest
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

    const resetChartFilters = useCallback(() => {
        setChartYears(getDefaultChartYears())
        setChartMonths([...ALL_MONTHS])
        setChartBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        setShowBudgetBar(false)
    }, [contextBranchIds, getDefaultChartYears])

    const resetReportFilters = useCallback(() => {
        setReportYears(getDefaultReportYears())
        setReportMonths([...ALL_MONTHS])
        setReportBranchIds(contextBranchIds.length > 0 ? [...contextBranchIds] : [])
        setReportGroupIds([])
        setSearchTerm("")
        handleDateChange(null, "all")
        mutateReport()
    }, [contextBranchIds, getDefaultReportYears, handleDateChange, mutateReport])

    const CHART_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    // Filtered chart data based on chart-local filters
    const filteredChartData = useMemo(() => {
        let filtered = transformedChartData;

        // Filter by years
        if (chartYears.length > 0) {
            filtered = filtered.filter((d: any) => {
                if (!d.rawDate) return true
                const yr = parseInt(d.rawDate.slice(0, 4))
                return chartYears.includes(yr)
            })
        }

        // Filter by months
        if (chartMonths.length > 0) {
            filtered = filtered.filter((d: any) => {
                // Handle rawDate like "2026-03" or just "2026"
                if (!d.rawDate) return true;
                const dateParts = d.rawDate.split("-");
                // If it's a month-level string (YYYY-MM), check the month part
                if (dateParts.length >= 2) {
                    const mo = parseInt(dateParts[1]);
                    return chartMonths.length === 0 || chartMonths.includes(mo);
                }
                // If it's just a year string, or yearly granularity, might need adjustment
                return true;
            });
        }

        // Filter by branches: recalculate totals for only selected branches
        if (chartBranchIds.length > 0) {
            filtered = filtered.map((d: any) => {
                const newItem = { ...d, totalSpent: 0, totalBaseline: 0, totalAddon: 0 };
                chartBranchIds.forEach(bid => {
                    newItem.totalSpent += (d[`${bid}_spent`] || 0);
                    newItem.totalBaseline += (d[`${bid}_baseline`] || 0);
                    newItem.totalAddon += (d[`${bid}_addon`] || 0);
                });
                newItem.totalLimit = newItem.totalBaseline + newItem.totalAddon;
                return newItem;
            });
        }

        // PADDING: If exactly one year is selected (or none, defaulting to latest), ensure all selected months are represented
        if (chartYears.length <= 1) {
            const selectedYear = chartYears.length === 1 ? chartYears[0] : (availableChartYears[availableChartYears.length - 1] || new Date().getFullYear());
            const targetMonths = chartMonths.length > 0 ? [...chartMonths].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

            const padded: any[] = [];
            targetMonths.forEach(m => {
                const period = `${selectedYear}-${String(m).padStart(2, '0')}`;
                const existing = filtered.find((d: any) => d.rawDate === period);
                if (existing) {
                    padded.push(existing);
                } else {
                    // Create dummy month for the selected but empty period
                    const dummy: any = {
                        date: format(new Date(selectedYear, m - 1, 1), chartYears.length <= 1 ? "MMM" : "MMM yyyy"),
                        rawDate: period,
                        totalSpent: 0,
                        totalBaseline: 0,
                        totalAddon: 0,
                        totalLimit: 0
                    };
                    // Also zero out branch keys for tooltip
                    uniqueBranches.forEach(b => {
                        dummy[`${b.id}_baseline`] = 0;
                        dummy[`${b.id}_addon`] = 0;
                        dummy[`${b.id}_spent`] = 0;
                    });
                    padded.push(dummy);
                }
            });
            return padded;
        }

        return filtered;
    }, [transformedChartData, chartYears, chartMonths, chartBranchIds, uniqueBranches])

    // Auto-aggregate to yearly when too many data points for readable bars
    const chartDisplayData = useMemo(() => {
        if (filteredChartData.length <= 12) return filteredChartData;

        // Aggregate by year
        const yearMap: Record<string, any> = {};
        filteredChartData.forEach((d: any) => {
            if (!d.rawDate) return;
            const year = d.rawDate.slice(0, 4);
            if (!yearMap[year]) {
                yearMap[year] = { date: year, rawDate: year, totalSpent: 0, totalBaseline: 0, totalAddon: 0, totalLimit: 0 };
            }
            yearMap[year].totalSpent += d.totalSpent || 0;
            yearMap[year].totalBaseline += d.totalBaseline || 0;
            yearMap[year].totalAddon += d.totalAddon || 0;
            yearMap[year].totalLimit += d.totalLimit || 0;
            // Aggregate branch-level data
            uniqueBranches.forEach(b => {
                const spentKey = `${b.id}_spent`;
                const baselineKey = `${b.id}_baseline`;
                const addonKey = `${b.id}_addon`;

                yearMap[year][spentKey] = (yearMap[year][spentKey] || 0) + (d[spentKey] || 0);
                yearMap[year][baselineKey] = (yearMap[year][baselineKey] || 0) + (d[baselineKey] || 0);
                yearMap[year][addonKey] = (yearMap[year][addonKey] || 0) + (d[addonKey] || 0);
            });
        });
        return Object.values(yearMap).sort((a: any, b: any) => a.rawDate.localeCompare(b.rawDate));
    }, [filteredChartData, uniqueBranches])

    const isChartAggregated = filteredChartData.length > 12;

    // Determine which branches to show as individual bars in chart
    const chartVisibleBranches = useMemo(() => {
        if (chartBranchIds.length > 0) {
            return uniqueBranches.filter(b => chartBranchIds.includes(String(b.id)))
        }
        return uniqueBranches
    }, [uniqueBranches, chartBranchIds])

    const getBranchColor = (idx: number, type: 'baseline' | 'addon') => {
        const h = (idx * 137.5) % 360; // Golden angle for distribution
        return type === 'baseline' ? `hsl(${h}, 60%, 45%)` : `hsl(${h}, 40%, 70%)`;
    }

    const toggleChartYear = (year: number) => {
        setChartYears(prev => prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year])
    }
    const toggleChartMonth = (month: number) => {
        setChartMonths(prev => prev.includes(month) ? prev.filter(m => m !== month) : [...prev, month])
    }

    const toggleChartBranch = (branchId: string) => {
        setChartBranchIds(prev => prev.includes(branchId) ? prev.filter(b => b !== branchId) : [...prev, branchId])
    }

    const toggleReportYear = (year: number) => {
        setReportYears(prev => prev.includes(year) ? prev.filter(y => y !== year) : [...prev, year])
    }
    const toggleReportMonth = (month: number) => {
        setReportMonths(prev => prev.includes(month) ? prev.filter(m => m !== month) : [...prev, month])
    }
    const toggleReportBranch = (branchId: string) => {
        setReportBranchIds(prev => prev.includes(branchId) ? prev.filter(b => b !== branchId) : [...prev, branchId])
    }

    const handleExport = (format: 'csv' | 'excel' | 'pdf') => {
        // Export the full branch breakdown table to match the UI report
        const columns = [
            { label: "Branch Name",        value: (b: any) => b.branchName || "-" },
            { label: "Monthly Base (PKR)", value: (b: any) => ((b.baselineAmount || 0) / 100).toFixed(2) },
            { label: "Add-On Credit (PKR)",value: (b: any) => ((b.credited || 0) / 100).toFixed(2) },
            { label: "Total Budget (PKR)", value: (b: any) => (((b.baselineAmount || 0) + (b.credited || 0)) / 100).toFixed(2) },
            { label: "Spent (PKR)",        value: (b: any) => ((b.spent || 0) / 100).toFixed(2) },
            { label: "Remaining (PKR)",    value: (b: any) => ((((b.baselineAmount || 0) + (b.credited || 0)) - (b.spent || 0)) / 100).toFixed(2) },
            { label: "Utilization %",      value: (b: any) => {
                const total = (b.baselineAmount || 0) + (b.credited || 0)
                return total > 0 ? `${((b.spent || 0) / total * 100).toFixed(1)}%` : "0%"
            }},
        ]

        const headers = columns.map(c => c.label)
        const exportSource = filteredReportBranches.length > 0 ? filteredReportBranches : filteredBranches
        const rows = exportSource.map((b: any) => columns.map(c => c.value(b)))

        if (format === 'pdf') {
            const doc = new jsPDF()
            doc.setFontSize(20)
            doc.text("Budget Intelligence Report", 14, 20)
            doc.setFontSize(10)
            doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
            autoTable(doc, { startY: 40, head: [headers], body: rows, theme: 'grid', headStyles: { fillColor: [66, 66, 66] } })
            doc.save(`budget-intelligence-${new Date().getTime()}.pdf`)
            return
        }

        const worksheet = XLSX.utils.aoa_to_sheet([
            sanitizeSpreadsheetRow(headers),
            ...rows.map(sanitizeSpreadsheetRow),
        ])
        const workbook = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(workbook, worksheet, "Budget Intelligence")

        if (format === 'excel') {
            XLSX.writeFile(workbook, `budget-intelligence-${new Date().getTime()}.xlsx`)
        } else {
            XLSX.writeFile(workbook, `budget-intelligence-${new Date().getTime()}.csv`)
        }
    }

    const CustomTooltip = ({ active, payload, label }: any) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-slate-900/90 backdrop-blur-md border border-slate-700/50 p-3 rounded-lg shadow-xl">
                    <p className="text-white font-medium text-sm mb-2">{label}</p>
                    {payload.map((entry: any, index: number) => (
                        <div key={index} className="flex items-center gap-2 text-xs">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-slate-300">{entry.name}:</span>
                            <span className="text-white font-mono font-bold">
                                {formatPKR(entry.value)}
                            </span>
                        </div>
                    ))}
                </div>
            );
        }
        return null;
    };

    const renderSparkline = (dataKey: 'totalSpent' | 'totalBaseline' | 'totalAddon', color: string) => (
        <div className="h-10 w-full mt-2 opacity-80">
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={transformedChartData.slice(-14)}>
                    <Area type="monotone" dataKey={dataKey} stroke={color} fill={color} fillOpacity={0.2} strokeWidth={2} isAnimationActive={false} />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    )

    if (!hasMounted) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
            </div>
        )
    }

    const pricesHidden = Boolean(pageData?.pricesHidden || chartApiData?.pricesHidden || budgetReportData?.pricesHidden)
    if (pricesHidden) {
        return (
            <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] p-6">
                <Card className="mx-auto max-w-2xl border-slate-200 dark:border-slate-800">
                    <CardHeader>
                        <CardTitle>Budget reports hidden</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                        Financial budget reports are hidden by organization settings.
                    </CardContent>
                </Card>
            </div>
        )
    }

    const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9'];

    return (
        <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] transition-colors duration-500 pb-20">
            {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
            <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
                <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-700 flex items-center justify-center shadow-lg shadow-indigo-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
                            <Wallet className="h-6 w-6 text-white" />
                        </div>
                        <div>
                            <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Budget Intelligence</h1>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                                <LayoutGrid className="h-3 w-3" />
                                Core financial oversight
                            </p>
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
                        <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-indigo-500 transition-colors" onClick={() => handleDateChange(null, "all", false, null)}>
                            <RefreshCw className={cn("h-4 w-4", isPageLoading && "animate-spin")} />
                        </Button>
                    </div>
                </div>
            </div>

            <div className="max-w-[1600px] mx-auto px-6 pt-10 space-y-10">
                {/* ━━━ KPI BENTO GRID ━━━ */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    <KPICard
                        title="Allocated"
                        value={formatPKR((summary.totalAllocated + (summary.totalCredited || 0)) / 100)}
                        icon={Wallet}
                        colorScheme="emerald"
                        subtitle={`Base: ${formatPKR(summary.totalAllocated / 100)} | Addon: ${formatPKR(summary.totalCredited / 100)}`}
                        isLoading={!pageData}
                    />
                    <KPICard
                        title="Total Spent"
                        value={formatPKR(summary.totalSpent / 100)}
                        icon={ReceiptText}
                        colorScheme="blue"
                        subtitle="Total purchases processed"
                        isLoading={!pageData}
                    />
                    <KPICard
                        title="Remaining"
                        value={(summary.totalRemaining < 0 ? "-" : "+") + formatPKR(Math.abs(summary.totalRemaining) / 100)}
                        icon={PiggyBank}
                        colorScheme={summary.totalRemaining < 0 ? "rose" : "indigo"}
                        subtitle="Net Liquidity Asset Projection"
                        isLoading={!pageData}
                    />
                </div>

                <Tabs value={activeTab} onValueChange={(val) => {
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
                        {/* ━━━ CENTERPIECE DASHBOARD ━━━ */}
                        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
                            <Card className="xl:col-span-2 overflow-hidden border border-slate-200/80 dark:border-slate-800 shadow-2xl bg-white/95 dark:bg-slate-900/95 backdrop-blur-3xl rounded-[2rem] relative group transition-all duration-700 hover:shadow-indigo-500/10 hover:border-indigo-400/40">
                                {/* Premium mesh gradient glow */}
                                <div className="absolute top-0 right-0 -mr-32 -mt-32 w-80 h-80 bg-indigo-500/5 dark:bg-indigo-500/10 blur-[120px] pointer-events-none group-hover:bg-indigo-500/15 transition-all duration-1000 rounded-full" />
                                <div className="absolute bottom-0 left-0 -ml-32 -mb-32 w-80 h-80 bg-emerald-500/5 dark:bg-emerald-500/10 blur-[120px] pointer-events-none group-hover:bg-emerald-500/15 transition-all duration-1000 rounded-full" />

                                <CardHeader className="relative z-10 pb-4 border-b border-slate-100/80 dark:border-slate-800/50 space-y-4 bg-gradient-to-r from-slate-50/50 via-white/50 to-indigo-50/20 dark:from-slate-950/20 dark:via-slate-900/80 dark:to-indigo-950/10">
                                    <div className="flex flex-row items-center justify-between">
                                        <div className="flex items-center gap-4">
                                            <CardTitle className="text-sm font-bold flex items-center gap-2.5 uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                                <div className="p-1.5 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
                                                    <ReceiptText className="h-3.5 w-3.5" />
                                                </div>
                                                Expenditure Graph
                                                <Badge variant="outline" className="text-[9px] font-bold tracking-widest border-indigo-200 dark:border-indigo-800 text-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/30 ml-1">{isChartAggregated ? 'yearly (auto)' : granularity}</Badge>
                                            </CardTitle>

                                            <div className="hidden sm:flex items-center gap-2 pl-4 border-l border-slate-200 dark:border-slate-800">
                                                <Label htmlFor="show-budget" className="text-[10px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer flex items-center gap-1.5">
                                                    {showBudgetBar ? <Eye className="h-3 w-3 text-teal-500" /> : <EyeOff className="h-3 w-3" />}
                                                    Budget
                                                </Label>
                                                <Switch
                                                    id="show-budget"
                                                    checked={showBudgetBar}
                                                    onCheckedChange={setShowBudgetBar}
                                                    className="data-[state=checked]:bg-teal-500 scale-75"
                                                />
                                            </div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={resetChartFilters}
                                            className="h-7 text-[10px] font-bold text-rose-500 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 rounded-full px-3 gap-1 transition-all duration-200 hover:scale-105"
                                            aria-label="Reset analytics filters"
                                            title="Reset analytics filters"
                                        >
                                            <RefreshCw className={cn("h-3 w-3", isChartLoading && "animate-spin")} /> Reset Defaults
                                        </Button>
                                    </div>
                                    {/* ── Chart Filters ── */}
                                    <div className="flex flex-wrap items-center gap-2">
                                        {/* Year Filter */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button variant="outline" size="sm" className={cn(
                                                    "h-9 text-[11px] font-bold rounded-xl px-4 gap-2 border-slate-200 dark:border-slate-700 transition-all duration-300 hover:shadow-md",
                                                    chartYears.length > 0
                                                        ? "border-indigo-400 bg-gradient-to-r from-indigo-50 to-violet-50 dark:from-indigo-950/40 dark:to-violet-950/40 text-indigo-600 dark:text-indigo-400 shadow-sm shadow-indigo-200/50 dark:shadow-indigo-900/30"
                                                        : "hover:border-indigo-300 hover:bg-indigo-50/30"
                                                )}>
                                                    <Filter className="h-3.5 w-3.5" />
                                                    {chartYears.length > 0 ? `Year (${chartYears.length})` : "Year"}
                                                    <ChevronDown className="h-3 w-3 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-52 p-3 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700" align="start">
                                                <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Years</p>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setChartYears(availableChartYears)} className="text-[9px] font-bold text-indigo-500 hover:text-indigo-600 transition-colors uppercase tracking-tighter">All</button>
                                                        <span className="text-slate-200 dark:text-slate-800">|</span>
                                                        <button onClick={() => setChartYears([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 transition-colors uppercase tracking-tighter">None</button>
                                                    </div>
                                                </div>
                                                <div className="space-y-1 max-h-48 overflow-y-auto">
                                                    {availableChartYears.map(year => (
                                                        <label key={year} className={cn(
                                                            "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200",
                                                            chartYears.includes(year) ? "bg-indigo-50 dark:bg-indigo-950/30 ring-1 ring-indigo-200 dark:ring-indigo-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                                                        )}>
                                                            <Checkbox
                                                                checked={chartYears.includes(year)}
                                                                onCheckedChange={() => toggleChartYear(year)}
                                                                className="h-4 w-4 rounded"
                                                            />
                                                            <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{year}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        {/* Month Filter */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button variant="outline" size="sm" className={cn(
                                                    "h-9 text-[11px] font-bold rounded-xl px-4 gap-2 border-slate-200 dark:border-slate-700 transition-all duration-300 hover:shadow-md",
                                                    chartMonths.length > 0
                                                        ? "border-emerald-400 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/40 dark:to-teal-950/40 text-emerald-600 dark:text-emerald-400 shadow-sm shadow-emerald-200/50 dark:shadow-emerald-900/30"
                                                        : "hover:border-emerald-300 hover:bg-emerald-50/30"
                                                )}>
                                                    <Filter className="h-3.5 w-3.5" />
                                                    {chartMonths.length > 0 ? `Month (${chartMonths.length})` : "Month"}
                                                    <ChevronDown className="h-3 w-3 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-52 p-3 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700" align="start">
                                                <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Months</p>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setChartMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])} className="text-[9px] font-bold text-emerald-500 hover:text-emerald-600 transition-colors uppercase tracking-tighter">All</button>
                                                        <span className="text-slate-200 dark:text-slate-800">|</span>
                                                        <button onClick={() => setChartMonths([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 transition-colors uppercase tracking-tighter">None</button>
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-3 gap-1 max-h-56 overflow-y-auto">
                                                    {CHART_MONTH_NAMES.map((name, idx) => (
                                                        <button
                                                            key={idx}
                                                            onClick={() => toggleChartMonth(idx + 1)}
                                                            className={cn(
                                                                "px-2 py-2 rounded-lg text-xs font-bold transition-all duration-200 text-center",
                                                                chartMonths.includes(idx + 1)
                                                                    ? "bg-emerald-500 text-white shadow-md shadow-emerald-300/40 scale-105"
                                                                    : "bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-400 hover:bg-emerald-50 hover:text-emerald-600 dark:hover:bg-emerald-950/30"
                                                            )}
                                                        >
                                                            {name}
                                                        </button>
                                                    ))}
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        {/* Branch Filter */}
                                        <Popover>
                                            <PopoverTrigger asChild>
                                                <Button variant="outline" size="sm" className={cn(
                                                    "h-9 text-[11px] font-bold rounded-xl px-4 gap-2 border-slate-200 dark:border-slate-700 transition-all duration-300 hover:shadow-md",
                                                    chartBranchIds.length > 0
                                                        ? "border-amber-400 bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/40 dark:to-orange-950/40 text-amber-600 dark:text-amber-400 shadow-sm shadow-amber-200/50 dark:shadow-amber-900/30"
                                                        : "hover:border-amber-300 hover:bg-amber-50/30"
                                                )}>
                                                    <Building2 className="h-3.5 w-3.5" />
                                                    {chartBranchIds.length > 0 ? `Branch (${chartBranchIds.length})` : "Branch"}
                                                    <ChevronDown className="h-3 w-3 opacity-50" />
                                                </Button>
                                            </PopoverTrigger>
                                            <PopoverContent className="w-60 p-3 rounded-xl shadow-xl border border-slate-200 dark:border-slate-700" align="start">
                                                <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                    <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Branches</p>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setChartBranchIds(uniqueBranches.map(b => b.id))} className="text-[9px] font-bold text-amber-500 hover:text-amber-600 transition-colors uppercase tracking-tighter">All</button>
                                                        <span className="text-slate-200 dark:text-slate-800">|</span>
                                                        <button onClick={() => setChartBranchIds([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 transition-colors uppercase tracking-tighter">None</button>
                                                    </div>
                                                </div>
                                                <div className="space-y-1 max-h-56 overflow-y-auto">
                                                    {uniqueBranches.map(branch => (
                                                        <label key={branch.id} className={cn(
                                                            "flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-all duration-200",
                                                            chartBranchIds.includes(String(branch.id)) ? "bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-200 dark:ring-amber-800" : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                                                        )}>
                                                            <Checkbox
                                                                checked={chartBranchIds.includes(String(branch.id))}
                                                                onCheckedChange={() => toggleChartBranch(String(branch.id))}
                                                                className="h-4 w-4 rounded"
                                                            />
                                                            <span className="text-sm font-bold text-slate-700 dark:text-slate-300 truncate">{branch.name}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </PopoverContent>
                                        </Popover>

                                        {/* Divider */}
                                        {(chartYears.length > 0 || chartMonths.length > 0 || chartBranchIds.length > 0) && (
                                            <div className="h-6 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
                                        )}

                                        {/* Active filter badges */}
                                        {chartYears.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {chartYears.map(y => (
                                                    <Badge key={y} className="text-[10px] font-bold bg-gradient-to-r from-indigo-500 to-violet-500 text-white border-0 gap-1 cursor-pointer hover:from-indigo-600 hover:to-violet-600 transition-all duration-200 hover:scale-105 shadow-sm shadow-indigo-300/30 px-2.5 py-0.5 rounded-full" onClick={() => toggleChartYear(y)}>
                                                        {y} <X className="h-2.5 w-2.5" />
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}
                                        {chartMonths.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {chartMonths.map(m => (
                                                    <Badge key={m} className="text-[10px] font-bold bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0 gap-1 cursor-pointer hover:from-emerald-600 hover:to-teal-600 transition-all duration-200 hover:scale-105 shadow-sm shadow-emerald-300/30 px-2.5 py-0.5 rounded-full" onClick={() => toggleChartMonth(m)}>
                                                        {CHART_MONTH_NAMES[m - 1]} <X className="h-2.5 w-2.5" />
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}
                                        {chartBranchIds.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {chartBranchIds.map(bid => {
                                                    const br = uniqueBranches.find(b => String(b.id) === bid)
                                                    return (
                                                        <Badge key={bid} className="text-[10px] font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-white border-0 gap-1 cursor-pointer hover:from-amber-600 hover:to-orange-600 transition-all duration-200 hover:scale-105 shadow-sm shadow-amber-300/30 px-2.5 py-0.5 rounded-full" onClick={() => toggleChartBranch(bid)}>
                                                            {br?.name || bid} <X className="h-2.5 w-2.5" />
                                                        </Badge>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </CardHeader>
                                <CardContent className="p-5 pt-6">
                                    {/* Chart Summary Stats */}
                                    {chartDisplayData.length > 0 && (
                                        <div className="grid grid-cols-3 gap-3 mb-5">
                                            {(() => {
                                                const totalBaseline = filteredChartData.reduce((s: number, d: any) => s + (d.totalBaseline || 0), 0);
                                                const totalAddon = filteredChartData.reduce((s: number, d: any) => s + (d.totalAddon || 0), 0);
                                                const totalBudget = totalBaseline + totalAddon;
                                                const totalSpent = filteredChartData.reduce((s: number, d: any) => s + (d.totalSpent || 0), 0);
                                                const utilization = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;
                                                return (
                                                    <AnimatePresence mode="wait">
                                                        <motion.div
                                                            key="summary-stats"
                                                            initial={{ opacity: 0, scale: 0.95 }}
                                                            animate={{ opacity: 1, scale: 1 }}
                                                            exit={{ opacity: 0, scale: 0.95 }}
                                                            className="col-span-3 grid grid-cols-1 sm:grid-cols-2 2xl:grid-cols-4 gap-3"
                                                        >
                                                            <div className="relative overflow-hidden min-w-0 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 rounded-xl p-3 border border-emerald-100 dark:border-emerald-900/50">
                                                                <p className="relative z-10 whitespace-nowrap text-[8px] sm:text-[9px] font-black uppercase tracking-[0.14em] sm:tracking-widest text-emerald-500 mb-1">Base Budget</p>
                                                                <p className="relative z-10 whitespace-nowrap text-[clamp(0.72rem,1.05vw,1rem)] leading-tight font-black tracking-tight text-emerald-700 dark:text-emerald-300">{formatPKR(totalBaseline)}</p>
                                                                <div className="absolute -top-2 -right-2 w-12 h-12 bg-emerald-200/20 rounded-full blur-xl" />
                                                            </div>
                                                            <div className="relative overflow-hidden min-w-0 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20 rounded-xl p-3 border border-amber-100 dark:border-amber-900/50">
                                                                <p className="relative z-10 whitespace-nowrap text-[8px] sm:text-[9px] font-black uppercase tracking-[0.14em] sm:tracking-widest text-amber-500 mb-1">Addon Credits</p>
                                                                <p className="relative z-10 whitespace-nowrap text-[clamp(0.72rem,1.05vw,1rem)] leading-tight font-black tracking-tight text-amber-700 dark:text-amber-300">{formatPKR(totalAddon)}</p>
                                                                <div className="absolute -top-2 -right-2 w-12 h-12 bg-amber-200/20 rounded-full blur-xl" />
                                                            </div>
                                                            <div className="relative overflow-hidden min-w-0 bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-950/30 dark:to-violet-950/20 rounded-xl p-3 border border-indigo-100 dark:border-indigo-900/50">
                                                                <p className="relative z-10 whitespace-nowrap text-[8px] sm:text-[9px] font-black uppercase tracking-[0.14em] sm:tracking-widest text-indigo-500 mb-1">Total Spent</p>
                                                                <p className="relative z-10 whitespace-nowrap text-[clamp(0.72rem,1.05vw,1rem)] leading-tight font-black tracking-tight text-indigo-700 dark:text-indigo-300">{formatPKR(totalSpent)}</p>
                                                                <div className="absolute -top-2 -right-2 w-12 h-12 bg-indigo-200/20 rounded-full blur-xl" />
                                                            </div>
                                                            <div className="relative overflow-hidden min-w-0 bg-gradient-to-br from-slate-50 to-gray-50 dark:from-slate-950/30 dark:to-gray-950/20 rounded-xl p-3 border border-slate-200 dark:border-slate-800">
                                                                <p className="relative z-10 whitespace-nowrap text-[8px] sm:text-[9px] font-black uppercase tracking-[0.14em] sm:tracking-widest text-slate-400 mb-1">Utilization</p>
                                                                <div className="relative z-10 flex items-center gap-2 min-w-0">
                                                                    <p className={cn("whitespace-nowrap text-[clamp(0.72rem,1.05vw,1rem)] leading-tight font-black tracking-tight", utilization > 90 ? "text-rose-500" : utilization > 70 ? "text-amber-500" : "text-emerald-500")}>{utilization.toFixed(1)}%</p>
                                                                    <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden max-w-[60px] min-w-8">
                                                                        <motion.div
                                                                            initial={{ width: 0 }}
                                                                            animate={{ width: `${Math.min(utilization, 100)}%` }}
                                                                            transition={{ duration: 1, ease: "easeOut" }}
                                                                            className={cn("h-full", utilization > 90 ? "bg-rose-500" : utilization > 70 ? "bg-amber-500" : "bg-emerald-500")}
                                                                        />
                                                                    </div>
                                                                </div>
                                                                <div className="absolute -top-2 -right-2 w-12 h-12 bg-slate-200/20 rounded-full blur-xl" />
                                                            </div>
                                                        </motion.div>
                                                    </AnimatePresence>
                                                );
                                            })()}
                                        </div>
                                    )}
                                    <div className="h-[380px] w-full">
                                        {isChartLoading ? (
                                            <div className="h-full flex flex-col items-center justify-center space-y-4">
                                                <div className="relative">
                                                    <Loader2 className="h-10 w-10 text-indigo-500/40 animate-spin" />
                                                    <div className="absolute inset-0 h-10 w-10 bg-indigo-500/10 blur-xl animate-pulse rounded-full" />
                                                </div>
                                                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 animate-pulse">Synchronizing History...</p>
                                            </div>
                                        ) : chartDisplayData.length > 0 ? (
                                            <ResponsiveContainer width="100%" height="100%">
                                                <ComposedChart data={chartDisplayData} margin={{ top: 5, right: 15, left: 5, bottom: 20 }} barGap={6} barCategoryGap="25%">
                                                    <defs>
                                                        <linearGradient id="barGradientBudget" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.9} />
                                                            <stop offset="100%" stopColor="#0d9488" stopOpacity={0.7} />
                                                        </linearGradient>
                                                        <linearGradient id="barGradientSpent" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="0%" stopColor="#818cf8" stopOpacity={0.95} />
                                                            <stop offset="100%" stopColor="#6366f1" stopOpacity={0.8} />
                                                        </linearGradient>
                                                        <filter id="barShadow" x="-5%" y="-5%" width="110%" height="120%">
                                                            <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#6366f1" floodOpacity="0.15" />
                                                        </filter>
                                                    </defs>
                                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E2E8F0" opacity={0.4} />
                                                    <XAxis
                                                        dataKey="date"
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tick={{ fontSize: 11, fill: '#64748b', fontWeight: 600 }}
                                                        dy={10}
                                                        interval={0}
                                                        angle={(chartDisplayData.length > 6 && chartYears.length > 1) ? -35 : 0}
                                                        textAnchor={(chartDisplayData.length > 6 && chartYears.length > 1) ? "end" : "middle"}
                                                        height={chartDisplayData.length > 6 ? 60 : 30}
                                                    />
                                                    <YAxis
                                                        axisLine={false}
                                                        tickLine={false}
                                                        tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}
                                                        tickFormatter={formatChartAxisPKR}
                                                        width={65}
                                                    />
                                                    <RechartsTooltip
                                                        cursor={{ fill: 'rgba(99, 102, 241, 0.04)', radius: 8 }}
                                                        content={({ active, payload, label }) => {
                                                            if (active && payload && payload.length) {
                                                                const data = payload[0].payload;
                                                                const utilPct = data.totalLimit > 0 ? ((data.totalSpent / data.totalLimit) * 100).toFixed(1) : '0.0';
                                                                return (
                                                                    <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border border-slate-200/80 dark:border-slate-700 p-4 rounded-2xl shadow-2xl min-w-[280px] ring-1 ring-black/5">
                                                                        <p className="text-xs font-black uppercase tracking-widest text-slate-500 mb-3 pb-2 border-b border-slate-100 dark:border-slate-800">
                                                                            {data.rawDate ? format(new Date(data.rawDate + "-01"), "MMMM yyyy") : label}
                                                                        </p>

                                                                        <div className="space-y-3">
                                                                            <div className="flex justify-between items-center bg-teal-50/50 dark:bg-teal-900/20 p-2.5 rounded-xl border border-teal-100/50 dark:border-teal-900/50">
                                                                                <div className="flex items-center gap-2">
                                                                                    <div className="w-3 h-3 rounded-sm bg-gradient-to-b from-teal-400 to-teal-600 shadow-sm shadow-teal-500/20" />
                                                                                    <span className="text-[11px] font-bold text-teal-700 dark:text-teal-400 uppercase tracking-tight">Total Budget</span>
                                                                                </div>
                                                                                <span className="text-[13px] font-black text-teal-600">{formatPKR(data.totalLimit)}</span>
                                                                            </div>

                                                                            <div className="flex justify-between items-center bg-indigo-50/50 dark:bg-indigo-900/20 p-2.5 rounded-xl border border-indigo-100/50 dark:border-indigo-900/50">
                                                                                <div className="flex items-center gap-2">
                                                                                    <div className="w-3 h-3 rounded-sm bg-gradient-to-b from-indigo-400 to-indigo-600 shadow-sm shadow-indigo-500/20" />
                                                                                    <span className="text-[11px] font-bold text-indigo-700 dark:text-indigo-400 uppercase tracking-tight">Total Spent</span>
                                                                                </div>
                                                                                <span className="text-[13px] font-black text-indigo-600">{formatPKR(data.totalSpent)}</span>
                                                                            </div>

                                                                            <div className="flex justify-between items-center pt-1 px-2">
                                                                                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Utilization Rate</span>
                                                                                <span className={cn("text-[13px] font-black", Number(utilPct) > 90 ? "text-rose-500" : Number(utilPct) > 70 ? "text-amber-500" : "text-emerald-500")}>{utilPct}%</span>
                                                                            </div>
                                                                        </div>

                                                                        {chartVisibleBranches.length > 0 && (
                                                                            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                                                                                <div className="flex justify-between items-center mb-2 px-1">
                                                                                    <p className="text-[9px] font-black uppercase text-slate-400 tracking-wider">Branch Details</p>
                                                                                    <div className="flex gap-4">
                                                                                        <span className="text-[8px] font-bold text-emerald-500 tracking-tighter uppercase opacity-70">Base</span>
                                                                                        <span className="text-[8px] font-bold text-amber-500 tracking-tighter uppercase opacity-70">Addon</span>
                                                                                        <span className="text-[8px] font-bold text-indigo-500 tracking-tighter uppercase opacity-70">Total</span>
                                                                                        <span className="text-[8px] font-bold text-violet-500 tracking-tighter uppercase opacity-70">Spent</span>
                                                                                    </div>
                                                                                </div>
                                                                                <div className="space-y-1.5">
                                                                                    {chartVisibleBranches.slice(0, 5).map((b) => (
                                                                                        <div key={b.id} className="flex justify-between items-center py-1.5 px-2 bg-slate-50/50 dark:bg-slate-800/30 rounded-lg group transition-colors hover:bg-slate-100/50 dark:hover:bg-slate-800/50">
                                                                                            <span className="text-[10px] text-slate-600 dark:text-slate-300 font-bold truncate max-w-[80px]">{b.name}</span>
                                                                                            <div className="flex gap-3">
                                                                                                <span className="text-[10px] font-black text-emerald-600/80">{formatPKR(data[`${b.id}_baseline`] || 0)}</span>
                                                                                                <span className="text-[10px] font-black text-amber-600/80">{formatPKR(data[`${b.id}_addon`] || 0)}</span>
                                                                                                <span className="text-[10px] font-black text-indigo-600">{(formatPKR((data[`${b.id}_baseline`] || 0) + (data[`${b.id}_addon`] || 0)))}</span>
                                                                                                <span className="text-[10px] font-black text-violet-600">{formatPKR(data[`${b.id}_spent`] || 0)}</span>
                                                                                            </div>
                                                                                        </div>
                                                                                    ))}
                                                                                </div>
                                                                                {chartVisibleBranches.length > 5 && (
                                                                                    <p className="text-[8px] text-center text-slate-400 mt-2 font-bold italic tracking-wide">
                                                                                        +{chartVisibleBranches.length - 5} more branches filtered
                                                                                    </p>
                                                                                )}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            }
                                                            return null;
                                                        }}
                                                    />
                                                    <defs>
                                                        <linearGradient id="barGradientBudget" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="0%" stopColor="#6366f1" />
                                                            <stop offset="50%" stopColor="#8b5cf6" />
                                                            <stop offset="100%" stopColor="#a855f7" />
                                                        </linearGradient>
                                                        <linearGradient id="barGradientSpent" x1="0" y1="0" x2="0" y2="1">
                                                            <stop offset="0%" stopColor="#2dd4bf" />
                                                            <stop offset="50%" stopColor="#14b8a6" />
                                                            <stop offset="100%" stopColor="#0f766e" />
                                                        </linearGradient>
                                                        <filter id="barShadow" x="-20%" y="-20%" width="140%" height="140%">
                                                            <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
                                                            <feOffset dx="0" dy="2" result="offsetblur" />
                                                            <feComponentTransfer>
                                                                <feFuncA type="linear" slope="0.3" />
                                                            </feComponentTransfer>
                                                            <feMerge>
                                                                <feMergeNode />
                                                                <feMergeNode in="SourceGraphic" />
                                                            </feMerge>
                                                        </filter>
                                                    </defs>
                                                    <Legend
                                                        verticalAlign="top"
                                                        align="right"
                                                        height={36}
                                                        iconType="circle"
                                                        iconSize={8}
                                                        wrapperStyle={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', paddingBottom: '16px' }}
                                                    />

                                                    {/* Budget Allocated Bar */}
                                                    {showBudgetBar && (
                                                        <Bar
                                                            dataKey="totalLimit"
                                                            name="Budget Allocated"
                                                            fill="url(#barGradientBudget)"
                                                            radius={[6, 6, 0, 0]}
                                                            isAnimationActive={true}
                                                            animationDuration={800}
                                                            animationEasing="ease-out"
                                                            animationBegin={0}
                                                        />
                                                    )}

                                                    {/* Total Expenditure Bar */}
                                                    <Bar
                                                        dataKey="totalSpent"
                                                        name="Total Expenditure"
                                                        fill="url(#barGradientSpent)"
                                                        radius={[6, 6, 0, 0]}
                                                        filter="url(#barShadow)"
                                                        isAnimationActive={true}
                                                        animationDuration={800}
                                                        animationEasing="ease-out"
                                                        animationBegin={showBudgetBar ? 200 : 0}
                                                    />
                                                </ComposedChart>
                                            </ResponsiveContainer>
                                        ) : (
                                            <div className="h-full flex flex-col items-center justify-center text-slate-400 space-y-4">
                                                <div className="p-4 rounded-2xl bg-slate-100 dark:bg-slate-800/50">
                                                    <ReceiptText className="h-8 w-8 opacity-30" />
                                                </div>
                                                <div className="text-center space-y-1">
                                                    <p className="text-sm font-bold text-slate-500">No data available</p>
                                                    <p className="text-xs text-slate-400">Try adjusting your filter selections</p>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="xl:col-span-1 border border-slate-200 dark:border-slate-800 shadow-sm bg-white/80 dark:bg-slate-900/50 backdrop-blur-xl flex flex-col">
                                <CardHeader className="pb-3 border-b border-slate-100 dark:border-slate-800/50">
                                    <div className="flex items-center justify-between">
                                        <CardTitle className="text-sm font-semibold flex items-center gap-2 uppercase tracking-tight text-slate-800 dark:text-slate-200">
                                            <Building2 className="h-4 w-4 text-indigo-500" />
                                            Branch Deployment
                                        </CardTitle>
                                        <Badge variant="secondary" className="text-[9px] font-bold tracking-widest bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border-none">BY REMAINING</Badge>
                                    </div>
                                </CardHeader>
                                <CardContent className="p-0 flex-1 overflow-y-auto h-[350px]">
                                    {branchBreakdown.length > 0 ? (
                                        <div className="divide-y divide-slate-100 dark:divide-slate-800/60 font-mono">
                                            {[...branchBreakdown].sort((a, b) => b.remaining - a.remaining).map((b: any) => (
                                                <div key={b.branchId} className="p-4 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors flex items-center justify-between group">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-950/20 flex items-center justify-center text-indigo-500 font-black text-xs">
                                                            {b.branchName?.substring(0, 2).toUpperCase()}
                                                        </div>
                                                        <div>
                                                            <p className="text-xs font-black text-slate-900 dark:text-white uppercase tracking-tighter">{b.branchName}</p>
                                                            <div className="flex items-center gap-1 mt-0.5">
                                                                <span className="text-[9px] font-bold text-slate-400">SPENT: {formatPKR(b.spent / 100)}</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className={cn("text-xs font-black", b.remaining < 0 ? "text-rose-500" : "text-emerald-500")}>
                                                            {b.remaining < 0 ? "-" : "+"}{formatPKR(Math.abs(b.remaining) / 100)}
                                                        </p>
                                                        <p className="text-[8px] font-black text-slate-400 tracking-widest uppercase">Remaining</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="h-full flex items-center justify-center p-8 text-center bg-slate-50/50 dark:bg-slate-900/20">
                                            <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">No branch metrics</p>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    <TabsContent value="reports" className="space-y-4 animate-in fade-in slide-in-from-bottom-2">
                        {!organizationId ? (
                            <Card className="border-dashed border-2 p-20 flex flex-col items-center justify-center text-center space-y-4 bg-white/50 dark:bg-slate-900/20 rounded-[2.5rem]">
                                <div className="p-4 rounded-full bg-slate-100 dark:bg-slate-800">
                                    <Building2 className="h-8 w-8 text-slate-400" />
                                </div>
                                <div className="space-y-2">
                                    <h3 className="text-lg font-bold text-slate-900 dark:text-white uppercase tracking-tight font-mono">Organization Selection Required</h3>
                                    <p className="text-sm text-slate-500 max-w-sm">Please select an organization from the top filter to generate the detailed budget deployment report.</p>
                                </div>
                            </Card>
                        ) : (
                            hasMounted && (
                                <motion.div
                                    initial={{ opacity: 0, scale: 0.98, y: 10 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                                >
                                    <Card className="border-none shadow-[0_32px_64px_-16px_rgba(0,0,0,0.1)] bg-white/80 dark:bg-slate-900/80 backdrop-blur-2xl overflow-hidden rounded-[2.5rem] border border-white/40 dark:border-slate-800/20">
                                        <div className="p-4 pb-3 border-b border-indigo-50/50 dark:border-slate-800/50 bg-gradient-to-br from-white/40 via-transparent to-indigo-50/10 dark:from-slate-900/40 dark:to-transparent">
                                            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 via-violet-600 to-fuchsia-600 shadow-lg shadow-indigo-500/20 flex items-center justify-center">
                                                            <FileText className="h-4 w-4 text-white" />
                                                        </div>
                                                        <h3 className="text-base font-[900] text-slate-900 dark:text-white uppercase tracking-tighter italic">
                                                            Deployment Audit
                                                        </h3>
                                                        <Badge className="bg-indigo-600 hover:bg-indigo-600 text-white border-none rounded-full px-3 py-0.5 text-[9px] font-black tracking-widest uppercase">Live Report</Badge>
                                                    </div>
                                                    <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest pl-1 opacity-70">
                                                        {getPresetLabel(activePreset, dateRange)}
                                                    </p>
                                                </div>

                                                <div className="flex flex-wrap items-center gap-2">
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

                                                    {/* Report Year Filter */}
                                                    <Popover>
                                                        <PopoverTrigger asChild>
                                                            <Button variant="outline" size="sm" className={cn(
                                                                "h-8 text-[10px] font-black rounded-lg px-3 gap-1.5 border-slate-200 dark:border-slate-800 transition-all uppercase tracking-widest",
                                                                reportYears.length > 0 ? "border-indigo-500/50 bg-indigo-50/50 text-indigo-600 shadow-sm" : "hover:bg-slate-50"
                                                            )}>
                                                                <Calendar className="h-3 w-3" />
                                                                {reportYears.length > 0 ? `Year (${reportYears.length})` : "Year"}
                                                                <ChevronDown className="h-3 w-3 opacity-50" />
                                                            </Button>
                                                        </PopoverTrigger>
                                                        <PopoverContent className="w-52 p-3 rounded-2xl shadow-2xl border-slate-200 dark:border-slate-800" align="end">
                                                            <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Years</p>
                                                                <div className="flex gap-2">
                                                                    <button onClick={() => setReportYears(availableChartYears)} className="text-[9px] font-bold text-indigo-500 hover:text-indigo-600 uppercase">All</button>
                                                                    <span className="text-slate-200">|</span>
                                                                    <button onClick={() => setReportYears([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 uppercase">None</button>
                                                                </div>
                                                            </div>
                                                            <div className="space-y-1 max-h-48 overflow-y-auto">
                                                                {availableChartYears.map(year => (
                                                                    <label key={year} className={cn(
                                                                        "flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors",
                                                                        reportYears.includes(year) ? "bg-indigo-50 dark:bg-indigo-950/30" : "hover:bg-slate-50"
                                                                    )}>
                                                                        <Checkbox checked={reportYears.includes(year)} onCheckedChange={() => toggleReportYear(year)} />
                                                                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300">{year}</span>
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>

                                                    {/* Report Month Filter */}
                                                    <Popover>
                                                        <PopoverTrigger asChild>
                                                            <Button variant="outline" size="sm" className={cn(
                                                                "h-8 text-[10px] font-black rounded-lg px-3 gap-1.5 border-slate-200 dark:border-slate-800 transition-all uppercase tracking-widest",
                                                                reportMonths.length > 0 ? "border-emerald-500/50 bg-emerald-50/50 text-emerald-600 shadow-sm" : "hover:bg-slate-50"
                                                            )}>
                                                                <Filter className="h-3 w-3" />
                                                                {reportMonths.length > 0 ? `Month (${reportMonths.length})` : "Month"}
                                                                <ChevronDown className="h-3 w-3 opacity-50" />
                                                            </Button>
                                                        </PopoverTrigger>
                                                        <PopoverContent className="w-52 p-3 rounded-2xl shadow-2xl border-slate-200 dark:border-slate-800" align="end">
                                                            <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Months</p>
                                                                <div className="flex gap-2">
                                                                    <button onClick={() => setReportMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])} className="text-[9px] font-bold text-emerald-500 hover:text-emerald-600 uppercase">All</button>
                                                                    <span className="text-slate-200">|</span>
                                                                    <button onClick={() => setReportMonths([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 uppercase">None</button>
                                                                </div>
                                                            </div>
                                                            <div className="grid grid-cols-3 gap-1">
                                                                {CHART_MONTH_NAMES.map((name, idx) => (
                                                                    <button
                                                                        key={idx}
                                                                        onClick={() => toggleReportMonth(idx + 1)}
                                                                        className={cn(
                                                                            "px-2 py-2 rounded-lg text-[10px] font-black transition-all text-center uppercase tracking-tighter",
                                                                            reportMonths.includes(idx + 1) ? "bg-emerald-500 text-white shadow-md shadow-emerald-200" : "bg-slate-50 text-slate-600 hover:bg-emerald-50 hover:text-emerald-600"
                                                                        )}
                                                                    >
                                                                        {name}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>

                                                    {role !== "BRANCH_ADMIN" && organizationId && (
                                                        <GroupFilter
                                                            selectedIds={reportGroupIds}
                                                            onChange={(ids) => {
                                                                setReportGroupIds(ids)
                                                                setReportBranchIds([])
                                                            }}
                                                            organizationId={organizationId}
                                                            disabled={reportBranchIds.length > 0}
                                                            placeholder="Groups"
                                                        />
                                                    )}

                                                    {/* Report Branch Filter */}
                                                    <Popover>
                                                        <PopoverTrigger asChild>
                                                            <Button variant="outline" size="sm" className={cn(
                                                                "h-8 text-[10px] font-black rounded-lg px-3 gap-1.5 border-slate-200 dark:border-slate-800 transition-all uppercase tracking-widest",
                                                                reportBranchIds.length > 0 ? "border-amber-500/50 bg-amber-50/50 text-amber-600 shadow-sm" : "hover:bg-slate-50"
                                                            )}>
                                                                <Building2 className="h-3 w-3" />
                                                                {reportBranchIds.length > 0 ? `Branch (${reportBranchIds.length})` : "Branch"}
                                                                <ChevronDown className="h-3 w-3 opacity-50" />
                                                            </Button>
                                                        </PopoverTrigger>
                                                        <PopoverContent className="w-60 p-3 rounded-2xl shadow-2xl border-slate-200 dark:border-slate-800" align="end">
                                                            <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                                                                <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Select Branches</p>
                                                                <div className="flex gap-2">
                                                                    <button onClick={() => setReportBranchIds(uniqueBranches.map(b => b.id))} className="text-[9px] font-bold text-amber-500 hover:text-amber-600 uppercase">All</button>
                                                                    <span className="text-slate-200">|</span>
                                                                    <button onClick={() => setReportBranchIds([])} className="text-[9px] font-bold text-rose-500 hover:text-rose-600 uppercase">None</button>
                                                                </div>
                                                            </div>
                                                            <div className="space-y-1 max-h-56 overflow-y-auto">
                                                                {uniqueBranches.map(branch => (
                                                                    <label key={branch.id} className={cn(
                                                                        "flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors",
                                                                        reportBranchIds.includes(String(branch.id)) ? "bg-amber-50 dark:bg-amber-950/30" : "hover:bg-slate-50"
                                                                    )}>
                                                                        <Checkbox checked={reportBranchIds.includes(String(branch.id))} onCheckedChange={() => toggleReportBranch(String(branch.id))} />
                                                                        <span className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{branch.name}</span>
                                                                    </label>
                                                                ))}
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>

                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={resetReportFilters}
                                                        className="h-8 text-[10px] font-black rounded-lg px-3 gap-1.5 border-slate-200 dark:border-slate-800 uppercase tracking-widest hover:bg-slate-50"
                                                        aria-label="Reset report filters"
                                                        title="Reset report filters"
                                                    >
                                                        <RotateCcw className={cn("h-3 w-3", isReportLoading && "animate-spin")} />
                                                        Reset
                                                    </Button>

                                                    <div className="h-6 w-px bg-slate-100 dark:bg-slate-800 mx-1" />

                                                    <div className="relative group">
                                                        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-indigo-400 group-focus-within:text-indigo-600 transition-all" />
                                                        <Input
                                                            placeholder="SEARCH BRANCHES..."
                                                            className="pl-9 h-8 w-48 text-[10px] font-black bg-white/50 dark:bg-slate-950/50 border-slate-200/60 dark:border-slate-800/60 focus:ring-2 focus:ring-indigo-500/10 focus:border-indigo-500/40 rounded-lg transition-all uppercase tracking-tighter placeholder:text-slate-400 placeholder:font-bold"
                                                            value={searchTerm}
                                                            onChange={(e) => setSearchTerm(e.target.value)}
                                                        />
                                                    </div>
                                                    <DropdownMenu>
                                                        <DropdownMenuTrigger asChild>
                                                            <Button
                                                                variant="outline"
                                                                className="h-8 border-indigo-100/50 dark:border-slate-800 font-black text-[10px] uppercase tracking-[0.2em] gap-2 bg-indigo-50/30 dark:bg-slate-950/30 hover:bg-white dark:hover:bg-slate-900 shadow-sm transition-all rounded-lg px-3 border-2 group"
                                                            >
                                                                <Upload className="h-3.5 w-3.5 text-indigo-600 transition-transform group-hover:-translate-y-0.5" />
                                                                Export
                                                                <ChevronDown className="h-3 w-3 opacity-50 ml-0.5" />
                                                            </Button>
                                                        </DropdownMenuTrigger>
                                                        <DropdownMenuContent align="end" className="w-48 rounded-xl p-2 shadow-xl border-slate-200 dark:border-slate-800">
                                                            <DropdownMenuItem onClick={() => handleExport('pdf')} className="cursor-pointer gap-3 p-3 rounded-lg font-black text-[11px] uppercase tracking-widest text-slate-700 dark:text-slate-300 focus:bg-rose-50 focus:text-rose-600 dark:focus:bg-rose-500/10 dark:focus:text-rose-400">
                                                                <FileText className="h-4 w-4" /> Export as PDF
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem onClick={() => handleExport('excel')} className="cursor-pointer gap-3 p-3 rounded-lg font-black text-[11px] uppercase tracking-widest text-slate-700 dark:text-slate-300 focus:bg-emerald-50 focus:text-emerald-600 dark:focus:bg-emerald-500/10 dark:focus:text-emerald-400">
                                                                <Database className="h-4 w-4" /> Export as Excel
                                                            </DropdownMenuItem>
                                                            <DropdownMenuItem onClick={() => handleExport('csv')} className="cursor-pointer gap-3 p-3 rounded-lg font-black text-[11px] uppercase tracking-widest text-slate-700 dark:text-slate-300 focus:bg-indigo-50 focus:text-indigo-600 dark:focus:bg-indigo-500/10 dark:focus:text-indigo-400">
                                                                <Upload className="h-4 w-4" /> Export as CSV
                                                            </DropdownMenuItem>
                                                        </DropdownMenuContent>
                                                    </DropdownMenu>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="p-2 sm:p-6">
                                            <div className="overflow-x-auto rounded-[2rem] border border-slate-100/60 dark:border-slate-800/60 shadow-[inset_0_2px_12px_rgba(0,0,0,0.02)]">
                                                <Table className="border-collapse">
                                                    <TableHeader className="bg-slate-50/30 dark:bg-slate-950/30">
                                                        <TableRow className="hover:bg-transparent border-b border-slate-100 dark:border-slate-800">
                                                            <TableHead className="pl-6 h-12 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400">Branch Identity</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-emerald-600/70 text-right">Standard BASE</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600/70 text-right">Add-On (Adj)</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-slate-900 dark:text-white text-right">TOTAL BUDGET</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-rose-500/70 text-right">NET SPENT</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-slate-900 dark:text-white text-right">LIQUID REMAINING</TableHead>
                                                            <TableHead className="h-12 text-[10px] font-black uppercase tracking-[0.25em] text-slate-400 text-center pr-6">Utilization</TableHead>
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody className="bg-transparent">
                                                        <AnimatePresence mode="popLayout">
                                                            {filteredReportBranches.map((b: any, index: number) => {
                                                                const baseline = b.baselineAmount || 0;
                                                                const addon = b.credited || 0;
                                                                const totalLimit = baseline + addon;
                                                                const spent = b.spent || 0;
                                                                const remaining = totalLimit - spent;
                                                                const utilization = totalLimit > 0 ? (spent / totalLimit) * 100 : 0;
                                                                return (
                                                                    <motion.tr
                                                                        key={b.branchId}
                                                                        initial={{ opacity: 0, scale: 0.99, y: 5 }}
                                                                        animate={{ opacity: 1, scale: 1, y: 0 }}
                                                                        transition={{ duration: 0.3, delay: index * 0.02 }}
                                                                        className="hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20 border-b border-slate-50 dark:border-slate-800/40 transition-all duration-300 group"
                                                                    >
                                                                        <TableCell className="pl-6 py-4">
                                                                            <div className="flex items-center gap-4">
                                                                                <div className="w-10 h-10 rounded-2xl bg-white dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 group-hover:border-indigo-500/30 group-hover:shadow-lg group-hover:shadow-indigo-500/10 flex items-center justify-center transition-all duration-500">
                                                                                    <Building2 className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors" />
                                                                                </div>
                                                                                <div>
                                                                                    <span className="font-black text-xs text-slate-900 dark:text-slate-100 uppercase tracking-tight block">{b.branchName}</span>
                                                                                    <span className="text-[10px] font-bold text-slate-400 tracking-tighter uppercase opacity-60">AUDIT ID: #{b.branchId}</span>
                                                                                </div>
                                                                            </div>
                                                                        </TableCell>
                                                                        <TableCell className="text-right py-4">
                                                                            <span className="font-bold text-xs text-slate-600 dark:text-slate-400 font-mono">{formatPKR(baseline / 100)}</span>
                                                                        </TableCell>
                                                                        <TableCell className="text-right py-4">
                                                                            <div className="flex flex-col items-end gap-1">
                                                                                <Badge variant="outline" className={cn("px-2.5 py-1 text-[10px] font-black tracking-widest border-none transition-all", addon > 0 ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" : "text-slate-300 dark:text-slate-700 opacity-40")}>
                                                                                    {addon > 0 ? `+${formatPKR(addon / 100)}` : "—"}
                                                                                </Badge>
                                                                            </div>
                                                                        </TableCell>
                                                                        <TableCell className="text-right py-4">
                                                                            <span className="font-black text-xs text-slate-900 dark:text-white font-mono">{formatPKR(totalLimit / 100)}</span>
                                                                        </TableCell>
                                                                        <TableCell className="text-right py-4">
                                                                            <span className="font-black text-xs text-rose-500 font-mono">{formatPKR(spent / 100)}</span>
                                                                        </TableCell>
                                                                        <TableCell className="text-right py-4">
                                                                            <span className={cn("text-[11px] font-black uppercase tracking-widest font-mono px-3 py-1.5 rounded-xl border-2 transition-all", remaining < 0 ? "bg-rose-50 border-rose-100 text-rose-600 shadow-sm shadow-rose-100" : "bg-emerald-50 border-emerald-100 text-emerald-600 shadow-sm shadow-emerald-100 dark:bg-emerald-500/10 dark:border-emerald-500/20")}>
                                                                                {remaining < 0 ? "-" : "+"}{formatPKR(Math.abs(remaining) / 100)}
                                                                            </span>
                                                                        </TableCell>
                                                                        <TableCell className="text-center pr-6 py-4">
                                                                            <div className="flex flex-col items-center gap-2 min-w-[120px]">
                                                                                <div className="w-full h-2.5 bg-slate-100/50 dark:bg-slate-950/50 rounded-full overflow-hidden p-[2px] border border-slate-200 dark:border-slate-800">
                                                                                    <motion.div
                                                                                        initial={{ width: 0 }}
                                                                                        animate={{ width: `${Math.min(utilization, 100)}%` }}
                                                                                        transition={{ duration: 1.5, ease: [0.34, 1.56, 0.64, 1] }}
                                                                                        className={cn("h-full rounded-full shadow-[0_0_8px_rgba(0,0,0,0.1)]", utilization > 90 ? "bg-gradient-to-r from-red-500 via-rose-600 to-red-500" : utilization > 70 ? "bg-gradient-to-r from-amber-400 via-orange-500 to-amber-600" : "bg-gradient-to-r from-teal-400 via-emerald-500 to-teal-400")}
                                                                                    />
                                                                                </div>
                                                                                <span className={cn("text-[10px] font-black uppercase tracking-[0.2em]", utilization > 90 ? "text-rose-600" : utilization > 70 ? "text-amber-600" : "text-emerald-600")}>{utilization.toFixed(1)}% SECURED</span>
                                                                            </div>
                                                                        </TableCell>
                                                                    </motion.tr>
                                                                );
                                                            })}
                                                        </AnimatePresence>
                                                    </TableBody>
                                                </Table>
                                            </div>
                                        </div>
                                    </Card>
                                </motion.div>
                            )
                        )}
                    </TabsContent>
                </Tabs>
            </div>
        </div>
    )
}


