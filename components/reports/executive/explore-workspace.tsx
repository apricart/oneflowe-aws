"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Package, X } from "lucide-react"

import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  EXECUTIVE_METRICS,
  MEASURE_METRIC,
  isTimeAxisDimension,
  measureOfMetric,
  metricsUnderLineFocus,
  type ChartTypeId,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MeasureId,
} from "@/lib/executive-analytics"
import {
  AXIS_STYLE,
  ChartCard,
  DataTable,
  GRID_STYLE,
  Legend,
  SERIES,
  countShort,
  formatShortByKind,
  money,
} from "./chart-kit"
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
 * Level 2 — the Explore / Compare workbench.
 *
 * The question is built in four steps, left to right: what to compare, which
 * ones, measured how, drawn as what. Each step narrows the next, and every
 * option offered comes from the server:
 *
 *  * the dimension menu is the caller's role-filtered list, so Head Office is
 *    never shown the organization comparison;
 *  * the entity list is drawn from rows inside the caller's fence, so no other
 *    tenant's branch, product or person can be named here;
 *  * the chart menu comes back with each comparison, carrying a reason for any
 *    form that would misrepresent this particular measure.
 *
 * It is a curated workbench, not a report designer: there is no free-text
 * query, no arbitrary grouping, and every value sent is matched against a
 * registry on the server before a query is built.
 */

type DimensionMenuEntry = {
  id: ExecutiveDimensionId
  label: string
  entityNoun: string
  metrics: ExecutiveMetricId[]
  selectable: boolean
}

type ChartTypeOption = {
  id: ChartTypeId
  label: string
  purpose: string
  mode: "rank" | "series"
  disabledReason?: string
}

type ComparisonResponse = {
  dimension: ExecutiveDimensionId
  metric: ExecutiveMetricId
  chart: ChartTypeId
  mode: "rank" | "series"
  format: string
  label: string
  formula: string
  rows: ComparisonRow[]
  series: EntitySeries[]
  periods: string[]
  chartTypes: ChartTypeOption[]
  concentrationEligible: boolean
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  blocked?: { reason: string; message: string }
  error?: string
}

type PriceResponse = {
  rows: Array<{
    branchId: number
    branchName: string
    unit: string
    valueCents: number
    quantity: number
    orderCount: number
    avgUnitPriceCents: number
  }>
  comparable: boolean
  message: string | null
  error?: string
}

// ── Controls ───────────────────────────────────────────────────────────────

function Step({ index, label, children }: Readonly<{ index: number; label: string; children: React.ReactNode }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <span
          aria-hidden
          className="flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[9px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
        >
          {index}
        </span>
        {label}
      </span>
      {children}
    </div>
  )
}

function Segmented<T extends string>({ label, options, value, onChange }: Readonly<{
  label: string
  options: Array<{ id: T; label: string; title?: string; disabled?: boolean }>
  value: T
  onChange: (next: T) => void
}>) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-800/60"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
            option.disabled
              ? "cursor-not-allowed text-slate-300 dark:text-slate-600"
              : value === option.id
                ? "bg-white text-indigo-600 shadow-sm ring-1 ring-slate-200 dark:bg-slate-700 dark:text-indigo-300 dark:ring-slate-600"
                : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ── The workbench ──────────────────────────────────────────────────────────

export function ExploreWorkspace({ filters, priceProduct, onClearPriceProduct }: Readonly<{
  filters: ExecutiveFilterState
  priceProduct: { productId: number; unit: string; name?: string } | null
  onClearPriceProduct: () => void
}>) {
  const [dimension, setDimension] = React.useState<ExecutiveDimensionId>("branch")
  const [metric, setMetric] = React.useState<ExecutiveMetricId>("spend")
  const [chart, setChart] = React.useState<ChartTypeId>("bar")
  const [keys, setKeys] = React.useState<string[]>([])
  /**
   * "Show me these products, broken down by branch."
   *
   * The focus narrows *which order lines count*; the dimension decides how they
   * are grouped. Offered only when the comparison is not already about products
   * or categories, where the picker above is the same control and two of them
   * would contradict each other.
   */
  const [focusProducts, setFocusProducts] = React.useState<string[]>([])
  /**
   * The bar, slice or point whose rows are open below the chart.
   *
   * Held here rather than inside the chart card so it survives a measure flip
   * and a chart-form change: a reader who opens one branch's lines and then
   * switches Amount to Quantity is asking the same question a second way, and
   * having the table close under them would make the flip cost more than it
   * saves.
   */
  const [drillTarget, setDrillTarget] = React.useState<DrillTarget | null>(null)

  // The dimensions this caller may use. Role filtering happens on the server;
  // this only decides what the menu renders.
  const { data: menu } = useAPI<{ role: string; dimensions: DimensionMenuEntry[] }>(
    "/api/v1/analytics/executive/options",
  )
  const dimensions = menu?.dimensions ?? []
  const current = dimensions.find((entry) => entry.id === dimension)

  // Changing what is being compared invalidates which ones were picked.
  const previousDimension = React.useRef(dimension)
  React.useEffect(() => {
    if (previousDimension.current !== dimension) {
      previousDimension.current = dimension
      setKeys([])
      // The open rows belong to the old dimension's entity; keeping them would
      // show a branch's lines under a chart of products.
      setDrillTarget(null)
    }
  }, [dimension])

  const focusable = dimension !== "product" && dimension !== "category"
  const activeFocus = React.useMemo(
    () => (focusable ? focusProducts : []),
    [focusable, focusProducts],
  )
  // Resolved once: every request in this workbench sees the same focus.
  const scopedFilters = React.useMemo(
    () => ({ ...filters, productIds: activeFocus }),
    [filters, activeFocus],
  )

  // Average order value is withdrawn while a focus is on: it would be the
  // average of whole orders containing the product, not the product's own.
  const allMetrics = current?.metrics ?? ["spend" as ExecutiveMetricId]
  const availableMetrics = activeFocus.length > 0 ? metricsUnderLineFocus(allMetrics) : allMetrics
  const effectiveMetric = availableMetrics.includes(metric) ? metric : availableMetrics[0]

  const { data: entityData, isLoading: entitiesLoading } = useAPI<{ options: EntityOption[]; selectable: boolean }>(
    current?.selectable ? `/api/v1/analytics/executive/options?${toQuery(scopedFilters, { dimension })}` : null,
  )
  const entityOptions = entityData?.options ?? []

  // The product list for the focus picker never narrows itself, so it always
  // offers every product in scope rather than only the ones already focused.
  const { data: productData, isLoading: productsLoading } = useAPI<{ options: EntityOption[] }>(
    focusable ? `/api/v1/analytics/executive/options?${toQuery(filters, { dimension: "product" })}` : null,
  )
  const productOptions = productData?.options ?? []

  const comparisonUrl = `/api/v1/analytics/executive/compare?${toQuery(scopedFilters, {
    dimension,
    metric: effectiveMetric,
    chart,
    keys: keys.join(","),
    limit: "20",
  })}`
  const { data, error, isLoading } = useAPI<ComparisonResponse>(comparisonUrl)

  const chartTypes = React.useMemo(() => data?.chartTypes ?? [], [data])

  // If the server says the chosen form does not fit this measure, fall back to
  // the first that does rather than drawing something misleading.
  React.useEffect(() => {
    const chosen = chartTypes.find((entry) => entry.id === chart)
    if (!chosen?.disabledReason) return
    const fallback = chartTypes.find((entry) => !entry.disabledReason)
    if (fallback) setChart(fallback.id)
  }, [chartTypes, chart])

  const priceUrl = priceProduct
    ? `/api/v1/analytics/executive/compare?${toQuery(filters, {
      dimension: "branch",
      metric: "avgUnitPrice",
      priceProductId: String(priceProduct.productId),
      unit: priceProduct.unit || "",
    })}`
    : null
  const { data: priceData, isLoading: priceLoading } = useAPI<PriceResponse>(priceUrl)

  const requestError = error
    ? "This comparison could not be loaded. Check the filters and try again."
    : (data?.error ?? null)

  const chartOptions = chartTypes.length > 0
    ? chartTypes
    : [{ id: "bar" as ChartTypeId, label: "Ranked bars", purpose: "", mode: "rank" as const }]

  return (
    <div className="space-y-4">
      <QuestionBuilder
        dimensions={dimensions}
        dimension={dimension}
        onDimensionChange={setDimension}
        current={current}
        entityOptions={entityOptions}
        entitiesLoading={entitiesLoading}
        keys={keys}
        onKeysChange={setKeys}
        focusable={focusable}
        productOptions={productOptions}
        productsLoading={productsLoading}
        focusProducts={focusProducts}
        onFocusChange={setFocusProducts}
        availableMetrics={availableMetrics}
        metric={effectiveMetric}
        onMetricChange={setMetric}
        chartOptions={chartOptions}
        chart={chart}
        onChartChange={setChart}
        onClear={() => { setKeys([]); setFocusProducts([]) }}
      />

      <ComparisonCard
        dimension={dimension}
        dimensionLabel={current?.label ?? "Branch"}
        selectedCount={keys.length}
        focusLabels={activeFocus.map(
          (key) => productOptions.find((option) => option.key === key)?.label ?? "selected product",
        )}
        metric={effectiveMetric}
        availableMetrics={availableMetrics}
        onMetricChange={setMetric}
        data={data}
        isLoading={isLoading}
        requestError={requestError}
        onDrillDown={setDrillTarget}
      />

      {drillTarget ? (
        <DrillDownPanel
          target={drillTarget}
          filters={scopedFilters}
          metric={effectiveMetric}
          onClose={() => setDrillTarget(null)}
        />
      ) : null}

      {priceProduct ? (
        <PriceByBranchCard
          priceProduct={priceProduct}
          priceData={priceData}
          priceLoading={priceLoading}
          onClose={onClearPriceProduct}
        />
      ) : null}
    </div>
  )
}

/** The four-step control row: what to compare, which ones, how, drawn as what. */
function QuestionBuilder({
  dimensions, dimension, onDimensionChange, current,
  entityOptions, entitiesLoading, keys, onKeysChange,
  focusable, productOptions, productsLoading, focusProducts, onFocusChange,
  availableMetrics, metric, onMetricChange,
  chartOptions, chart, onChartChange, onClear,
}: Readonly<{
  dimensions: DimensionMenuEntry[]
  dimension: ExecutiveDimensionId
  onDimensionChange: (next: ExecutiveDimensionId) => void
  current: DimensionMenuEntry | undefined
  entityOptions: EntityOption[]
  entitiesLoading: boolean
  keys: string[]
  onKeysChange: (next: string[]) => void
  focusable: boolean
  productOptions: EntityOption[]
  productsLoading: boolean
  focusProducts: string[]
  onFocusChange: (next: string[]) => void
  availableMetrics: ExecutiveMetricId[]
  metric: ExecutiveMetricId
  onMetricChange: (next: ExecutiveMetricId) => void
  chartOptions: ChartTypeOption[]
  chart: ChartTypeId
  onChartChange: (next: ChartTypeId) => void
  onClear: () => void
}>) {
  const selectable = Boolean(current?.selectable)
  const metricStep = (selectable ? 3 : 2) + (focusable ? 1 : 0)

  return (
      <div className="flex flex-wrap items-start gap-x-5 gap-y-3 rounded-xl border border-slate-200 bg-white/60 p-3 dark:border-slate-700 dark:bg-slate-900/40">
        <Step index={1} label="Compare">
          <Segmented
            label="Compare by"
            value={dimension}
            options={dimensions.map((entry) => ({ id: entry.id, label: entry.label }))}
            onChange={onDimensionChange}
          />
        </Step>

        {selectable && current ? (
          <Step index={2} label="Which ones">
            <EntityPicker
              noun={current.entityNoun}
              options={entityOptions}
              selected={keys}
              onChange={onKeysChange}
              loading={entitiesLoading}
              emptyLabel={`All ${current.entityNoun} (top ranked)`}
            />
          </Step>
        ) : null}

        {focusable ? (
          <Step index={selectable ? 3 : 2} label="Focus on (optional)">
            <EntityPicker
              noun="products"
              options={productOptions}
              selected={focusProducts}
              onChange={onFocusChange}
              loading={productsLoading}
              emptyLabel="All products"
              className="w-[240px]"
              icon={<Package className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />}
            />
          </Step>
        ) : null}

        <Step index={metricStep} label="Measured by">
          <Segmented
            label="Metric"
            value={metric}
            onChange={onMetricChange}
            options={availableMetrics.map((id) => ({
              id,
              label: EXECUTIVE_METRICS[id].label,
              title: EXECUTIVE_METRICS[id].formula,
            }))}
          />
        </Step>

        <Step index={metricStep + 1} label="Shown as">
          <Segmented
            label="Chart type"
            value={chart}
            onChange={onChartChange}
            options={chartOptions.map((entry) => ({
              id: entry.id,
              label: entry.label,
              disabled: Boolean(entry.disabledReason),
              // The reason a form is unavailable rides on the control itself,
              // so the reader learns why rather than finding it greyed out.
              title: entry.disabledReason || entry.purpose,
            }))}
          />
        </Step>

        {keys.length > 0 || focusProducts.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="mt-6 flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Clear selection
          </button>
        ) : null}
      </div>
  )
}

function ComparisonCard({
  dimension, dimensionLabel, selectedCount, focusLabels, metric, availableMetrics, onMetricChange,
  data, isLoading, requestError, onDrillDown,
}: Readonly<{
  dimension: ExecutiveDimensionId
  dimensionLabel: string
  selectedCount: number
  /** Products the comparison is narrowed to, named so the chart cannot mislead. */
  focusLabels: string[]
  metric: ExecutiveMetricId
  availableMetrics: ExecutiveMetricId[]
  onMetricChange: (next: ExecutiveMetricId) => void
  data: ComparisonResponse | undefined
  isLoading: boolean
  requestError: string | null
  onDrillDown: (target: DrillTarget) => void
}>) {
  const rows = data?.rows ?? []
  const series = data?.series ?? []
  const periods = data?.periods ?? []
  const format = data?.format ?? "currency"
  const metricLabel = data?.label ?? EXECUTIVE_METRICS[metric].label
  const chart = data?.chart ?? "bar"
  const mode = data?.mode ?? "rank"
  const blockedMessage = data?.blocked?.message ?? null
  const isEmpty = mode === "series" ? series.length === 0 : rows.length === 0

  const subject = (() => {
    if (focusLabels.length === 0) return null
    if (focusLabels.length <= 2) return focusLabels.join(" and ")
    return `${focusLabels.length} products`
  })()

  const title = (() => {
    const base = selectedCount > 0
      ? `${metricLabel}: ${selectedCount} ${dimensionLabel.toLowerCase()}${selectedCount === 1 ? "" : "s"} compared`
      : `${metricLabel} by ${dimensionLabel}`
    // The focus goes in the title, not a footnote: a chart of one product's
    // consumption must never be mistaken for a chart of everything.
    return subject ? `${subject} — ${metricLabel} by ${dimensionLabel}` : base
  })()

  /**
   * The one-click flip between money and stuff, on the chart itself.
   *
   * The full metric row above can already reach both, but the flip is the most
   * repeated action on this screen and burying it among seven options makes a
   * reader hunt for it every time. It writes the same state, so the two
   * controls can never disagree, and it is hidden where the dimension does not
   * offer both measures rather than shown as a control that does nothing.
   */
  const canToggleMeasure = availableMetrics.includes("spend") && availableMetrics.includes("quantity")

  return (
    <ChartCard
      title={title}
      question={EXECUTIVE_METRICS[metric].decision}
      formula={data?.formula ?? EXECUTIVE_METRICS[metric].formula}
      loading={isLoading}
      error={requestError}
      empty={blockedMessage ?? (isEmpty ? "No data for this combination in the selected period and filters." : null)}
      toolbar={canToggleMeasure ? (
        <MeasureToggle
          value={measureOfMetric(metric)}
          onChange={(next: MeasureId) => onMetricChange(MEASURE_METRIC[next])}
        />
      ) : undefined}
      table={mode === "series"
        ? (
          <SeriesTable
            series={series}
            periods={periods}
            format={format}
            onSelectEntity={(key, index) => onDrillDown({
              dimension,
              key,
              label: series[index]?.label ?? key,
            })}
          />
        )
        : undefined}
    >
      <ComparisonChart
        chart={chart}
        rows={rows}
        series={series}
        periods={periods}
        format={format}
        metricLabel={metricLabel}
        dimensionLabel={dimensionLabel}
        unit={data?.quantityUnit.selected ?? null}
        concentrationEligible={Boolean(data?.concentrationEligible)}
        // Months and days are a sequence; colouring them apart would imply a
        // grouping that is not there. Entities get their own hue.
        colorful={!isTimeAxisDimension(dimension)}
        dimension={dimension}
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

function Row({ term, value }: Readonly<{ term: string; value: string }>) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-500 dark:text-slate-400">{term}</dt>
      <dd className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  )
}

/** The price drilldown: one product, one unit, branch against branch. */
function PriceByBranchCard({ priceProduct, priceData, priceLoading, onClose }: Readonly<{
  priceProduct: { productId: number; unit: string; name?: string }
  priceData: PriceResponse | undefined
  priceLoading: boolean
  onClose: () => void
}>) {
  return (
    <ChartCard
      title={`Unit price by branch${priceProduct.name ? ` — ${priceProduct.name}` : ""}`}
      question="Which branches pay more than their peers for this item?"
      formula="Weighted average unit price per branch = Σ(line value) ÷ Σ(quantity), within the same product and the same unit of measure."
      loading={priceLoading}
      error={priceData?.error ?? null}
      empty={priceData && !priceData.comparable ? priceData.message : null}
      toolbar={
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
        >
          Close
        </button>
      }
      table={
        <DataTable
          columns={["Branch", "Avg unit price", "Quantity", "Value", "Orders"]}
          rows={(priceData?.rows ?? []).map((row) => [
            row.branchName,
            money(row.avgUnitPriceCents),
            `${countShort(row.quantity)} ${row.unit}`,
            money(row.valueCents),
            countShort(row.orderCount),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height={Math.max(200, (priceData?.rows.length ?? 0) * 34 + 40)}>
        <BarChart data={priceData?.rows ?? []} layout="vertical" margin={{ top: 4, right: 84, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value) => formatShortByKind(value, "currency")}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="branchName" width={150} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null
              const row = payload[0].payload
              return (
                <div className="min-w-[190px] rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">{String(label)}</p>
                  <dl className="space-y-1 text-xs">
                    <Row term={`Avg price / ${row.unit}`} value={money(row.avgUnitPriceCents)} />
                    <Row term="Quantity" value={`${countShort(row.quantity)} ${row.unit}`} />
                    <Row term="Total value" value={money(row.valueCents)} />
                    <Row term="Orders" value={countShort(row.orderCount)} />
                  </dl>
                </div>
              )
            }}
          />
          <Bar dataKey="avgUnitPriceCents" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={18}>
            <LabelList
              dataKey="avgUnitPriceCents"
              position="right"
              formatter={(value: any) => formatShortByKind(Number(value), "currency")}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Legend items={[{ label: "Weighted average unit price", color: SERIES[0] }]} />
    </ChartCard>
  )
}
