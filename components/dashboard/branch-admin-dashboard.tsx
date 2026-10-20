"use client"

import { useMemo, useState, useCallback, useEffect } from "react"
import { motion } from "framer-motion"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useSalesPerformance, type DateRange, type SalesPerformanceResponse } from "@/lib/hooks/use-sales-performance"
import { Card, CardContent } from "@/components/ui/card"
import { NotificationRail } from "@/components/notifications/notification-center"
import { formatPKR, cn } from "@/lib/utils"
import {
  TrendingUp, Package, RefreshCw, Filter, CheckCircle2, RotateCcw, Activity, Users, Building2,
  Layers, Clock, Calendar
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SalesPerformanceBarChart } from "@/components/dashboard/charts"
import { BankingKPICard,type TrendDirection } from "@/components/dashboard/banking-kpi-card"
import { GlobalDateFilter, type FilterPreset,type GlobalDateFilterChange, getPresetLabel, getPresetRange } from "@/components/dashboard/global-date-filter"
import { DrillDownSheet, type DrillDownType } from "@/components/dashboard/drill-down-sheet"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"

import { useAppContext } from "@/components/context/app-context"
import { startOfDay, endOfDay } from "date-fns"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

/**
 * A dashboard scope supplied by the caller instead of read from the shell
 * context. Used by roles whose reach is a set of branches rather than the one
 * branch pinned on their user row.
 *
 * This only decides which filters the dashboard *asks* for. Every analytics
 * endpoint behind it re-derives the caller's permitted branches on the server
 * and intersects them with whatever is requested, so a scope passed here can
 * narrow the view but never widen it.
 */
export type BranchDashboardScope = {
  organizationId: string | null
  /** The single branch, for a role pinned to one; null for a branch set. */
  branchId: string | null
  /** The branch set, for a role whose reach is many branches. */
  branchIds?: string[]
  /** False while the scope is still resolving; no request is issued until true. */
  isReady: boolean
  /** Heading shown above the filter row. */
  heading: string
}

type ChartQuickFilter = "today" | "7d" | null
type ChartGranularity = "daily" | "monthly" | "yearly"
type ChartSeriesPoint = { label: string; sales: number; orders: number; itemQuantity: number }

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

type ChartPeriodSelection = {
  chartQuickFilter: ChartQuickFilter
  chartMonths: number[]
  chartYears: number[]
  months: number[]
  years: number[]
}

/** The chart's local filters that follow from a change of the global preset. */
function chartFiltersForPreset(
  preset: FilterPreset,
  months: number[],
  years: number[],
  availableYears: number[],
): Pick<ChartPeriodSelection, "chartQuickFilter" | "chartMonths" | "chartYears"> {
  if (preset === "today" || preset === "7d") {
    return { chartQuickFilter: preset, chartMonths: [], chartYears: [] }
  }
  if (preset === "all") {
    return { chartQuickFilter: null, chartMonths: ALL_MONTHS, chartYears: availableYears }
  }
  return { chartQuickFilter: null, chartMonths: months, chartYears: years }
}

function resolveChartGranularity(
  { chartQuickFilter, chartMonths, chartYears, months, years }: ChartPeriodSelection,
  activePreset: FilterPreset,
): ChartGranularity {
  const hasChartFilters = chartMonths.length > 0 || chartYears.length > 0
  if (chartQuickFilter === "today" || (activePreset === "today" && !hasChartFilters)) {
    return "daily"
  }
  const followsGlobalFilters = !chartQuickFilter && chartMonths.length === 0
  if (chartYears.length > 1 || (chartYears.length === 0 && years.length > 1 && followsGlobalFilters)) {
    return "yearly"
  }
  const isBroadRange = !chartQuickFilter && ["all", "yearly", "monthly", "custom"].includes(activePreset)
  const globalPicksMonths = !chartQuickFilter && (months.length > 0 || years.length === 1)
  if (chartMonths.length > 0 || chartYears.length === 1 || globalPicksMonths || isBroadRange) {
    return "monthly"
  }
  return "daily"
}

function findSeriesPoint(raw: any[], matches: (label: string | undefined) => boolean | undefined, label: string): ChartSeriesPoint {
  const match = raw.find((r: any) => matches(r.label))
  return {
    label,
    sales: match?.sales ?? 0,
    orders: match?.orders ?? 0,
    itemQuantity: match?.itemQuantity ?? 0,
  }
}

/**
 * Lays the series out one bar per selected year, or one per selected month,
 * filling the gaps with zeros. Without month/year filters the chart scaffolds
 * its intervals from the date range and matches by label, so the raw series is
 * returned as-is to keep those labels aligned.
 */
function normalizeChartSeries(raw: any[], { chartMonths, chartYears, months, years }: Omit<ChartPeriodSelection, "chartQuickFilter">): any[] {
  if (chartMonths.length === 0 && chartYears.length === 0) {
    return raw
  }

  const activeYears = chartYears.length > 0 ? chartYears : years
  const activeMonths = chartMonths.length > 0 ? chartMonths : months

  if (activeYears.length > 1) {
    return activeYears.toSorted((a, b) => a - b).map(y =>
      findSeriesPoint(raw, label => label === String(y) || label?.startsWith(String(y)), String(y)),
    )
  }

  const monthsToShow = activeMonths.length > 0 && activeMonths.length < 12
    ? activeMonths.toSorted((a, b) => a - b)
    : ALL_MONTHS

  return monthsToShow.map(m => {
    const monthPrefix = MONTH_NAMES[m - 1]
    return findSeriesPoint(raw, label => label?.startsWith(monthPrefix), monthPrefix)
  })
}

function buildTrend(
  compare: boolean,
  current: number,
  prev: number | undefined,
  formatFn?: (v: number) => string,
): { type: TrendDirection; value: string; label: string } | undefined {
  if (!compare || prev === undefined || prev === null) return undefined
  const diff = current - prev
  let percentage = current > 0 ? 100 : 0
  if (prev > 0) percentage = (diff / prev) * 100
  const fmt = formatFn || ((v: number) => v.toLocaleString())
  const type: TrendDirection = diff >= 0 ? "up" : "down"
  return {
    type,
    value: `${Math.abs(percentage).toFixed(1)}%`,
    label: `${fmt(current)} vs ${fmt(prev)}`
  }
}

export function BranchAdminDashboard({ scope }: Readonly<{ scope?: BranchDashboardScope }> = {}) {
  const {
    organizationId: contextOrganizationId,
    branchId: contextBranchId,
    userRole,
    isInitialized,
  } = useAppContext()

  // Without an explicit scope the component behaves exactly as before: the
  // Branch Admin's own organization and branch, straight from the shell.
  const organizationId = scope ? scope.organizationId : contextOrganizationId
  const branchId = scope ? scope.branchId : contextBranchId
  const branchIds = scope?.branchIds
  const isScopeReady = scope ? scope.isReady : isInitialized
  const heading = scope?.heading ?? "Branch Metrics"

  // Branch Admin defaults to 'Today'
  const defaultPreset = "today" as const
  
  const [dateRange, setDateRange] = useState<DateRange | null>(getPresetRange(defaultPreset))
  const [activePreset, setActivePreset] = useState<FilterPreset>(defaultPreset)
  const [compare, setCompare] = useState(false)
  const [compareRange, setCompareRange] = useState<DateRange | null>(null)
  const [months, setMonths] = useState<number[]>([])
  const [years, setYears] = useState<number[]>([])
  const [compareMonths, setCompareMonths] = useState<number[]>([])
  const [compareYears, setCompareYears] = useState<number[]>([])

  const [drillDownType, setDrillDownType] = useState<DrillDownType | null>(null)
  const [isDrillDownOpen, setIsDrillDownOpen] = useState(false)
  const allTimeEndDate = useMemo(() => new Date().toISOString(), [])

  // The branch filter for the all-time year probe below: a single branch for a
  // pinned role, or the explicit set for a multi-branch one.
  const allTimeBranchParam = (() => {
    if (branchIds?.length) return `branchIds=${branchIds.join(",")}`
    return branchId ? `branchId=${branchId}` : null
  })()

  // Fetch all-time data to extract available years from the database for this branch
  // (deferred until the branch context has hydrated — previously this could fire
  // with the literal string "branchId=null" before initialization)
  const { data: allTimePerf } = useSWR(
    isScopeReady && allTimeBranchParam
      ? `/api/v1/analytics/sales-performance?startDate=2015-01-01T00:00:00.000Z&endDate=${allTimeEndDate}&granularity=yearly&status=all&${allTimeBranchParam}`
      : null,
    fetcher
  )

  const chartYearsAvailable = useMemo(() => {
    const series = (allTimePerf as any)?.seriesData || []
    const years = new Set<number>()
    series.forEach((s: any) => {
      const y = Number.parseInt(s.label)
      if (!Number.isNaN(y)) years.add(y)
    })
    if (years.size === 0) years.add(new Date().getFullYear())
    return Array.from(years).sort((a, b) => b - a)
  }, [allTimePerf]);

  // ── Local Chart State ──
  const [chartQuickFilter, setChartQuickFilter] = useState<ChartQuickFilter>("today")
  const [chartMonths, setChartMonths] = useState<number[]>([])
  const [chartYears, setChartYears] = useState<number[]>([])

  const handleChartMonths = useCallback((m: number[]) => {
    setChartMonths(m)
    if (m.length > 0) setChartQuickFilter(null)
  }, [])
  const handleChartYears = useCallback((y: number[]) => {
    setChartYears(y)
    if (y.length > 0) setChartQuickFilter(null)
  }, [])
  const handleQuickFilter = useCallback((f: ChartQuickFilter) => {
    setChartQuickFilter(f)
    setChartMonths([])
    setChartYears([])
  }, [])

  // Sync Global Filters to Local Chart Filters
  useEffect(() => {
    const next = chartFiltersForPreset(activePreset, months, years, chartYearsAvailable)
    setChartQuickFilter(next.chartQuickFilter)
    setChartMonths(next.chartMonths)
    setChartYears(next.chartYears)
  }, [activePreset, months, years, chartYearsAvailable])

  const handleKPIOpen = (type: DrillDownType) => {
    setDrillDownType(type)
    setIsDrillDownOpen(true)
  }

  // Sales performance data for KPIs (Global Filter)
  const { data: perfData, isLoading: isLoadingPerf } = useSalesPerformance({
    organizationId,
    branchId,
    branchIds,
    dateRange,
    status: "all",
    compare,
    compareRange,
    months,
    years,
    compareMonths,
    compareYears,
    granularity: activePreset === "all" ? "yearly" : undefined,
    includeStatusCounts: true,
    request: { enabled: isScopeReady, keepPreviousData: true },
  })

  // Chart Logic (Local Filters)
  const chartDateRange = useMemo(() => {
    if (chartQuickFilter === "today") return getPresetRange("today")
    if (chartQuickFilter === "7d") {
      const end = endOfDay(new Date())
      const start = startOfDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000))
      return { startDate: start, endDate: end }
    }
    if (chartMonths.length > 0 || chartYears.length > 0) return null
    return dateRange
  }, [chartQuickFilter, chartMonths, chartYears, dateRange])

  const hasChartFilters = chartMonths.length > 0 || chartYears.length > 0
  const chartComponentDateRange = (() => {
    if (chartQuickFilter === "today") {
      return getPresetRange("today")
    }
    return (hasChartFilters ? null : chartDateRange)
  })()

  const chartGranularity = resolveChartGranularity(
    { chartQuickFilter, chartMonths, chartYears, months, years },
    activePreset,
  )

  const { data: chartPerfData, isLoading: isLoadingChart } = useSalesPerformance({
    organizationId,
    branchId,
    branchIds,
    dateRange: chartDateRange,
    status: "all",
    compare: false,
    compareRange: null,
    months: chartMonths,
    years: chartYears,
    compareMonths: [],
    compareYears: [],
    granularity: chartGranularity,
    request: { enabled: isScopeReady, keepPreviousData: true },
  })
  const pricesHidden = Boolean((perfData as any)?.pricesHidden || (chartPerfData as any)?.pricesHidden || (allTimePerf as any)?.pricesHidden)
  const priceVisibilityKnown = [perfData, chartPerfData, allTimePerf].some((data: any) => typeof data?.pricesHidden === "boolean")
  const isPriceVisibilityPending = userRole === "BRANCH_ADMIN" && !priceVisibilityKnown

  const normalizedChartData = useMemo(
    () => normalizeChartSeries(chartPerfData?.seriesData ?? [], { chartMonths, chartYears, months, years }),
    [chartPerfData, chartMonths, chartYears, months, years],
  )


  const handleDateChange = useCallback(({ range, preset, compare: compareMode, compareRange: compRange, months: m, years: y, compareMonths: cm, compareYears: cy }: GlobalDateFilterChange) => {
    setDateRange(range)
    setActivePreset(preset)
    if (compareMode !== undefined) setCompare(compareMode)
    if (compRange !== undefined) setCompareRange(compRange)
    setMonths(m || [])
    setYears(y || [])
    setCompareMonths(cm || [])
    setCompareYears(cy || [])
  }, [])

  const resetDashboardFilters = useCallback(() => {
    handleDateChange({ range: getPresetRange("all"), preset: "all", compare: false, compareRange: null, months: [], years: [], compareMonths: [], compareYears: [] })
  }, [handleDateChange])

  const trendFor = useCallback(
    (current: number, prev: number | undefined) => buildTrend(compare, current, prev),
    [compare],
  )

  return (
    <motion.main 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 lg:p-6 space-y-6 max-w-[2000px] mx-auto overflow-x-hidden"
    >
      <NotificationRail className="bg-transparent border-0 shadow-none px-0" />

      {/* ━━━ Header & Filters ━━━ */}
      <div className="relative z-30 flex flex-col md:flex-row md:items-center justify-between gap-4 mb-2">
        <div className="flex items-center gap-3 px-2">
          <Layers className="w-5 h-5 text-indigo-500" />
          <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">{heading}</h2>
        </div>
        
        <div className="flex items-center gap-3 flex-wrap">
          <GlobalDateFilter 
            value={dateRange} 
            onChange={handleDateChange} 
            activePreset={activePreset} 
            compare={compare} 
            compareRange={compareRange}
            months={months}
            years={years}
            compareMonths={compareMonths}
            compareYears={compareYears}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={resetDashboardFilters}
            className="h-10 w-10 rounded-xl text-slate-400 hover:bg-indigo-50/60 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400"
            aria-label="Reset dashboard filters"
            title="Reset dashboard filters"
          >
            <RefreshCw className={cn("h-4 w-4", isLoadingPerf && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* ━━━ KPI Cards ━━━ */}
      <BranchKpiCards
        perfData={perfData}
        pricesHidden={pricesHidden}
        isPriceVisibilityPending={isPriceVisibilityPending}
        subtitle={getPresetLabel(activePreset, dateRange)}
        trendFor={trendFor}
        onOpen={handleKPIOpen}
      />

      {/* ━━━ Sales Performance Chart ━━━ */}
      <div className="space-y-6">
        <Card className="border border-slate-200/80 dark:border-slate-800/60 shadow-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl overflow-hidden glass-card">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-3 mb-6 p-3 bg-slate-50/50 dark:bg-slate-800/20 rounded-xl border border-slate-100 dark:border-slate-800/50">
              <div className="flex items-center gap-2 pr-3 border-r border-slate-200 dark:border-slate-800">
                <Filter className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Filters</span>
              </div>

              <ChartPeriodFilters
                quickFilter={chartQuickFilter}
                onQuickFilter={handleQuickFilter}
                months={chartMonths}
                onMonths={handleChartMonths}
                years={chartYears}
                onYears={handleChartYears}
                availableYears={chartYearsAvailable}
                isLoading={isLoadingChart}
              />
            </div>

            {(() => {
              if (!chartPerfData || isPriceVisibilityPending) {
                return (
              <div className="h-[400px] flex items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50">
                <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-200 dark:border-slate-800 border-t-emerald-500" />
              </div>
            )
              }
              if (pricesHidden) {
                return (
              <BranchQuantityBarChart
                seriesData={normalizedChartData}
                totalItemsSold={chartPerfData?.totalItemsSold ?? 0}
                avgItemsSold={chartPerfData?.avgItemsSold ?? 0}
                peakPeriod={chartPerfData?.peakQuantityPeriod ?? null}
                granularity={chartGranularity}
              />
            )
              }
              return (
              <SalesPerformanceBarChart
                seriesData={normalizedChartData}
                totalSales={chartPerfData?.totalNetSales ?? chartPerfData?.totalSales ?? 0}
                avgSales={chartPerfData?.avgSales ?? 0}
                totalOrders={chartPerfData?.totalOrders ?? 0}
                peakPeriod={chartPerfData?.peakPeriod ?? null}
                granularity={chartGranularity}
                label="Purchases"
                dateRange={chartComponentDateRange}
                comparisonSeries={chartPerfData?.comparison?.seriesData}
                showOrgView={false}
              />
            )
            })()}
          </CardContent>
        </Card>
      </div>

      {!pricesHidden && <DrillDownSheet
        isOpen={isDrillDownOpen}
        onOpenChange={setIsDrillDownOpen}
        type={drillDownType}
        organizationId={organizationId}
        branchId={branchId}
        branchIds={branchIds}
        defaultDateRange={dateRange}
        activePreset={activePreset}
        compare={compare}
        compareRange={compareRange}
        months={months}
        years={years}
        compareMonths={compareMonths}
        compareYears={compareYears}
      />}
    </motion.main>
  )
}

type TrendFor = (current: number, prev: number | undefined) => ReturnType<typeof buildTrend>

function BranchKpiCards({
  perfData,
  pricesHidden,
  isPriceVisibilityPending,
  subtitle,
  trendFor,
  onOpen,
}: Readonly<{
  perfData: SalesPerformanceResponse | undefined
  pricesHidden: boolean
  isPriceVisibilityPending: boolean
  subtitle: string
  trendFor: TrendFor
  onOpen: (type: DrillDownType) => void
}>) {
  const totalRevenue = perfData?.totalNetSales ?? perfData?.totalSales ?? 0
  const totalOrders = perfData?.totalOrders ?? 0
  const totalItemsSold = perfData?.totalItemsSold ?? 0
  const pendingCount = perfData?.statusCounts?.pendingCount ?? 0
  const fulfilledCount = perfData?.statusCounts?.fulfilledCount ?? 0
  const fulfilledPaidCount = perfData?.statusCounts?.fulfilledPaidCount ?? 0
  const fulfilledUnpaidCount = perfData?.statusCounts?.fulfilledUnpaidCount ?? 0

  const refundedCount = perfData?.statusCounts?.refundedCount ?? 0
  const rejectedCount = perfData?.statusCounts?.rejectedCount ?? 0
  const approvedCount = perfData?.statusCounts?.approvedCount ?? 0
  const deliveredCount = perfData?.statusCounts?.deliveredCount ?? 0
  const notDeliveredCount = perfData?.statusCounts?.notDeliveredCount ?? 0
  const totalUsers = perfData?.totalUsers ?? 0
  const totalBranches = perfData?.totalBranches ?? 0
  const pendingAmount = (perfData?.statusCounts?.pendingAmountCents ?? 0) / 100
  const approvedAmount = (perfData?.statusCounts?.approvedAmountCents ?? 0) / 100
  const fulfilledAmount = (perfData?.statusCounts?.valueFulfilledCents ?? 0) / 100
  const refundedAmount = (perfData?.statusCounts?.valueRefundedCents ?? 0) / 100
  const rejectedAmount = (perfData?.statusCounts?.valueRejectedCents ?? 0) / 100
  const exceptionCount = refundedCount + rejectedCount
  const previousExceptionCount = perfData?.comparison
    ? (perfData.comparison.refundedCount ?? 0) + (perfData.comparison.rejectedCount ?? 0)
    : undefined

  return (
    <div className="relative z-10 grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      {(() => {
        if (isPriceVisibilityPending) {
          return (
        <BankingKPICard
          icon={TrendingUp} title="Loading"
          value="..."
          subtitle="Checking access"
          gradient="from-slate-400 to-slate-600" iconBg="text-slate-600 bg-slate-600" delay={0}
          isLoading={!perfData}
        />
      )
        }
        if (pricesHidden) {
          return (
        <BankingKPICard
          icon={TrendingUp} title="Items"
          value={totalItemsSold.toLocaleString()}
          subtitle={subtitle}
          gradient="from-emerald-500 to-teal-600" iconBg="text-emerald-600 bg-emerald-600" delay={0}
          trend={trendFor(totalItemsSold, perfData?.comparison?.totalItemsSold)?.type}
          trendValue={trendFor(totalItemsSold, perfData?.comparison?.totalItemsSold)?.value}
          comparisonValue={trendFor(totalItemsSold, perfData?.comparison?.totalItemsSold)?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
      )
        }
        return (
        <BankingKPICard
          icon={TrendingUp} title="Purchased"
          value={formatPKR(totalRevenue, { maximumFractionDigits: 0 })}
          subtitle={subtitle}
          gradient="from-emerald-500 to-teal-600" iconBg="text-emerald-600 bg-emerald-600" delay={0}
          onClick={() => onOpen("REVENUE")}
          trend={trendFor(totalRevenue, perfData?.comparison?.totalNetSales ?? perfData?.comparison?.totalSales)?.type}
          trendValue={trendFor(totalRevenue, perfData?.comparison?.totalNetSales ?? perfData?.comparison?.totalSales)?.value}
          comparisonValue={trendFor(totalRevenue, perfData?.comparison?.totalNetSales ?? perfData?.comparison?.totalSales)?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
      )
      })()}
      <BankingKPICard
        icon={Package} title="Orders"
        value={totalOrders.toLocaleString()}
        subtitle={subtitle}
        gradient="from-blue-500 to-indigo-600" iconBg="text-blue-600 bg-blue-600" delay={50}
        onClick={() => onOpen("ORDERS")}
        trend={trendFor(totalOrders, perfData?.comparison?.totalOrders)?.type}
        trendValue={trendFor(totalOrders, perfData?.comparison?.totalOrders)?.value}
        comparisonValue={trendFor(totalOrders, perfData?.comparison?.totalOrders)?.label}
        comparisonLabel="VS LAST"
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={Activity} title="Pending Approval"
        value={pendingCount.toLocaleString()}
        amount={pricesHidden ? undefined : formatPKR(pendingAmount, { maximumFractionDigits: 0 })}
        subtitle={subtitle}
        gradient="from-amber-400 to-orange-500" iconBg="text-amber-600 bg-amber-600" delay={75}
        onClick={() => onOpen("PENDING" as any)}
        trend={trendFor(pendingCount, perfData?.comparison?.pendingCount)?.type}
        trendValue={trendFor(pendingCount, perfData?.comparison?.pendingCount)?.value}
        comparisonValue={trendFor(pendingCount, perfData?.comparison?.pendingCount)?.label}
        comparisonLabel="VS LAST"
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={CheckCircle2} title="Active"
        value={approvedCount.toLocaleString()}
        amount={pricesHidden ? undefined : formatPKR(approvedAmount, { maximumFractionDigits: 0 })}
        subtitle={subtitle}
        gradient="from-blue-400 to-indigo-500" iconBg="text-blue-600 bg-blue-600" delay={100}
        onClick={() => onOpen("APPROVED")}
        trend={trendFor(approvedCount, perfData?.comparison?.approvedCount)?.type}
        trendValue={trendFor(approvedCount, perfData?.comparison?.approvedCount)?.value}
        comparisonValue={trendFor(approvedCount, perfData?.comparison?.approvedCount)?.label}
        comparisonLabel="VS LAST"
        details={[
          { label: "Delivered/Unacknowledged", value: deliveredCount.toLocaleString(), align: "left" },
          { label: "Not Delivered", value: notDeliveredCount.toLocaleString(), align: "right" },
        ]}
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={CheckCircle2} title="Fulfilled"
        value={fulfilledCount.toLocaleString()}
        amount={pricesHidden ? undefined : formatPKR(fulfilledAmount, { maximumFractionDigits: 0 })}
        subtitle={subtitle}
        gradient="from-teal-500 to-cyan-600" iconBg="text-teal-600 bg-teal-600" delay={125}
        onClick={() => onOpen("FULFILLED")}
        trend={trendFor(fulfilledCount, perfData?.comparison?.fulfilledCount)?.type}
        trendValue={trendFor(fulfilledCount, perfData?.comparison?.fulfilledCount)?.value}
        comparisonValue={trendFor(fulfilledCount, perfData?.comparison?.fulfilledCount)?.label}
        comparisonLabel="VS LAST"
        details={[
          { label: "Paid", value: fulfilledPaidCount.toLocaleString(), align: "left" },
          { label: "Unpaid", value: fulfilledUnpaidCount.toLocaleString(), align: "right" },
        ]}
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={RotateCcw} title="Refunded / Rejected"
        value={exceptionCount.toLocaleString()}
        subtitle={subtitle}
        gradient="from-red-500 to-slate-700" iconBg="text-red-600 bg-red-600" delay={150}
        trend={trendFor(exceptionCount, previousExceptionCount)?.type}
        trendValue={trendFor(exceptionCount, previousExceptionCount)?.value}
        comparisonValue={trendFor(exceptionCount, previousExceptionCount)?.label}
        comparisonLabel="VS LAST"
        details={[
          {
            label: "Refunded",
            value: refundedCount.toLocaleString(),
            amount: pricesHidden ? undefined : formatPKR(refundedAmount, { maximumFractionDigits: 0 }),
            onClick: pricesHidden ? undefined : () => onOpen("REFUNDED"),
          },
          {
            label: "Rejected",
            value: rejectedCount.toLocaleString(),
            amount: pricesHidden ? undefined : formatPKR(rejectedAmount, { maximumFractionDigits: 0 }),
            onClick: pricesHidden ? undefined : () => onOpen("REJECTED"),
          },
        ]}
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={Users} title="Total Users"
        value={totalUsers.toLocaleString()}
        subtitle="Current scope"
        gradient="from-violet-500 to-purple-600" iconBg="text-violet-600 bg-violet-600" delay={175}
        isLoading={!perfData}
      />
      <BankingKPICard
        icon={Building2} title="Total Branches"
        value={totalBranches.toLocaleString()}
        subtitle="Current scope"
        gradient="from-cyan-500 to-sky-600" iconBg="text-cyan-600 bg-cyan-600" delay={200}
        isLoading={!perfData}
      />
    </div>
  )
}

function ChartPeriodFilters({
  quickFilter,
  onQuickFilter,
  months,
  onMonths,
  years,
  onYears,
  availableYears,
  isLoading,
}: Readonly<{
  quickFilter: ChartQuickFilter
  onQuickFilter: (f: ChartQuickFilter) => void
  months: number[]
  onMonths: (m: number[]) => void
  years: number[]
  onYears: (y: number[]) => void
  availableYears: number[]
  isLoading: boolean
}>) {
  return (
    <>
      <div className="flex items-center gap-1">
        <Button
          variant={quickFilter === "today" ? "default" : "outline"}
          size="sm"
          onClick={() => onQuickFilter("today")}
          className={cn("h-8 px-3 rounded-lg text-[10px] font-semibold uppercase tracking-wider", quickFilter === "today" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500")}
        >
          <Clock className="h-3 w-3 mr-1" /> Today
        </Button>
        <Button
          variant={quickFilter === "7d" ? "default" : "outline"}
          size="sm"
          onClick={() => onQuickFilter("7d")}
          className={cn("h-8 px-3 rounded-lg text-[10px] font-semibold uppercase tracking-wider", quickFilter === "7d" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500")}
        >
          7D
        </Button>
      </div>

      <div className="h-6 w-[1px] bg-slate-200 dark:bg-slate-700 mx-0.5" />

      <MonthFilter selected={months} onChange={onMonths} />
      <YearFilter selected={years} onChange={onYears} availableYears={availableYears} />

      {isLoading && (
        <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-400 font-medium">
          <RefreshCw className="h-3 w-3 animate-spin text-emerald-500" /> Syncing Data
        </div>
      )}
    </>
  )
}

type BranchQuantityPoint = {
  label: string
  orders?: number
  itemQuantity?: number
}

function QuantityTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  const point = payload[0]?.payload as BranchQuantityPoint | undefined

  return (
    <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md p-4 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 dark:border-slate-800 min-w-[190px]">
      <p className="font-bold text-slate-800 dark:text-slate-200 text-sm mb-2.5 pb-2 border-b border-slate-100 dark:border-slate-800">{label}</p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Items</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">{Number(point?.itemQuantity || 0).toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Orders</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">{Number(point?.orders || 0).toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

function BranchQuantityBarChart({
  seriesData,
  totalItemsSold,
  avgItemsSold,
  peakPeriod,
  granularity,
}: Readonly<{
  seriesData: BranchQuantityPoint[]
  totalItemsSold: number
  avgItemsSold: number
  peakPeriod: BranchQuantityPoint | null
  granularity: "hourly" | "daily" | "monthly" | "yearly"
}>) {
  const isEmpty = !seriesData || seriesData.length === 0 || totalItemsSold === 0
  const peakLabel = peakPeriod?.label || "-"
  const peakValue = Number(peakPeriod?.itemQuantity || 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.3em]">
            Quantity Distribution
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/20 p-4">
          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Total Items</p>
          <p className="text-2xl font-black text-emerald-600 dark:text-emerald-400 tracking-tight">{totalItemsSold.toLocaleString()}</p>
        </div>
        <div className="rounded-2xl bg-blue-500/10 ring-1 ring-inset ring-blue-500/20 p-4">
          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Average Items</p>
          <p className="text-2xl font-black text-blue-600 dark:text-blue-400 tracking-tight">{Math.round(avgItemsSold).toLocaleString()}</p>
        </div>
        <div className="rounded-2xl bg-amber-500/10 ring-1 ring-inset ring-amber-500/20 p-4">
          <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-2">Peak Period</p>
          <p className="text-lg font-black text-amber-600 dark:text-amber-400 tracking-tight truncate">{peakLabel}</p>
          <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mt-1">{peakValue.toLocaleString()} items</p>
        </div>
      </div>

      <div className="relative glass-card rounded-[2.5rem] p-8 shadow-2xl overflow-hidden min-h-[440px]">
        {isEmpty && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/40 dark:bg-slate-950/40 backdrop-blur-[2px]">
            <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4 shadow-inner">
              <Package className="w-8 h-8 text-slate-300 dark:text-slate-600" />
            </div>
            <p className="text-sm font-bold text-slate-400 dark:text-slate-500">No quantity activity recorded for this period</p>
          </div>
        )}

        <div className={`h-[380px] w-full transition-opacity duration-500 ${isEmpty ? 'opacity-30 grayscale-[50%]' : 'opacity-100'}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={seriesData}
              margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
            >
              <defs>
                <linearGradient id="branchQuantityBarGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={1} />
                  <stop offset="100%" stopColor="#059669" stopOpacity={0.8} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }}
                dy={15}
                minTickGap={10}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }}
                tickFormatter={(val) => Number(val).toLocaleString()}
                width={70}
                dx={-10}
              />
              <Tooltip
                content={<QuantityTooltip />}
                cursor={{ fill: "rgba(0,0,0,0.02)" }}
              />
              <Bar
                dataKey="itemQuantity"
                name="Items"
                fill="url(#branchQuantityBarGrad)"
                radius={[4, 4, 0, 0]}
                animationDuration={1500}
                barSize={granularity === "daily" && seriesData.length <= 7 ? 60 : undefined}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  )
}

function MonthFilter({ selected, onChange }: Readonly<{ selected: number[], onChange: (v: number[]) => void }>) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  const items = months.map((m, i) => ({ id: i + 1, label: m }))
  
  return (
    <MultiSelectFilter
      title="Months"
      items={items}
      selectedIds={selected}
      onChange={(ids) => onChange(ids.toSorted((a, b) => a - b))}
      icon={<Calendar className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
      placeholder="Months"
      showSearch={false}
    />
  )
}

function YearFilter({ selected, onChange, availableYears }: Readonly<{ selected: number[], onChange: (v: number[]) => void, availableYears: number[] }>) {
  const items = availableYears.map(y => ({ id: y, label: String(y) }))

  return (
    <MultiSelectFilter
      title="Years"
      items={items}
      selectedIds={selected}
      onChange={(ids) => onChange(ids.toSorted((a, b) => a - b))}
      icon={<Layers className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
      placeholder="Years"
      showSearch={false}
    />
  )
}
