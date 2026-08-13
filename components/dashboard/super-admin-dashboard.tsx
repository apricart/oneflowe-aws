"use client"

import { useMemo,useState,useCallback,useEffect } from "react"
import { motion } from "framer-motion"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useOrganizations } from "@/lib/hooks/use-api"
import { useSalesPerformance,type DateRange } from "@/lib/hooks/use-sales-performance"
import { Card,CardContent } from "@/components/ui/card"
import { NotificationRail } from "@/components/notifications/notification-center"
import { formatPKR,cn } from "@/lib/utils"
import {
  TrendingUp,
  Package,RefreshCw,Filter,CheckCircle2,RotateCcw,XCircle,Activity,
  Calendar,Layers,Clock
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { SalesPerformanceBarChart } from "@/components/dashboard/charts"
import { BankingKPICard,type TrendDirection } from "@/components/dashboard/banking-kpi-card"
import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange,getPresetLabel,getPresetRange } from "@/components/dashboard/global-date-filter"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { OrganizationFilter } from "@/components/reports/organization-filter"
import { BranchFilter } from "@/components/reports/branch-filter"
import { DrillDownSheet,type DrillDownType } from "@/components/dashboard/drill-down-sheet"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"

import { useAppContext } from "@/components/context/app-context"
import { startOfDay,endOfDay } from "date-fns"

export function SuperAdminDashboard() {
  const { organizationId, branchId, isInitialized } = useAppContext()

  // Super Admin always defaults to 'All Time'
  const defaultPreset = "all" as const
  
  const [dateRange, setDateRange] = useState<DateRange | null>(getPresetRange(defaultPreset))
  const [activePreset, setActivePreset] = useState<FilterPreset>(defaultPreset)
  const [compare, setCompare] = useState(false)
  const [compareRange, setCompareRange] = useState<DateRange | null>(null)
  const [months, setMonths] = useState<number[]>([])
  const [years, setYears] = useState<number[]>([])
  const [compareMonths, setCompareMonths] = useState<number[]>([])
  const [compareYears, setCompareYears] = useState<number[]>([])
  const [selectedBranchIds, setSelectedBranchIds] = useState<string[]>([])

  const [drillDownType, setDrillDownType] = useState<DrillDownType | null>(null)
  const [isDrillDownOpen, setIsDrillDownOpen] = useState(false)
  const allTimeEndDate = useMemo(() => new Date().toISOString(), [])

  // Fetch all-time data to extract available years from the database
  // (deferred until the org/branch context has hydrated)
  const { data: allTimePerf } = useSWR(
    isInitialized
      ? `/api/v1/analytics/sales-performance?startDate=2015-01-01T00:00:00.000Z&endDate=${allTimeEndDate}&granularity=yearly&status=all`
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
  type ChartQuickFilter = "today" | "7d" | null
  
  const [chartQuickFilter, setChartQuickFilter] = useState<ChartQuickFilter>(null)
  const [chartMonths, setChartMonths] = useState<number[]>([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  const [chartYears, setChartYears] = useState<number[]>([])
  const [chartSelectedOrgIds, setChartSelectedOrgIds] = useState<string[]>([])
  const [chartSelectedBranchIds, setChartSelectedBranchIds] = useState<string[]>([])

  const isInitialLoad = useMemo(() => {
    return { months: true, years: true, orgs: true }
  }, [])

  // Quick filter fallback to global dateRange
  const chartDateRange = useMemo(() => {
    if (chartQuickFilter === "today") return getPresetRange("today")
    if (chartQuickFilter === "7d") {
      const end = endOfDay(new Date())
      const start = startOfDay(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000))
      return { startDate: start, endDate: end }
    }
    // If local months/years selected, bypass dates
    if (chartMonths.length > 0 || chartYears.length > 0) return null
    // Fallback to global dateRange
    return dateRange
  }, [chartQuickFilter, chartMonths, chartYears, dateRange])

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

  // ── Sync Global Filters to Local Chart Filters ──
  useEffect(() => {
    if (activePreset === "today") {
      setChartQuickFilter("today")
      setChartMonths([])
      setChartYears([])
    } else if (activePreset === "7d") {
      setChartQuickFilter("7d")
      setChartMonths([])
      setChartYears([])
    } else if (activePreset === "all") {
      setChartQuickFilter(null)
      setChartMonths([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      setChartYears(chartYearsAvailable)
    } else {
      setChartQuickFilter(null)
      setChartMonths(months)
      setChartYears(years)
    }
  }, [activePreset, months, years, chartYearsAvailable])

  useEffect(() => {
    if (organizationId) setChartSelectedOrgIds([String(organizationId)])
    else setChartSelectedOrgIds([])
  }, [organizationId])

  useEffect(() => {
    setChartSelectedBranchIds(selectedBranchIds || [])
  }, [selectedBranchIds])

  const handleKPIOpen = (type: DrillDownType) => {
    setDrillDownType(type)
    setIsDrillDownOpen(true)
  }

  const { data: orgsData } = useOrganizations()
  const orgs = orgsData?.items || []

  // Initialize chartYears with all available years on first load
  useEffect(() => {
    if (isInitialLoad.years && chartYearsAvailable.length > 0) {
      setChartYears(chartYearsAvailable)
      isInitialLoad.years = false
    }
  }, [chartYearsAvailable, isInitialLoad])

  // Initialize chartSelectedOrgIds with all organizations on first load
  useEffect(() => {
    const orgIds = orgs.map(o => String(o.id))
    if (isInitialLoad.orgs && orgIds.length > 0) {
      setChartSelectedOrgIds(orgIds)
      isInitialLoad.orgs = false
    }
  }, [orgs, isInitialLoad])

  const { data: perfData, isLoading: isLoadingPerf } = useSalesPerformance({
    organizationId,
    branchId,
    branchIds: selectedBranchIds.length > 0 ? selectedBranchIds : undefined,
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
    request: { enabled: isInitialized, keepPreviousData: true },
  })

  const hasChartFilters = chartMonths.length > 0 || chartYears.length > 0
  const chartComponentDateRange = (() => {
    if (chartQuickFilter === "today") {
      return getPresetRange("today")
    }
    return (hasChartFilters ? null : chartDateRange)
  })()

  const isBroadRange = !chartQuickFilter && ["all", "yearly", "monthly", "custom"].includes(activePreset)

  const chartGranularity = (() => {
    if ((chartQuickFilter === "today" || (activePreset === "today" && !hasChartFilters))) {
      return "daily" as const
    }
    if ((chartYears.length > 1 || (chartYears.length === 0 && years.length > 1 && !chartQuickFilter && chartMonths.length === 0))) {
      return "yearly" as const
    }
    if ((chartMonths.length > 0 || chartYears.length === 1 || (!chartQuickFilter && (months.length > 0 || years.length === 1)) || isBroadRange)) {
      return "monthly" as const
    }
    return "daily" as const
  })()

  const { data: chartPerfData, isLoading: isLoadingChart } = useSalesPerformance({
    branchIds: chartSelectedBranchIds.length > 0 ? chartSelectedBranchIds : undefined,
    dateRange: chartDateRange,
    status: "all",
    compare: false,
    compareRange: null,
    months: chartMonths,
    years: chartYears,
    compareMonths: [],
    compareYears: [],
    granularity: chartGranularity,
    organizationIds: chartSelectedOrgIds.length > 0 ? chartSelectedOrgIds : undefined,
    request: { enabled: isInitialized, keepPreviousData: true },
  })

  const normalizedChartData = useMemo(() => {
    const raw = chartPerfData?.seriesData ?? []

    // When no month/year arrays are active, the chart's safeData will scaffold
    // intervals from the dateRange and match by label — return raw so labels align.
    if (!hasChartFilters) {
      return raw
    }

    const activeYears = chartYears.length > 0 ? chartYears : years
    const activeMonths = chartMonths.length > 0 ? chartMonths : months

    if (activeYears.length > 1) {
      return [...activeYears].sort((a, b) => a - b).map(y => {
        const match = raw.find((r: any) => r.label === String(y) || r.label?.startsWith(String(y)))
        return {
          label: String(y),
          sales: match?.sales ?? 0,
          orders: match?.orders ?? 0,
        }
      })
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    const monthsToShow = activeMonths.length > 0 && activeMonths.length < 12
      ? [...activeMonths].sort((a, b) => a - b)
      : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

    return monthsToShow.map(m => {
      const monthPrefix = monthNames[m - 1]
      const match = raw.find((r: any) => r.label?.startsWith(monthPrefix))
      return {
        label: monthPrefix,
        sales: match?.sales ?? 0,
        orders: match?.orders ?? 0,
      }
    })
  }, [chartPerfData, chartMonths, chartYears, months, years, hasChartFilters])



  const handleDateChange = useCallback(({ range, preset, compare: compareMode, compareRange: compRange, months: m, years: y, compareMonths: cm, compareYears: cy }: GlobalDateFilterChange) => {
    setDateRange(range)
    setActivePreset(preset)
    if (compareMode !== undefined) setCompare(compareMode)
    if (compRange !== undefined) setCompareRange(compRange)
    setMonths(m || [])
    setYears(y || [])
    setCompareMonths(cm || [])
    setCompareYears(cy || [])
    setSelectedBranchIds([])
  }, [])

  const resetDashboardFilters = useCallback(() => {
    handleDateChange({ range: getPresetRange("all"), preset: "all", compare: false, compareRange: null, months: [], years: [], compareMonths: [], compareYears: [] })
  }, [handleDateChange])

  const totalRevenue = perfData?.totalNetSales ?? perfData?.totalSales ?? 0
  const totalOrders = perfData?.totalOrders ?? 0
  const pendingCount = perfData?.statusCounts?.pendingCount ?? 0
  const fulfilledCount = perfData?.statusCounts?.fulfilledCount ?? 0

  const refundedCount = perfData?.statusCounts?.refundedCount ?? 0
  const rejectedCount = perfData?.statusCounts?.rejectedCount ?? 0
  const approvedCount = perfData?.statusCounts?.approvedCount ?? 0
  const deliveredCount = perfData?.statusCounts?.deliveredCount ?? 0
  const notDeliveredCount = perfData?.statusCounts?.notDeliveredCount ?? 0

  // Helper for building trend data
  const buildTrend = useCallback((current: number, prev: number | undefined, formatFn?: (v: number) => string) => {
    if (!compare || prev === undefined || prev === null) return undefined
    const diff = current - prev
    const percentage = (() => {
      if (prev > 0) {
        return (diff / prev) * 100
      }
      return (current > 0 ? 100 : 0)
    })()
    const fmt = formatFn || ((v: number) => v.toLocaleString())
    const type: TrendDirection = diff >= 0 ? "up" : "down"
    return {
      type,
      value: `${Math.abs(percentage).toFixed(1)}%`,
      label: `${fmt(current)} vs ${fmt(prev)}`
    }
  }, [compare])

  // Trend Calculations for all KPI cards
  const revenueTrend = useMemo(() => buildTrend(
    totalRevenue, perfData?.comparison?.totalNetSales ?? perfData?.comparison?.totalSales,
    (v) => formatPKR(v, { maximumFractionDigits: 0 })
  ), [buildTrend, totalRevenue, perfData?.comparison])

  const ordersTrend = useMemo(() => buildTrend(
    totalOrders, perfData?.comparison?.totalOrders
  ), [buildTrend, totalOrders, perfData?.comparison])

  const pendingTrend = useMemo(() => buildTrend(
    pendingCount, perfData?.comparison?.pendingCount
  ), [buildTrend, pendingCount, perfData?.comparison])

  const fulfilledTrend = useMemo(() => buildTrend(
    fulfilledCount, perfData?.comparison?.fulfilledCount
  ), [buildTrend, fulfilledCount, perfData?.comparison])

  const refundedTrend = useMemo(() => buildTrend(
    refundedCount, perfData?.comparison?.refundedCount
  ), [buildTrend, refundedCount, perfData?.comparison])

  const rejectedTrend = useMemo(() => buildTrend(
    rejectedCount, perfData?.comparison?.rejectedCount
  ), [buildTrend, rejectedCount, perfData?.comparison])

  const approvedTrend = useMemo(() => buildTrend(
    approvedCount, perfData?.comparison?.approvedCount
  ), [buildTrend, approvedCount, perfData?.comparison])

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
          <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">Key Metrics</h2>
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
          {organizationId && (
            <>
              <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
              <MultiBranchFilter organizationId={organizationId} selectedBranchIds={selectedBranchIds} onChange={setSelectedBranchIds} />
            </>
          )}
        </div>
      </div>

      {/* ━━━ KPI Cards ━━━ */}
      <div className="relative z-10 grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <BankingKPICard
          icon={TrendingUp} title="Revenue"
          value={formatPKR(totalRevenue, { maximumFractionDigits: 0 })}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-emerald-500 to-teal-600" iconBg="text-emerald-600 bg-emerald-600" delay={0}
          onClick={() => handleKPIOpen("REVENUE")}
          trend={revenueTrend?.type}
          trendValue={revenueTrend?.value}
          comparisonValue={revenueTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={Package} title="Orders"
          value={totalOrders.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-blue-500 to-indigo-600" iconBg="text-blue-600 bg-blue-600" delay={50}
          onClick={() => handleKPIOpen("ORDERS")}
          trend={ordersTrend?.type}
          trendValue={ordersTrend?.value}
          comparisonValue={ordersTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={Activity} title="Pending Approval"
          value={pendingCount.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-amber-400 to-orange-500" iconBg="text-amber-600 bg-amber-600" delay={75}
          onClick={() => handleKPIOpen("PENDING" as any)} // Cast if PENDING is not in DrillDownType yet
          trend={pendingTrend?.type}
          trendValue={pendingTrend?.value}
          comparisonValue={pendingTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={CheckCircle2} title="Active"
          value={approvedCount.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-blue-400 to-indigo-500" iconBg="text-blue-600 bg-blue-600" delay={100}
          onClick={() => handleKPIOpen("APPROVED")}
          trend={approvedTrend?.type}
          trendValue={approvedTrend?.value}
          comparisonValue={approvedTrend?.label}
          comparisonLabel="VS LAST"
          details={[
            { label: "Delivered", value: deliveredCount.toLocaleString() },
            { label: "Not Delivered", value: notDeliveredCount.toLocaleString() },
          ]}
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={CheckCircle2} title="Fulfilled"
          value={fulfilledCount.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-teal-500 to-cyan-600" iconBg="text-teal-600 bg-teal-600" delay={125}
          onClick={() => handleKPIOpen("FULFILLED")}
          trend={fulfilledTrend?.type}
          trendValue={fulfilledTrend?.value}
          comparisonValue={fulfilledTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={RotateCcw} title="Refunded"
          value={refundedCount.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-red-500 to-rose-600" iconBg="text-red-600 bg-red-600" delay={150}
          onClick={() => handleKPIOpen("REFUNDED")}
          trend={refundedTrend?.type}
          trendValue={refundedTrend?.value}
          comparisonValue={refundedTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
        <BankingKPICard
          icon={XCircle} title="Rejected"
          value={rejectedCount.toLocaleString()}
          subtitle={getPresetLabel(activePreset, dateRange)}
          gradient="from-slate-500 to-slate-700" iconBg="text-slate-600 bg-slate-600" delay={175}
          onClick={() => handleKPIOpen("REJECTED")}
          trend={rejectedTrend?.type}
          trendValue={rejectedTrend?.value}
          comparisonValue={rejectedTrend?.label}
          comparisonLabel="VS LAST"
          isLoading={!perfData}
        />
      </div>

      {/* ━━━ Sales Performance Chart ━━━ */}
      <div className="space-y-6">
        <div className="min-w-0">
          <Card className="border border-slate-200/80 dark:border-slate-800/60 shadow-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl overflow-hidden glass-card">
            <CardContent className="p-5">
              <div className="flex flex-wrap items-center gap-3 mb-6 p-3 bg-slate-50/50 dark:bg-slate-800/20 rounded-xl border border-slate-100 dark:border-slate-800/50">
                <div className="flex items-center gap-2 pr-3 border-r border-slate-200 dark:border-slate-800">
                  <Filter className="h-3.5 w-3.5 text-slate-400" />
                  <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Filters</span>
                </div>

                {/* Quick date buttons */}
                <div className="flex items-center gap-1">
                  <Button
                    variant={chartQuickFilter === "today" ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleQuickFilter("today")}
                    className={cn(
                      "h-8 px-3 rounded-lg text-[10px] font-semibold uppercase tracking-wider",
                      chartQuickFilter === "today"
                        ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                        : "border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-700"
                    )}
                  >
                    <Clock className="h-3 w-3 mr-1" /> Today
                  </Button>
                  <Button
                    variant={chartQuickFilter === "7d" ? "default" : "outline"}
                    size="sm"
                    onClick={() => handleQuickFilter("7d")}
                    className={cn(
                      "h-8 px-3 rounded-lg text-[10px] font-semibold uppercase tracking-wider",
                      chartQuickFilter === "7d"
                        ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                        : "border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-700"
                    )}
                  >
                    7D
                  </Button>
                </div>

                <div className="h-6 w-[1px] bg-slate-200 dark:bg-slate-700 mx-0.5" />
                
                <MonthFilter selected={chartMonths} onChange={handleChartMonths} />
                <YearFilter selected={chartYears} onChange={handleChartYears} availableYears={chartYearsAvailable} />

                <div className="h-6 w-[1px] bg-slate-200 dark:bg-slate-700 mx-0.5" />

                <OrganizationFilter
                  selectedIds={chartSelectedOrgIds}
                  onChange={(ids) => {
                    setChartSelectedOrgIds(ids)
                    setChartSelectedBranchIds([])
                  }}
                  placeholder="Organizations"
                />

                {chartSelectedOrgIds.length > 0 && (
                  <BranchFilter
                    organizationIds={chartSelectedOrgIds}
                    selectedIds={chartSelectedBranchIds}
                    onChange={setChartSelectedBranchIds}
                    placeholder="Branches"
                  />
                )}

                {isLoadingChart && (
                  <div className="ml-auto flex items-center gap-1.5 text-xs text-slate-400 font-medium">
                    <RefreshCw className="h-3 w-3 animate-spin text-emerald-500" /> 
                    Syncing Data
                  </div>
                )}
              </div>

              {!chartPerfData ? (
                <div className="h-[400px] flex items-center justify-center rounded-[2.5rem] border border-dashed border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50">
                  <div className="flex flex-col items-center gap-3">
                    <div className="animate-spin rounded-full h-10 w-10 border-2 border-slate-200 dark:border-slate-800 border-t-emerald-500" />
                    <p className="text-sm font-medium text-slate-400 animate-pulse">Loading performance metrics...</p>
                  </div>
                </div>
              ) : (
                <SalesPerformanceBarChart
                  seriesData={normalizedChartData}
                  totalSales={chartPerfData?.totalNetSales ?? chartPerfData?.totalSales ?? 0}
                  avgSales={chartPerfData?.avgSales ?? 0}
                  totalOrders={chartPerfData?.totalOrders ?? 0}
                  peakPeriod={chartPerfData?.peakPeriod ?? null}
                  granularity={chartGranularity}
                  label="Sales"
                  dateRange={chartComponentDateRange}
                  comparisonSeries={chartPerfData?.comparison?.seriesData}
                  organizationSales={chartPerfData?.organizationSales}
                  branchSales={chartPerfData?.branchSales}
                  showOrgView={!organizationId}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>


      {/* ━━━ Drill Down Sheet ━━━ */}
      <DrillDownSheet
        isOpen={isDrillDownOpen}
        onOpenChange={setIsDrillDownOpen}
        type={drillDownType}
        organizationId={organizationId}
        branchId={branchId}
        branchIds={selectedBranchIds}
        defaultDateRange={dateRange}
        activePreset={activePreset}
        compare={compare}
        compareRange={compareRange}
        months={months}
        years={years}
        compareMonths={compareMonths}
        compareYears={compareYears}
      />
    </motion.main>
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
      onChange={(ids) => onChange(ids.toSorted((a, b) => b - a))}
      icon={<Layers className="h-3.5 w-3.5 mr-2 text-indigo-500" />}
      placeholder="Years"
      showSearch={false}
    />
  )
}
