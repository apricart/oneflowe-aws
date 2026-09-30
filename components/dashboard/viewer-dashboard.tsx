"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { motion } from "framer-motion"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { useSalesPerformance } from "@/lib/hooks/use-sales-performance"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { formatPKR, cn } from "@/lib/utils"
import {
  Activity, Calendar, CheckCircle2, Clock, Eye, Layers, Package,
  RefreshCw, TrendingUp, Truck,
} from "lucide-react"
import { SalesPerformanceBarChart } from "@/components/dashboard/charts"
import { BankingKPICard } from "@/components/dashboard/banking-kpi-card"
import { MultiSelectFilter } from "@/components/reports/multi-select-filter"
import { MultiBranchFilter } from "@/components/dashboard/multi-branch-filter"
import { DrillDownSheet, type DrillDownType } from "@/components/dashboard/drill-down-sheet"
import { useAppContext } from "@/components/context/app-context"
import { VIEWER_STATUS_BUCKETS, type ViewerStatusBucketKey } from "@/lib/order-delivery-status"
import {
  ALL_MONTHS,
  DEFAULT_REFRESH_INTERVAL_MS,
  REFRESH_CHOICES,
  SHORT_MONTH_LABELS,
  availableCostYears,
  costChartGranularity,
  describeCostPeriod,
  describeLastUpdated,
  normalizeMonths,
} from "@/lib/viewer-dashboard"
import { viewerMayFilterBranches } from "@/lib/viewer-access"

/**
 * The read-only dashboard, and the only page the Viewer role can reach.
 *
 * It is its own component rather than a mode of the Head Office one on purpose:
 * the three additions it carries — month-wise cost filtering, an automatic
 * refresh the reader controls, and the six-bucket order-status panel — belong
 * to this role alone, and the other three dashboards must not move.
 *
 * Nothing here mutates. There is no action, no form and no link out of the
 * page; the KPI cards open a read-only drill-down and that is the whole
 * interaction surface. That is presentation, though, not the control — every
 * endpoint behind this page refuses the role for anything but these reads
 * (`lib/viewer-access.ts`).
 */

/** Icon per bucket, kept beside the layout rather than in the pure module. */
const BUCKET_ICONS: Record<ViewerStatusBucketKey, any> = {
  PENDING: Activity,
  APPROVED: CheckCircle2,
  DELIVERED: Truck,
  DELIVERED_UNACKNOWLEDGED: Clock,
  UNFULFILLED: Package,
  FULFILLED: CheckCircle2,
}

const BUCKET_GRADIENTS: Record<ViewerStatusBucketKey, { gradient: string; iconBg: string }> = {
  PENDING: { gradient: "from-amber-400 to-orange-500", iconBg: "text-amber-600 bg-amber-600" },
  APPROVED: { gradient: "from-blue-400 to-indigo-500", iconBg: "text-blue-600 bg-blue-600" },
  DELIVERED: { gradient: "from-emerald-500 to-teal-600", iconBg: "text-emerald-600 bg-emerald-600" },
  DELIVERED_UNACKNOWLEDGED: { gradient: "from-amber-500 to-rose-500", iconBg: "text-amber-600 bg-amber-600" },
  UNFULFILLED: { gradient: "from-sky-400 to-blue-500", iconBg: "text-sky-600 bg-sky-600" },
  FULFILLED: { gradient: "from-teal-500 to-cyan-600", iconBg: "text-teal-600 bg-teal-600" },
}

export function ViewerDashboard() {
  const {
    organizationId,
    branchId: contextBranchId,
    branchIds: contextBranchIds,
    setBranchIds: setContextBranchIds,
    userBranchId,
    isInitialized,
  } = useAppContext()

  // A Viewer pinned to a branch never chooses one. The server applies the same
  // rule, so this only decides whether the control is worth drawing.
  const mayFilterBranches = viewerMayFilterBranches(userBranchId)

  // ── Month-wise cost filter ──
  const [year, setYear] = useState<number>(() => new Date().getFullYear())
  const [months, setMonths] = useState<number[]>([])

  const { data: earliest } = useSWR<{ earliestDate?: string }>(
    "/api/v1/analytics/earliest-record",
    fetcher,
  )
  const years = useMemo(() => availableCostYears(earliest?.earliestDate), [earliest])

  // A year that drops out of the list — the tenant's first order moved, or the
  // clock rolled over — is replaced rather than left selected and empty.
  useEffect(() => {
    if (years.length > 0 && !years.includes(year)) setYear(years[0])
  }, [years, year])

  const period = useMemo(
    () => ({ year, months: normalizeMonths(months) }),
    [year, months],
  )
  const periodLabel = describeCostPeriod(period)

  // ── Automatic refresh ──
  const [refreshIntervalMs, setRefreshIntervalMs] = useState<number>(DEFAULT_REFRESH_INTERVAL_MS)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const [drillDownType, setDrillDownType] = useState<DrillDownType | null>(null)
  const [isDrillDownOpen, setIsDrillDownOpen] = useState(false)

  const openDrillDown = useCallback((type: DrillDownType) => {
    setDrillDownType(type)
    setIsDrillDownOpen(true)
  }, [])

  const { data, isLoading, isValidating, mutate } = useSalesPerformance({
    organizationId,
    branchId: contextBranchId,
    branchIds: contextBranchIds.length > 0 ? contextBranchIds : undefined,
    dateRange: null,
    status: "all",
    // The whole selected year when no month is picked: the endpoints read an
    // empty `months` list as no month filter at all.
    months: period.months.length > 0 ? period.months : [...ALL_MONTHS],
    years: [period.year],
    granularity: costChartGranularity(period),
    includeStatusCounts: true,
    request: {
      enabled: isInitialized && Boolean(organizationId),
      keepPreviousData: true,
      refreshInterval: refreshIntervalMs,
    },
  })

  useEffect(() => {
    if (data) setLastUpdated(new Date())
  }, [data])

  const counts = data?.statusCounts
  const bucketCount = (field: string) => Number((counts as any)?.[field] ?? 0)

  const totalCost = data?.totalNetSales ?? data?.totalSales ?? 0
  const totalOrders = data?.totalOrders ?? 0
  const pendingAmount = (counts?.pendingAmountCents ?? 0) / 100
  const approvedAmount = (counts?.approvedAmountCents ?? 0) / 100
  const fulfilledAmount = (counts?.valueFulfilledCents ?? 0) / 100

  /** The money figure printed on a status card, where the bucket has one. */
  const bucketAmount = (key: ViewerStatusBucketKey): string | undefined => {
    if (key === "PENDING") return formatPKR(pendingAmount, { maximumFractionDigits: 0 })
    if (key === "APPROVED") return formatPKR(approvedAmount, { maximumFractionDigits: 0 })
    if (key === "FULFILLED") return formatPKR(fulfilledAmount, { maximumFractionDigits: 0 })
    return undefined
  }

  const monthItems = ALL_MONTHS.map((month) => ({
    id: month,
    label: SHORT_MONTH_LABELS[month - 1],
  }))

  const chartSeries = useMemo(() => data?.seriesData ?? [], [data])

  // The busiest bucket in the selected period, which the chart prints beside
  // the totals. Null for an empty period rather than a zero-valued label.
  const peakPeriod = useMemo(() => {
    if (chartSeries.length === 0) return null
    return chartSeries.reduce(
      (best, point) => (point.sales > best.sales ? point : best),
      chartSeries[0],
    )
  }, [chartSeries])

  return (
    <motion.main
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 lg:p-6 space-y-6 max-w-[2000px] mx-auto overflow-x-hidden"
    >
      {/* ━━━ Header ━━━ */}
      <div className="relative z-30 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3 px-2">
          <Layers className="w-5 h-5 text-indigo-500" />
          <h1 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">
            Key Metrics
          </h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
            <Eye className="h-3 w-3" aria-hidden="true" />
            View only
          </span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* ── Month-wise cost filter ── */}
          <div className="flex items-center gap-2">
            <Calendar className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
            <Select value={String(year)} onValueChange={(value) => setYear(Number(value))}>
              <SelectTrigger className="h-10 w-[110px]" aria-label="Year">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((option) => (
                  <SelectItem key={option} value={String(option)}>{option}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <MultiSelectFilter
              title="Months"
              placeholder="All months"
              items={monthItems}
              selectedIds={period.months}
              onChange={(ids) => setMonths(normalizeMonths(ids))}
              showSearch={false}
            />
          </div>

          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

          {/* ── Automatic refresh ── */}
          <div className="flex items-center gap-2">
            <Select
              value={String(refreshIntervalMs)}
              onValueChange={(value) => setRefreshIntervalMs(Number(value))}
            >
              <SelectTrigger className="h-10 w-[150px]" aria-label="Automatic refresh">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_CHOICES.map((choice) => (
                  <SelectItem key={choice.intervalMs} value={String(choice.intervalMs)}>
                    {choice.intervalMs === 0 ? "Auto-refresh off" : `Every ${choice.label}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => { void mutate() }}
              className="h-10 w-10 rounded-xl text-slate-400 hover:bg-indigo-50/60 hover:text-indigo-600 dark:hover:bg-slate-800 dark:hover:text-indigo-400"
              aria-label="Refresh now"
              title="Refresh now"
            >
              <RefreshCw className={cn("h-4 w-4", isValidating && "animate-spin")} />
            </Button>
            <output
              aria-live="polite"
              className="text-[11px] font-medium text-slate-400 tabular-nums min-w-[96px]"
            >
              {describeLastUpdated(lastUpdated)}
            </output>
          </div>

          {mayFilterBranches && organizationId && (
            <>
              <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />
              <MultiBranchFilter
                organizationId={organizationId}
                selectedBranchIds={contextBranchIds}
                onChange={setContextBranchIds}
              />
            </>
          )}
        </div>
      </div>

      {/* ━━━ Cost ━━━ */}
      <div className="relative z-10 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <BankingKPICard
          icon={TrendingUp}
          title="Cost"
          value={formatPKR(totalCost, { maximumFractionDigits: 0 })}
          subtitle={periodLabel}
          gradient="from-emerald-500 to-teal-600"
          iconBg="text-emerald-600 bg-emerald-600"
          delay={0}
          onClick={() => openDrillDown("REVENUE")}
          isLoading={isLoading}
        />
        <BankingKPICard
          icon={Package}
          title="Orders"
          value={totalOrders.toLocaleString()}
          subtitle={periodLabel}
          gradient="from-blue-500 to-indigo-600"
          iconBg="text-blue-600 bg-blue-600"
          delay={50}
          onClick={() => openDrillDown("ORDERS")}
          isLoading={isLoading}
        />
      </div>

      {/* ━━━ Order status ━━━ */}
      <section aria-label="Order status" className="relative z-10 space-y-3">
        <div className="flex items-center gap-2 px-2">
          <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">
            Order Status
          </h2>
          <span className="text-[11px] text-slate-400">
            Active splits into delivered-pending-acknowledgment and unfulfilled
          </span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {VIEWER_STATUS_BUCKETS.map((bucket, index) => (
            <BankingKPICard
              key={bucket.key}
              icon={BUCKET_ICONS[bucket.key]}
              title={bucket.label}
              value={bucketCount(bucket.countField).toLocaleString()}
              amount={bucketAmount(bucket.key)}
              subtitle={bucket.description}
              gradient={BUCKET_GRADIENTS[bucket.key].gradient}
              iconBg={BUCKET_GRADIENTS[bucket.key].iconBg}
              delay={index * 25}
              onClick={() => openDrillDown(bucket.drillDownType as DrillDownType)}
              isLoading={isLoading}
            />
          ))}
        </div>
      </section>

      {/* ━━━ Cost over the selected period ━━━ */}
      <Card className="border border-slate-200/80 dark:border-slate-800/60 shadow-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl overflow-hidden glass-card">
        <CardContent className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">
              Cost — {periodLabel}
            </h2>
          </div>
          <SalesPerformanceBarChart
            seriesData={chartSeries}
            totalSales={totalCost}
            avgSales={chartSeries.length > 0 ? totalCost / chartSeries.length : 0}
            totalOrders={totalOrders}
            peakPeriod={peakPeriod}
            label="Cost"
            granularity={costChartGranularity(period)}
            // The period is carried by months/years, not by a date range, so
            // the chart must not scaffold intervals from one.
            dateRange={null}
          />
        </CardContent>
      </Card>

      <DrillDownSheet
        isOpen={isDrillDownOpen}
        onOpenChange={setIsDrillDownOpen}
        type={drillDownType}
        organizationId={organizationId}
        branchId={contextBranchId}
        branchIds={contextBranchIds}
        activePreset="custom"
        months={period.months.length > 0 ? period.months : [...ALL_MONTHS]}
        years={[period.year]}
      />
    </motion.main>
  )
}
