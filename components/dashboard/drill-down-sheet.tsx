"use client"

import { useEffect, useState, useMemo, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import useSWR from "swr"
import { formatPKR, cn } from "@/lib/utils"
import { format } from "date-fns"
import { fetcher } from "@/lib/fetcher"
import {
    FULFILLMENT_STATUS_LABELS,
    normalizeFulfillmentStatus,
} from "@/lib/fulfillment-status"

const formatDuration = (mins: number) => {
    if (mins <= 0) return "0m"
    if (mins < 60) return `${mins}m`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`
    const d = Math.floor(h / 24)
    const hRemaining = h % 24
    return hRemaining > 0 ? `${d}d ${hRemaining}h` : `${d}d`
}

const getDeliveryStatusColor = (status?: string | null) => {
    switch (normalizeFulfillmentStatus(status)) {
        case "DELIVERED":
            return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
        case "OUT_FOR_DELIVERY":
            return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300"
        case "IN_PROCESS":
            return "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300"
        default:
            return "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400"
    }
}

import {
    Sheet,
    SheetContent,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Loader2, AlertCircle, CheckCircle2, Package, TrendingUp, TrendingDown,
    Award, Box, ChevronRight, ArrowDownAZ, ArrowDown01, RotateCcw, Truck,
    User, Clock, Info, Search, CalendarDays
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"

import { GlobalDateFilter, getPresetRange, type FilterPreset } from "@/components/dashboard/global-date-filter"
import type { DateRange } from "@/lib/hooks/use-sales-performance"
import { useAppContext } from "@/components/context/app-context"

export type DrillDownType = "REVENUE" | "REJECTED" | "FULFILLED" | "ORDERS" | "REFUNDED" | "PENDING" | "APPROVED" | "PARTIAL" | "DELIVERED" | "NOT_DELIVERED"

interface DrillDownSheetProps {
    isOpen: boolean
    onOpenChange: (open: boolean) => void
    type: DrillDownType | null
    organizationId?: string | null
    branchId?: string | null
    branchIds?: string[]
    defaultDateRange?: DateRange | null
    title?: string
    compare?: boolean
    compareRange?: DateRange | null
    activePreset?: FilterPreset
    months?: number[]
    years?: number[]
    compareMonths?: number[]
    compareYears?: number[]
}

const normalizeMonthsForApi = (selectedMonths?: number[]) => {
    if (!selectedMonths || selectedMonths.length === 0) return []

    const isLegacyZeroBased = selectedMonths.some(month => month === 0)
    const normalized = selectedMonths
        .map(month => isLegacyZeroBased ? month + 1 : month)
        .filter(month => Number.isInteger(month) && month >= 1 && month <= 12)

    return Array.from(new Set(normalized)).sort((a, b) => a - b)
}

const TYPE_CONFIG = {
    REVENUE: {
        title: "Revenue Insights",
        icon: TrendingUp,
        color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20",
    },
    REJECTED: {
        title: "Rejected Orders Analysis",
        icon: AlertCircle,
        color: "text-red-600 bg-red-50 dark:bg-red-900/20",
    },
    FULFILLED: {
        title: "Fulfillment Performance",
        icon: CheckCircle2,
        color: "text-teal-600 bg-teal-50 dark:bg-teal-900/20",
    },
    ORDERS: {
        title: "Order Volume Breakdown",
        icon: Package,
        color: "text-blue-600 bg-blue-50 dark:bg-blue-900/20",
    },
    REFUNDED: {
        title: "Refunded Orders Analysis",
        icon: AlertCircle,
        color: "text-amber-600 bg-amber-50 dark:bg-amber-900/20",
    },
    PENDING: {
        title: "Pending Approval Orders",
        icon: Activity,
        color: "text-orange-600 bg-orange-50 dark:bg-orange-900/20",
    },
    APPROVED: {
        title: "Active Orders",
        icon: CheckCircle2,
        color: "text-blue-600 bg-blue-50 dark:bg-blue-900/20",
    },
    DELIVERED: {
        title: "Delivered Orders",
        icon: Truck,
        color: "text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20",
    },
    NOT_DELIVERED: {
        title: "Not Delivered Orders",
        icon: Clock,
        color: "text-sky-600 bg-sky-50 dark:bg-sky-900/20",
    },
    PARTIAL: {
        title: "Partial Fulfillment Analysis",
        icon: Package,
        color: "text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20",
    }
}

const BIInsightCard = ({ title, value, subvalue, icon: Icon, trend, colorClass }: any) => (
    <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn("p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm flex flex-col gap-1.5", colorClass)}
    >
        <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{title}</span>
            <div className="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-800">
                <Icon className="w-3.5 h-3.5 text-slate-600 dark:text-slate-400" />
            </div>
        </div>
        <div className="flex items-end justify-between mt-0.5">
            <span className="text-xl font-semibold tracking-tight">{value}</span>
            {trend && (
                <span className={cn("text-[10px] font-bold flex items-center px-2 py-0.5 rounded-full",
                    trend.includes('Healthy') || trend.includes('Efficient') || trend.includes('Optimal') || trend.startsWith('+')
                        ? "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30"
                        : "text-rose-600 bg-rose-50 dark:bg-rose-950/30")}>
                    {trend}
                </span>
            )}
        </div>
        {subvalue && <span className="text-[10px] font-medium text-slate-400 mt-1">{subvalue}</span>}
    </motion.div>
)

import { Activity } from "lucide-react"

export function DrillDownSheet({
    isOpen,
    onOpenChange,
    type,
    organizationId,
    branchId,
    branchIds,
    defaultDateRange,
    title,
    compare,
    compareRange,
    activePreset: parentActivePreset,
    months: parentMonths,
    years: parentYears,
    compareMonths: parentCompareMonths,
    compareYears: parentCompareYears
}: DrillDownSheetProps): React.ReactElement | null {
    const { userRole } = useAppContext()
    const isBuyer = userRole === "HEAD_OFFICE" || userRole === "BRANCH_ADMIN"

    const [localDateRange, setLocalDateRange] = useState<DateRange | null>(getPresetRange("all"))
    const [localCompareRange, setLocalCompareRange] = useState<DateRange | null>(null)
    const [activePreset, setActivePreset] = useState<FilterPreset>("all")
    const [months, setMonths] = useState<number[]>([])
    const [years, setYears] = useState<number[]>([])
    const [compareMonths, setCompareMonths] = useState<number[]>([])
    const [compareYears, setCompareYears] = useState<number[]>([])
    const [expandedRow, setExpandedRow] = useState<string | null>(null)
    const [refundType, setRefundType] = useState<"all" | "full" | "partial">("all")
    const [searchQuery, setSearchQuery] = useState("")

    useEffect(() => {
        if (isOpen) {
            setLocalDateRange(defaultDateRange || getPresetRange("all"))
            setLocalCompareRange(compareRange || null)
            setActivePreset(parentActivePreset || "all")
            setMonths(parentMonths || [])
            setYears(parentYears || [])
            setCompareMonths(parentCompareMonths || [])
            setCompareYears(parentCompareYears || [])
            setExpandedRow(null)
        }
    }, [isOpen, defaultDateRange, compareRange, parentActivePreset, parentMonths, parentYears, parentCompareMonths, parentCompareYears])

    const url = useMemo(() => {
        if (!isOpen || !type) return null
        const params = new URLSearchParams()
        params.set("type", type)
        if (localDateRange) {
            params.set("startDate", localDateRange.startDate.toISOString())
            params.set("endDate", localDateRange.endDate.toISOString())
        }
        const apiMonths = normalizeMonthsForApi(months)
        if (apiMonths.length > 0) params.set("months", apiMonths.join(","))
        if (years.length > 0) params.set("years", years.join(","))

        if (compare) {
            params.set("compare", "true")
            if (localCompareRange) {
                params.set("compareStartDate", localCompareRange.startDate.toISOString())
                params.set("compareEndDate", localCompareRange.endDate.toISOString())
            }
            const apiCompareMonths = normalizeMonthsForApi(compareMonths)
            if (apiCompareMonths.length > 0) params.set("compareMonths", apiCompareMonths.join(","))
            if (compareYears.length > 0) params.set("compareYears", compareYears.join(","))
        }
        if (type === "REFUNDED") params.set("refundType", refundType)
        if (organizationId && organizationId !== "null") params.set("organizationId", organizationId)
        if (branchIds && branchIds.length > 0) {
            params.set("branchIds", branchIds.join(","))
        } else if (branchId && branchId !== "null") {
            params.set("branchId", branchId)
        }
        return `/api/v1/analytics/drill-down?${params.toString()}`
    }, [isOpen, type, organizationId, branchId, branchIds, localDateRange, refundType, months, years, compareMonths, compareYears, compare, localCompareRange])

    const { data, isLoading } = useSWR<{ items: any[], summary: any, comparison: any, total: number }>(url, fetcher, {
        revalidateOnFocus: false
    })

    const items = useMemo(() => {
        const rawItems = data?.items || []
        if (!searchQuery.trim()) return rawItems

        const query = searchQuery.toLowerCase()
        return rawItems.filter((item: any) =>
            (item.tid || "").toLowerCase().includes(query) ||
            (item.branchName || "").toLowerCase().includes(query) ||
            (item.buyerName || "").toLowerCase().includes(query) ||
            (item.creatorEmployeeId || "").toLowerCase().includes(query) ||
            (item.organizationName || "").toLowerCase().includes(query) ||
            (item.items || []).some((prod: any) =>
                (prod.name || "").toLowerCase().includes(query) ||
                (prod.productCode || "").toLowerCase().includes(query)
            )
        )
    }, [data?.items, searchQuery])
    const summary = data?.summary || {}
    const comparison = data?.comparison || null
    const config = type ? TYPE_CONFIG[type] : null

    const getTrend = useCallback((current: number, prev: number) => {
        if (!prev || prev === 0) return null
        const diff = current - prev
        const percentage = (diff / prev) * 100
        const isUp = diff >= 0
        return `${isUp ? '+' : ''}${percentage.toFixed(1)}%`
    }, [])

    const handleDateChange = useCallback((
        range: DateRange | null,
        preset: FilterPreset,
        compareMode?: boolean,
        compRange?: DateRange | null,
        m?: number[],
        y?: number[],
        cm?: number[],
        cy?: number[]
    ) => {
        setLocalDateRange(range)
        setActivePreset(preset)
        if (compRange !== undefined) setLocalCompareRange(compRange)
        setMonths(m || [])
        setYears(y || [])
        setCompareMonths(cm || [])
        setCompareYears(cy || [])
    }, [])

    if (!config) return null
    const Icon = config.icon

    return (
        <Sheet open={isOpen} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-[90vw] sm:max-w-xl lg:max-w-2xl p-0 flex flex-col gap-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 overflow-hidden">

                {/* header */}
                <div className="sticky top-0 z-30 px-6 pt-6 pb-4 bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl border-b border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-4">
                            <div className={cn("p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900", config.color.split(' ')[0])}>
                                <Icon className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">
                                    {title || (isBuyer && type === "REVENUE" ? "Purchase Insights" : config.title)}
                                    {activePreset === "all" && <span className="text-slate-400 font-normal ml-2">(All Time)</span>}
                                </h2>
                            </div>
                        </div>
                        <div className="flex items-center gap-3 relative z-50">
                            <GlobalDateFilter
                                value={localDateRange}
                                onChange={handleDateChange}
                                activePreset={activePreset}
                                compare={compare}
                                compareRange={localCompareRange}
                                months={months}
                                years={years}
                                compareMonths={compareMonths}
                                compareYears={compareYears}
                                className="scale-90"
                            />
                        </div>
                    </div>

                    {!isLoading && (
                        <div className="flex items-center gap-3 mb-4">
                            <div className="relative flex-1 max-w-xl">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
                                <Input
                                    placeholder="Search by transaction ID, employee number, product, branch..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="pl-10 h-9 text-sm bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700"
                                />
                            </div>
                        </div>
                    )}

                    {!isLoading && items.length > 0 && (
                        <div className="grid grid-cols-2 gap-3 mb-2 animate-in fade-in slide-in-from-top-4 duration-500">
                            {type === "REVENUE" && (
                                <>
                                    <BIInsightCard
                                        title={isBuyer ? "Net Purchased" : "Net Revenue"}
                                        value={formatPKR(summary.netRevenue)}
                                        subvalue={`Gross: ${formatPKR(summary.grossRevenue)}`}
                                        icon={TrendingUp}
                                        trend={comparison ? getTrend(summary.netRevenue, comparison.netRevenue) : undefined}
                                        colorClass="border-emerald-100 dark:border-emerald-900/30"
                                    />
                                    <BIInsightCard
                                        title="Refund Rate"
                                        value={`${summary.refundRate.toFixed(1)}%`}
                                        subvalue={`Total: ${formatPKR(summary.grossRevenue - summary.netRevenue)}`}
                                        trend={summary.refundRate > 5 ? undefined : "- Healthy"}
                                        icon={AlertCircle}
                                        colorClass={summary.refundRate > 5 ? "border-rose-100 dark:border-rose-900/30" : ""}
                                    />
                                </>
                            )}
                            {type === "REFUNDED" && (
                                <>
                                    <BIInsightCard
                                        title="Refunded Orders"
                                        value={refundType === "full" ? (summary.refundedOrdersCount || 0) : (summary.refundRelatedOrdersCount || 0)}
                                        subvalue={refundType === "partial" ? "Partially Refunded" : refundType === "all" ? "Refunded Transactions" : "Completely Refunded"}
                                        icon={RotateCcw}
                                        colorClass="border-rose-50 dark:border-rose-950/20"
                                    />
                                    <BIInsightCard
                                        title="Refunded Value"
                                        value={formatPKR(Math.abs(summary.refundedValue || 0))}
                                        subvalue="Total Money Returned"
                                        icon={TrendingDown}
                                        colorClass="border-rose-50 dark:border-rose-950/20"
                                    />
                                </>
                            )}
                            {(type === "ORDERS" || type === "FULFILLED" || type === "REJECTED" || type === "PARTIAL") && (
                                <>
                                    <BIInsightCard
                                        title={isBuyer ? "Total Purchased" : "Total Revenue"}
                                        value={formatPKR(summary.netRevenue)}
                                        subvalue={isBuyer ? "Net Purchased" : "Net Net Revenue"}
                                        icon={TrendingUp}
                                    />
                                    <BIInsightCard
                                        title={type === "PARTIAL" ? "Partial Orders" : "Fulfilled Orders"}
                                        value={summary.fulfilledOrderCount || 0}
                                        subvalue={type === "PARTIAL" ? "Partially Refunded" : "Total Orders Fulfilled"}
                                        icon={type === "PARTIAL" ? Package : CheckCircle2}
                                        colorClass={type === "PARTIAL" ? "border-indigo-50 dark:border-indigo-950/20" : "border-emerald-50 dark:border-emerald-950/20"}
                                    />
                                </>
                            )}
                        </div>
                    )}
                </div>

                <ScrollArea className="flex-1">
                    <div className="p-6 pt-2">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center py-32 text-slate-400">
                                <Loader2 className="w-8 h-8 animate-spin text-indigo-500 mb-4" />
                                <p className="text-sm font-medium opacity-60">Loading financial data...</p>
                            </div>
                        ) : items.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center grayscale opacity-50">
                                <div className="w-24 h-24 rounded-full bg-slate-100 dark:bg-slate-900 flex items-center justify-center mb-6">
                                    <Search className="w-10 h-10 text-slate-400" />
                                </div>
                                <h3 className="text-lg font-semibold tracking-tight">
                                    {searchQuery.trim() ? "No Matching Transactions" : "No Transactions Found"}
                                </h3>
                                <p className="text-sm text-slate-500 mt-2 max-w-xs">
                                    {searchQuery.trim()
                                        ? `No transactions match your search for "${searchQuery}". Try different keywords.`
                                        : "There are no orders matching your selected filters."
                                    }
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="flex items-center justify-between px-2 mb-2 text-slate-400">
                                    <span className="text-[10px] font-bold uppercase tracking-widest ">Transaction History</span>
                                    <Info className="w-3.5 h-3.5 opacity-40 ml-auto" />
                                </div>
                                <div className="grid grid-cols-1 gap-4">
                                    {items.map((item: any, idx: number) => (
                                        <div key={item.id} className="group">
                                            <motion.div
                                                initial={{ opacity: 0, scale: 0.98 }}
                                                animate={{ opacity: 1, scale: 1 }}
                                                transition={{ delay: idx * 0.02 }}
                                                onClick={() => setExpandedRow(expandedRow === item.id ? null : item.id)}
                                                className={cn(
                                                    "p-4 rounded-3xl border transition-all duration-300 cursor-pointer relative overflow-hidden h-fit",
                                                    expandedRow === item.id
                                                        ? "bg-white dark:bg-slate-900 border-indigo-200 dark:border-indigo-800 shadow-xl ring-1 ring-indigo-500/10"
                                                        : "bg-white/40 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-white dark:hover:bg-slate-900"
                                                )}
                                            >
                                                <div className="flex items-center justify-between gap-4 relative z-10">
                                                    <div className="flex items-center gap-4">
                                                        <div className={cn(
                                                            "w-11 h-11 rounded-2xl flex items-center justify-center font-bold transition-transform group-hover:scale-105",
                                                            item.status === 'FULFILLED' ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40" :
                                                                item.status === 'REJECTED' ? "bg-rose-50 text-rose-600 dark:bg-rose-950/40" :
                                                                    "bg-amber-50 text-amber-600 dark:bg-amber-950/40"
                                                        )}>
                                                            {idx + 1}
                                                        </div>
                                                        <div>
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-semibold text-slate-900 dark:text-white tracking-tight">{item.tid}</span>
                                                            </div>
                                                            <div className="flex flex-wrap items-center gap-3 mt-1 text-[10px] font-medium text-slate-400 uppercase tracking-widest opacity-80">
                                                                <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {format(new Date(item.date), "HH:mm")}</span>
                                                                {type === "APPROVED" && (
                                                                    <span className="flex items-center gap-1 normal-case tracking-normal" title="Date and time this order became active">
                                                                        <CalendarDays className="w-3.5 h-3.5" />
                                                                        {item.approvedAt
                                                                            ? `Approved ${format(new Date(item.approvedAt), "dd MMM yyyy, HH:mm")}`
                                                                            : "Approval date unavailable"}
                                                                    </span>
                                                                )}
                                                                <span className="flex items-center gap-1"><Box className="w-3.5 h-3.5" /> {item.branchName}</span>
                                                                {type === "APPROVED" && (
                                                                    <Badge
                                                                        variant="outline"
                                                                        className={cn(
                                                                            "h-5 rounded-md px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider",
                                                                            getDeliveryStatusColor(item.fulfillmentStatus)
                                                                        )}
                                                                    >
                                                                        {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(item.fulfillmentStatus)]}
                                                                    </Badge>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="flex items-center gap-6">
                                                        <div className="text-right">
                                                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider leading-none mb-1">Value</p>
                                                            <p className="text-sm font-semibold text-slate-900 dark:text-white tabular-nums">
                                                                {formatPKR(type === "REFUNDED" ? item.refundAmount : item.netValue)}
                                                            </p>
                                                        </div>
                                                        <div className={cn("transition-transform duration-500", expandedRow === item.id ? "rotate-90 text-indigo-500" : "rotate-0 text-slate-300")}>
                                                            <ChevronRight className="w-4 h-4" />
                                                        </div>
                                                    </div>
                                                </div>

                                                <AnimatePresence>
                                                    {expandedRow === item.id && (
                                                        <motion.div
                                                            initial={{ opacity: 0, height: 0 }}
                                                            animate={{ opacity: 1, height: "auto" }}
                                                            exit={{ opacity: 0, height: 0 }}
                                                            className="mt-5 pt-5 border-t border-slate-100 dark:border-slate-800 space-y-5"
                                                        >
                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                <div className="p-4 rounded-2xl bg-indigo-50/20 dark:bg-indigo-950/20 border border-indigo-100/50 dark:border-indigo-900/30">
                                                                    <h4 className="text-[9px] font-bold uppercase tracking-widest text-indigo-500 mb-3">Customer Profile</h4>
                                                                    <div className="flex items-center gap-3">
                                                                        <div className="w-9 h-9 rounded-xl bg-white dark:bg-slate-800 flex items-center justify-center border border-indigo-100 dark:border-indigo-900 shadow-sm">
                                                                            <User className="w-4 h-4 text-indigo-500" />
                                                                        </div>
                                                                        <div className="min-w-0">
                                                                            <p className="text-xs font-semibold text-slate-900 dark:text-white truncate">{item.buyerName}</p>
                                                                            <p className="text-[10px] text-slate-500 font-medium">{item.buyerPhone}</p>
                                                                            <p className="text-[9px] font-black text-indigo-500 font-mono mt-1">#{item.creatorEmployeeId || "UNSET"}</p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div className="p-4 rounded-2xl bg-slate-50/50 dark:bg-slate-950/50 border border-slate-200/60 dark:border-slate-800/60">
                                                                    <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-400 mb-3">Order Source</h4>
                                                                    <div className="grid grid-cols-2 gap-3">
                                                                        <div className="min-w-0">
                                                                            <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Entity</p>
                                                                            <p className="text-[11px] font-medium text-slate-900 dark:text-white truncate">{item.organizationName}</p>
                                                                        </div>
                                                                        <div className="min-w-0">
                                                                            <p className="text-[9px] font-semibold text-slate-400 uppercase mb-1">Point</p>
                                                                            <p className="text-[11px] font-medium text-slate-900 dark:text-white truncate">{item.branchName}</p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <div className="space-y-3">
                                                                <h4 className="text-[9px] font-bold uppercase tracking-widest text-indigo-500">Transaction Breakdown</h4>
                                                                <div className="overflow-hidden rounded-2xl border border-slate-200/60 dark:border-slate-800/60 bg-white/50 dark:bg-slate-900/50">
                                                                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                                                                        {item.items?.map((prod: any, pIdx: number) => (
                                                                            <div key={pIdx} className="p-4 flex justify-between items-start gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors group/item">
                                                                                <div className="flex-1 min-w-0">
                                                                                    <p className="font-semibold text-slate-900 dark:text-white leading-tight truncate text-[12px]">{prod.name}</p>
                                                                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                                                                                        <span className="text-[10px] font-semibold text-slate-400 font-mono italic">{prod.productCode || 'N/A'}</span>
                                                                                        <div className="flex items-center gap-1.5 ml-auto md:ml-0">
                                                                                            <Badge variant="outline" className="text-[8px] h-4 border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-0 font-medium">
                                                                                                Qty: {prod.quantity || 0}
                                                                                                {/* Qty: {prod.quantity - (prod.refundQuantity || 0)} */}
                                                                                            </Badge>
                                                                                            {(prod.refundQuantity || 0) > 0 && (
                                                                                                <Badge variant="outline" className="text-[8px] h-4 border-rose-200 bg-rose-50 text-rose-600 px-2 py-0 font-medium font-mono">
                                                                                                    Refunded: {prod.refundQuantity}
                                                                                                </Badge>
                                                                                            )}
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                                <div className="text-right shrink-0">
                                                                                    <p className="text-[12px] font-bold text-slate-900 dark:text-white">
                                                                                        {formatPKR(type === "REFUNDED" && (prod.refundAmount || 0) > 0
                                                                                            ? prod.refundAmount
                                                                                            : (prod.price * (prod.quantity - (prod.refundQuantity || 0)))
                                                                                        )}
                                                                                    </p>
                                                                                    <p className="text-[9px] font-medium text-slate-400 mt-1 opacity-70">@ {formatPKR(prod.price)}</p>
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                    <div className="bg-slate-50/80 dark:bg-slate-800/50 p-3 border-t border-slate-100 dark:border-slate-800">
                                                                        <div className="flex justify-between items-center text-[9px] font-bold uppercase tracking-widest text-slate-400">
                                                                            <span>Order Summary</span>
                                                                            <span className="text-slate-600 dark:text-slate-400">
                                                                                {item.items?.length || 0} Products · {item.items?.reduce((acc: number, cur: any) => acc + cur.quantity, 0) || 0} Units
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>

                                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                                <div className="space-y-3">
                                                                    <h4 className="text-[9px] font-bold uppercase tracking-widest text-indigo-500">Financial Summary</h4>
                                                                    <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 shadow-sm">
                                                                        <div className="flex items-center justify-between mb-2">
                                                                            <span className="text-[11px] font-medium text-slate-500">Items Total</span>
                                                                            <Badge variant="secondary" className="font-bold border-none h-5 px-2 text-[9px]">{item.skuCount} {item.skuCount === 1 ? 'Item' : 'Items'}</Badge>
                                                                        </div>
                                                                        <div className="flex items-center justify-between text-[11px] text-slate-400 font-medium mb-1.5">
                                                                            <span>Subtotal</span>
                                                                            <span className={cn("font-mono", item.refundAmount > 0 && "line-through opacity-50")}>
                                                                                {formatPKR(item.grossValue)}
                                                                            </span>
                                                                        </div>
                                                                        {item.refundAmount > 0 && (
                                                                            <div className="space-y-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800">
                                                                                <div className="flex items-center justify-between text-[11px] text-rose-500 font-semibold">
                                                                                    <span>Refunded Amount</span>
                                                                                    <span className="font-mono">-{formatPKR(item.refundAmount)}</span>
                                                                                </div>
                                                                                <div className="flex items-center justify-between text-[12px] text-emerald-600 font-bold">
                                                                                    <span>{isBuyer ? "Net Purchased" : "Net Revenue"}</span>
                                                                                    <span className="font-mono">{formatPKR(item.netValue)}</span>
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="space-y-3">
                                                                    <h4 className="text-[9px] font-bold uppercase tracking-widest text-indigo-500">Execution Timeline</h4>
                                                                    <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/80 shadow-sm space-y-3">
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-2">
                                                                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
                                                                                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Processing</span>
                                                                            </div>
                                                                            <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-300">{item.preparationTime}</span>
                                                                        </div>
                                                                        <div className="flex items-center justify-between">
                                                                            <div className="flex items-center gap-2">
                                                                                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                                                                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Order Status</span>
                                                                            </div>
                                                                            <Badge className={cn(
                                                                                "font-bold text-[9px] px-2.5 py-0.5 border-none shadow-none",
                                                                                item.status === 'FULFILLED' ? "bg-emerald-500 text-white" :
                                                                                    item.status === 'REJECTED' ? "bg-rose-500 text-white" : "bg-amber-500 text-white"
                                                                            )}>
                                                                                {item.status}
                                                                            </Badge>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </motion.div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </ScrollArea>
                <div className="p-4 bg-white/50 dark:bg-slate-900/50 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between shrink-0">
                    <p className="text-[10px] font-medium text-slate-400 uppercase tracking-widest">Live Financial Analysis</p>
                    <div className="flex gap-1.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500/20" />
                        <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />
                    </div>
                </div>
            </SheetContent>
        </Sheet>
    )
}
