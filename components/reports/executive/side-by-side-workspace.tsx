"use client"

import * as React from "react"
import { Package, Users, X } from "lucide-react"

import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  EXECUTIVE_METRICS,
  MEASURE_METRIC,
  panelsForFocus,
  type ChartTypeId,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MeasureId,
  type SideBySidePanel,
} from "@/lib/executive-analytics"
import { ChartCard } from "./chart-kit"
import {
  ComparisonChart,
  SeriesTable,
  type ComparisonRow,
  type DrillTarget,
  type EntitySeries,
} from "./comparison-charts"
import { DrillDownPanel } from "./drill-down-panel"
import { EntityPicker, type EntityOption } from "./entity-picker"
import { toQuery, type ExecutiveFilterState } from "./executive-filters"
import { MeasureToggle } from "./measure-toggle"

/**
 * Level 3 — one product, every angle, on one screen.
 *
 * The Explore workbench answers one question at a time, which is the right
 * shape for an open-ended investigation and the wrong shape for the question
 * people actually arrive with: *who* used this, at *which* branch, and *when*.
 * Answering that in the workbench means building the same comparison three
 * times and remembering the first two.
 *
 * So this screen fixes the subject — a product, or a few — and varies the
 * dimension instead. Every panel is the *existing* comparison endpoint with a
 * different `dimension`, so there is no new aggregation path and no new
 * authorization surface behind any of it: the same registry decides what may be
 * asked, and the same scope decides which rows may answer.
 *
 * Two things are shared across every panel, deliberately:
 *
 *  * **the measure** — flipping Amount ⇄ Quantity re-asks all five questions at
 *    once, which is the comparison people are really making when they flip it;
 *  * **the detail table** — whichever panel is clicked, the rows open in the
 *    same place, under the same period and the same filters.
 */

type ComparisonResponse = {
  rows: ComparisonRow[]
  series: EntitySeries[]
  periods: string[]
  format: string
  label: string
  formula: string
  mode: "rank" | "series"
  chart: ChartTypeId
  concentrationEligible: boolean
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  blocked?: { reason: string; message: string }
  error?: string
}

/** Rank panels show more entities than a trend can carry legible lines for. */
const RANK_PANEL_ROWS = 12
const SERIES_PANEL_ROWS = 6

export function SideBySideWorkspace({ filters }: Readonly<{ filters: ExecutiveFilterState }>) {
  const [measure, setMeasure] = React.useState<MeasureId>("amount")
  const [focusProducts, setFocusProducts] = React.useState<string[]>([])
  const [compareUsers, setCompareUsers] = React.useState<string[]>([])
  const [drillTarget, setDrillTarget] = React.useState<DrillTarget | null>(null)

  const metric: ExecutiveMetricId = MEASURE_METRIC[measure]

  /**
   * The filter set every panel shares.
   *
   * Resolved once so the five panels and the detail table cannot disagree about
   * what is in scope — a table showing rows its own chart did not count is the
   * single worst failure a drill-down can have.
   */
  const scopedFilters = React.useMemo<ExecutiveFilterState>(
    () => ({ ...filters, productIds: focusProducts, userIds: compareUsers }),
    [filters, focusProducts, compareUsers],
  )

  // Both pickers list only what is inside the caller's fence, and neither
  // narrows itself — a list that hid everything already picked could never be
  // changed.
  const { data: productData, isLoading: productsLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, userIds: compareUsers },
      { dimension: "product" },
    )}`,
  )
  const { data: userData, isLoading: usersLoading } = useAPI<{ options: EntityOption[] }>(
    `/api/v1/analytics/executive/options?${toQuery(
      { ...filters, productIds: focusProducts },
      { dimension: "user" },
    )}`,
  )

  const productOptions = productData?.options ?? []
  const userOptions = userData?.options ?? []
  const panels = panelsForFocus(focusProducts.length)

  const focusLabels = focusProducts.map(
    (key) => productOptions.find((option) => option.key === key)?.label ?? "selected product",
  )

  const subject = (() => {
    if (focusLabels.length === 0) return "All products"
    if (focusLabels.length <= 2) return focusLabels.join(" and ")
    return `${focusLabels.length} products`
  })()

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
        <Control label="Product">
          <EntityPicker
            noun="products"
            options={productOptions}
            selected={focusProducts}
            onChange={setFocusProducts}
            loading={productsLoading}
            emptyLabel="All products"
            className="w-[260px]"
            icon={<Package className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          />
        </Control>

        <Control label="Requesters to compare">
          <EntityPicker
            noun="people"
            options={userOptions}
            selected={compareUsers}
            onChange={setCompareUsers}
            loading={usersLoading}
            emptyLabel="All requesters (top ranked)"
            className="w-[260px]"
            icon={<Users className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
          />
        </Control>

        <Control label="Measured by">
          <MeasureToggle value={measure} onChange={setMeasure} />
        </Control>

        {focusProducts.length > 0 || compareUsers.length > 0 ? (
          <button
            type="button"
            onClick={() => { setFocusProducts([]); setCompareUsers([]); setDrillTarget(null) }}
            className="flex items-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Clear selection
          </button>
        ) : null}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        <strong className="text-slate-700 dark:text-slate-200">{subject}</strong>, measured by{" "}
        {EXECUTIVE_METRICS[metric].label.toLowerCase()}, compared across requesters, branches and months at once. Select
        any bar, column or point to open the order lines behind it.
        {focusProducts.length === 1 ? " Day-by-day consumption is shown below." : ""}
        {focusProducts.length > 1 ? " Choose a single product to see day-by-day consumption." : ""}
      </p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {panels.map((panel) => (
          <ComparePanel
            key={panel.id}
            panel={panel}
            filters={scopedFilters}
            metric={metric}
            compareUsers={compareUsers}
            className={panel.requiresSingleProduct ? "xl:col-span-2" : undefined}
            onDrillDown={setDrillTarget}
          />
        ))}
      </div>

      {drillTarget ? (
        <DrillDownPanel
          target={drillTarget}
          filters={scopedFilters}
          metric={metric}
          onClose={() => setDrillTarget(null)}
        />
      ) : null}
    </div>
  )
}

function Control({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </div>
  )
}

/**
 * One panel: one dimension, the shared subject, the shared measure.
 *
 * Each fetches independently rather than through a combined endpoint, so a
 * dimension that returns nothing — a period with no orders for one branch, say
 * — leaves the other four panels intact instead of emptying the screen.
 */
function ComparePanel({ panel, filters, metric, compareUsers, className, onDrillDown }: Readonly<{
  panel: SideBySidePanel
  filters: ExecutiveFilterState
  metric: ExecutiveMetricId
  compareUsers: string[]
  className?: string
  onDrillDown: (target: DrillTarget) => void
}>) {
  const isSeries = panel.chart === "line"
  const limit = isSeries ? SERIES_PANEL_ROWS : RANK_PANEL_ROWS

  // A requester panel honours the people picked to compare; every other
  // dimension ranks whatever is in scope.
  const keys = panel.dimension === "user" ? compareUsers.join(",") : ""

  const url = `/api/v1/analytics/executive/compare?${toQuery(filters, {
    dimension: panel.dimension,
    metric,
    chart: panel.chart,
    keys,
    limit: String(limit),
  })}`

  const { data, error, isLoading } = useAPI<ComparisonResponse>(url)

  const requestError = error ? "This comparison could not be loaded." : data?.error ?? null
  const rows = data?.rows ?? []
  const series = data?.series ?? []
  const isEmpty = data?.mode === "series" ? series.length === 0 : rows.length === 0

  return (
    <ChartCard
      title={panel.title}
      question={panel.question}
      formula={data?.formula ?? EXECUTIVE_METRICS[metric].formula}
      loading={isLoading}
      error={requestError}
      empty={data?.blocked?.message ?? (isEmpty ? "Nothing in the selected period under these filters." : null)}
      className={className}
      table={data?.mode === "series"
        ? (
          <SeriesTable
            series={series}
            periods={data?.periods ?? []}
            format={data?.format ?? "currency"}
            onSelectEntity={(key, index) => onDrillDown({
              dimension: panel.dimension,
              key,
              label: series[index]?.label ?? key,
            })}
          />
        )
        : undefined}
    >
      <ComparisonChart
        chart={data?.chart ?? panel.chart}
        rows={rows}
        series={series}
        periods={data?.periods ?? []}
        format={data?.format ?? "currency"}
        metricLabel={data?.label ?? EXECUTIVE_METRICS[metric].label}
        dimensionLabel={panelDimensionLabel(panel.dimension)}
        unit={data?.quantityUnit.selected ?? null}
        concentrationEligible={Boolean(data?.concentrationEligible)}
        colorful={panel.colorful}
        dimension={panel.dimension}
        onDrillDown={onDrillDown}
      />
      {data?.quantityUnit.selected ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Measured in <strong>{data.quantityUnit.selected}</strong> only. Other units in this period are excluded rather
          than added to it.
        </p>
      ) : null}
    </ChartCard>
  )
}

const PANEL_DIMENSION_LABEL: Record<ExecutiveDimensionId, string> = {
  branch: "Branch",
  group: "Group",
  organization: "Organization",
  user: "Requester",
  category: "Category",
  product: "Product",
  month: "Month",
  day: "Day",
}

function panelDimensionLabel(dimension: ExecutiveDimensionId): string {
  return PANEL_DIMENSION_LABEL[dimension]
}
