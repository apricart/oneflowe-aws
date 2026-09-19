"use client"

import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts"

import type { ChartTypeId, ExecutiveDimensionId } from "@/lib/executive-analytics"
import type { ExecutiveFilterState } from "./executive-filters"
import {
  AXIS_STYLE,
  DataTable,
  GRID_STYLE,
  Legend,
  SERIES,
  VizTooltip,
  changeLabel,
  countShort,
  formatByKind,
  formatShortByKind,
  money,
  percent,
} from "./chart-kit"

/**
 * The chart renderers behind the Explore workbench.
 *
 * One component per form, all fed from the same rows, so switching form never
 * changes the numbers — only how they are drawn. The rules about which forms
 * are *offered* live in the registry (`chartTypesFor`) and are enforced on the
 * server; these components assume they are only asked to draw something the
 * registry already allowed.
 */

export type ComparisonRow = {
  key: string
  label: string
  value: number
  previousValue: number
  changePct: number | null
  spendCents: number
  quantity: number
  orderCount: number
  avgUnitPriceCents: number
  totalBudgetCents?: number
  consumedCents?: number
  remainingCents?: number
  share: number
  cumulativeShare: number
}

export type EntitySeries = { key: string; label: string; points: Array<{ period: string; value: number }> }

/**
 * What a reader clicked: the entity, and — on a trend — the bucket as well.
 *
 * Both travel to the detail table, because a point on "requesters over months"
 * names a person *and* a month, and a table showing that person across the
 * whole window would not be the rows behind the point that was clicked.
 */
export type DrillTarget = {
  dimension: ExecutiveDimensionId
  key: string
  label: string
  /** "YYYY-MM" or "YYYY-MM-DD" when the click also named a bucket. */
  period?: string
  /**
   * A second entity the click named, as a narrowing of the shared filters.
   *
   * A cell of the requester × product grid is one person *and* one product;
   * the person travels as the key and the product overrides the screen's
   * product focus for this one request, so the table shows that pair and not
   * the person across every focused product. Only filters the server already
   * applies can be named here — there is no new parameter to audit.
   */
  narrow?: Partial<Pick<ExecutiveFilterState, "productIds" | "userIds" | "categoryIds" | "branchIds">>
}

type ChartProps = {
  chart: ChartTypeId
  rows: ComparisonRow[]
  series: EntitySeries[]
  periods: string[]
  format: string
  metricLabel: string
  dimensionLabel: string
  unit: string | null
  concentrationEligible: boolean
  /**
   * A distinct hue per entity.
   *
   * Colour is decoration here, never the encoding: every bar keeps its own axis
   * label and its own direct value label, so a repeated hue past the sixth slot
   * costs a reader nothing. On a time axis it is off, because months are a
   * sequence and colouring them at random would imply a grouping that is not
   * there.
   */
  colorful?: boolean
  /** Opens the detail table for the clicked bar, slice or point. */
  onDrillDown?: (target: DrillTarget) => void
  /** The dimension being compared, carried into the drill target. */
  dimension?: ExecutiveDimensionId
}

/** Long labels need vertical room; short lists should not stretch to fill. */
const rankHeight = (count: number) => Math.max(220, Math.min(560, count * 34 + 48))

/** The hue for one entity's slot, cycling once the fixed palette is exhausted. */
export function entityColor(index: number, colorful?: boolean): string {
  return colorful ? SERIES[index % SERIES.length] : SERIES[0]
}

/** Reads a Recharts click payload back into a row, whatever shape it arrives in. */
function rowFromPayload(entry: any): ComparisonRow | null {
  const row = entry?.payload?.payload ?? entry?.payload ?? entry
  return row && typeof row.key === "string" ? (row as ComparisonRow) : null
}

/**
 * The shared "clicking this opens the rows behind it" affordance.
 *
 * Kept as one helper rather than repeated per chart so every form drills the
 * same way — a reader who learns it on the bars does not have to rediscover it
 * on the donut.
 */
function drillHandler(
  dimension: ExecutiveDimensionId | undefined,
  onDrillDown: ((target: DrillTarget) => void) | undefined,
) {
  if (!dimension || !onDrillDown) return undefined
  return (entry: any) => {
    const row = rowFromPayload(entry)
    if (row) onDrillDown({ dimension, key: row.key, label: row.label })
  }
}

/** Footnote telling the reader the chart is drillable, shown only when it is. */
export function DrillHint({ enabled, noun }: Readonly<{ enabled: boolean; noun: string }>) {
  if (!enabled) return null
  return (
    <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
      Select any {noun} to open the order lines behind it, for this same period and these same filters.
    </p>
  )
}

function EntityTooltip({ row, format, metricLabel, concentrationEligible, showChange }: Readonly<{
  row: ComparisonRow
  format: string
  metricLabel: string
  concentrationEligible: boolean
  showChange: boolean
}>) {
  const rows = [
    { label: metricLabel, value: formatByKind(row.value, format), color: SERIES[0] },
    ...(concentrationEligible ? [{ label: "Share of shown", value: percent(row.share) }] : []),
    ...(showChange ? [{ label: "vs prior period", value: changeLabel(row.changePct).text }] : []),
  ]

  if (row.totalBudgetCents !== undefined) {
    rows.push(
      { label: "Total budget", value: money(row.totalBudgetCents), muted: true } as any,
      { label: "Consumed", value: money(row.consumedCents ?? 0), muted: true } as any,
      { label: "Remaining", value: money(row.remainingCents ?? 0), muted: true } as any,
    )
  } else {
    rows.push(
      { label: "Procurement value", value: money(row.spendCents), muted: true } as any,
      { label: "Orders", value: countShort(row.orderCount), muted: true } as any,
    )
  }

  return <VizTooltip title={row.label} rows={rows as any} />
}

export function ComparisonChart(props: Readonly<ChartProps>) {
  switch (props.chart) {
    case "column": return <ColumnChart {...props} />
    case "grouped": return <GroupedChart {...props} />
    case "donut": return <DonutChart {...props} />
    case "line": return <TrendChart {...props} />
    case "scatter": return <ScatterCompare {...props} />
    case "table": return <ComparisonTable {...props} />
    default: return <RankedBars {...props} />
  }
}

// ── Ranked bars — the default ──────────────────────────────────────────────

function RankedBars({
  rows, format, metricLabel, colorful, dimension, onDrillDown, dimensionLabel,
}: Readonly<ChartProps>) {
  const drill = drillHandler(dimension, onDrillDown)
  return (
    <>
      <ResponsiveContainer width="100%" height={rankHeight(rows.length)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 84, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="label" width={168} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload }: any) => (active && payload?.length
              ? <EntityTooltip row={payload[0].payload} format={format} metricLabel={metricLabel} concentrationEligible showChange />
              : null)}
          />
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[0, 4, 4, 0]}
            barSize={18}
            isAnimationActive={false}
            // Selecting a bar opens the rows behind it. Adding an entity to the
            // comparison is the "Which ones" picker's job — one click cannot
            // mean two things, and the rows are what a reader wants first.
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, colorful)} />
            ))}
            {/* Direct labels: the relief rule for the low-contrast light slots. */}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: any) => formatShortByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {colorful
        ? <Legend items={rows.slice(0, 12).map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))} />
        : <Legend items={[{ label: metricLabel, color: SERIES[0] }]} />}
      <DrillHint enabled={Boolean(drill)} noun={dimensionLabel.toLowerCase()} />
    </>
  )
}

// ── Columns ────────────────────────────────────────────────────────────────

/**
 * Past either of these an upright tick collides with its neighbour: twelve
 * product names across half a row leave each column about sixty pixels, and a
 * name like "Tapal Danedar Teabags (600 PCS)" is three times that on its own.
 */
const COLUMN_UPRIGHT_MAX_COLUMNS = 6
const COLUMN_UPRIGHT_MAX_CHARS = 18
/**
 * The longest an angled tick is drawn. The tick only has to tell the columns
 * apart — the full name is in the tooltip, the legend and the table.
 */
const COLUMN_TICK_MAX_CHARS = 22

/** Whether the x-axis ticks are angled rather than upright, for these rows. */
export function columnTicksAngled(rows: ReadonlyArray<Pick<ComparisonRow, "label">>): boolean {
  return rows.length > COLUMN_UPRIGHT_MAX_COLUMNS
    || rows.some((entry) => entry.label.length > COLUMN_UPRIGHT_MAX_CHARS)
}

/** The tick text for one angled column: the label, shortened with an ellipsis past the cap. */
export function columnTickLabel(label: unknown): string {
  const text = String(label ?? "")
  if (text.length <= COLUMN_TICK_MAX_CHARS) return text
  return `${text.slice(0, COLUMN_TICK_MAX_CHARS - 1).trimEnd()}…`
}

/**
 * The category axis of every upright column chart, upright or angled.
 *
 * Spread onto a Recharts `XAxis` rather than wrapped in a component of its
 * own: Recharts finds its axes by element type, so a wrapper would hide the
 * axis from it. The chart height and bottom margin that go with the angled
 * form are `columnChartHeight` and `columnBottomMargin`.
 */
export function columnAxisProps(angled: boolean) {
  return {
    tick: AXIS_STYLE,
    axisLine: false,
    tickLine: false,
    interval: 0 as const,
    angle: angled ? -45 : 0,
    textAnchor: (angled ? "end" : "middle") as "end" | "middle",
    height: angled ? 104 : 30,
    tickFormatter: angled ? columnTickLabel : undefined,
  }
}

/** Angled ticks need more of the card; the plot keeps its height either way. */
export const columnChartHeight = (angled: boolean, upright: number) => (angled ? upright + 40 : upright)
export const columnBottomMargin = (angled: boolean) => (angled ? 8 : 12)

function ColumnChart({
  rows, format, metricLabel, colorful, dimension, onDrillDown, dimensionLabel,
}: Readonly<ChartProps>) {
  const angled = columnTicksAngled(rows)
  const drill = drillHandler(dimension, onDrillDown)
  return (
    <>
      <ResponsiveContainer width="100%" height={columnChartHeight(angled, 300)}>
        <BarChart data={rows} margin={{ top: 20, right: 12, bottom: columnBottomMargin(angled), left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="label" {...columnAxisProps(angled)} />
          <YAxis
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload }: any) => (active && payload?.length
              ? <EntityTooltip row={payload[0].payload} format={format} metricLabel={metricLabel} concentrationEligible showChange />
              : null)}
          />
          <Bar
            dataKey="value"
            fill={SERIES[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={56}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, colorful)} />
            ))}
            <LabelList
              dataKey="value"
              position="top"
              formatter={(value: any) => formatShortByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {colorful
        ? <Legend items={rows.slice(0, 12).map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))} />
        : <Legend items={[{ label: metricLabel, color: SERIES[0] }]} />}
      <DrillHint enabled={Boolean(drill)} noun={dimensionLabel.toLowerCase()} />
    </>
  )
}

// ── This period vs prior ───────────────────────────────────────────────────

function GroupedChart({ rows, format, metricLabel }: Readonly<ChartProps>) {
  return (
    <>
      <ResponsiveContainer width="100%" height={rankHeight(rows.length * 1.4)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 84, bottom: 4, left: 4 }} barGap={2}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="label" width={168} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null
              const row: ComparisonRow = payload[0].payload
              return (
                <VizTooltip
                  title={row.label}
                  rows={[
                    { label: "This period", value: formatByKind(row.value, format), color: SERIES[0] },
                    { label: "Prior period", value: formatByKind(row.previousValue, format), color: SERIES[1] },
                    { label: "Change", value: changeLabel(row.changePct).text },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="previousValue" fill={SERIES[1]} radius={[0, 4, 4, 0]} barSize={9} />
          <Bar dataKey="value" fill={SERIES[0]} radius={[0, 4, 4, 0]} barSize={9}>
            <LabelList
              dataKey="value"
              position="right"
              formatter={(value: any) => formatShortByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Legend items={[
        { label: `${metricLabel}, this period`, color: SERIES[0] },
        { label: "Prior period", color: SERIES[1] },
      ]} />
    </>
  )
}

// ── Share of total ─────────────────────────────────────────────────────────

function DonutChart({ rows, format, metricLabel, dimensionLabel, dimension, onDrillDown }: Readonly<ChartProps>) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0)
  const drill = drillHandler(dimension, onDrillDown)
  return (
    <>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Tooltip
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null
              const row: ComparisonRow = payload[0].payload
              return (
                <VizTooltip
                  title={row.label}
                  rows={[
                    { label: metricLabel, value: formatByKind(row.value, format) },
                    { label: "Share of shown", value: percent(row.share) },
                    { label: "vs prior period", value: changeLabel(row.changePct).text, muted: true },
                  ]}
                />
              )
            }}
          />
          <Pie
            data={rows}
            dataKey="value"
            nameKey="label"
            innerRadius="52%"
            outerRadius="80%"
            paddingAngle={2}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
            label={({ payload, percent: fraction }: any) =>
              fraction > 0.04 ? `${payload.label} ${(fraction * 100).toFixed(0)}%` : ""}
            labelLine={false}
          >
            {rows.map((row, index) => (
              <Cell key={row.key} fill={SERIES[index % SERIES.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <Legend items={rows.map((row, index) => ({ key: row.key, label: row.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Shares are of the {rows.length} {dimensionLabel.toLowerCase()} shown, totalling {formatByKind(total, format)} —
        not of everything in the period.
      </p>
      <DrillHint enabled={Boolean(drill)} noun="slice" />
    </>
  )
}

// ── Trend over time ────────────────────────────────────────────────────────

/**
 * A line-chart dot with its own hit area.
 *
 * Recharts hands a custom `dot` element the row it is drawn from, which is the
 * only reliable way to know *both* which line and which bucket a click landed
 * on. The visible dot stays small for legibility while an invisible circle
 * around it gives a target big enough to hit on a touch screen.
 */
function DrillDot({ cx, cy, color, payload, onDrill }: Readonly<{
  cx?: number
  cy?: number
  color?: string
  payload?: { period?: string }
  onDrill?: (period: string) => void
}>) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return (
    <g>
      <circle cx={cx} cy={cy} r={3} fill={color} stroke="var(--viz-surface)" strokeWidth={1} pointerEvents="none" />
      {onDrill ? (
        <circle
          cx={cx}
          cy={cy}
          r={11}
          fill="transparent"
          className="cursor-pointer"
          onClick={() => onDrill(String(payload?.period ?? ""))}
        />
      ) : null}
    </g>
  )
}

function TrendChart({
  series, periods, format, metricLabel, dimension, onDrillDown, dimensionLabel,
}: Readonly<ChartProps>) {
  /**
   * A point on a trend can name one thing or two.
   *
   * On a time axis the series *is* the period, so the bucket is the entity and
   * it drills as one. On "requesters over months" the point names a person and
   * a month, so both travel and the table shows that person in that month —
   * anything else would show rows the clicked point does not account for.
   */
  const isTimeAxis = dimension === "month" || dimension === "day"
  const drillPoint = dimension && onDrillDown
    ? (entity: EntitySeries, period: string) => {
      if (!period) return
      if (isTimeAxis) onDrillDown({ dimension, key: period, label: period })
      else onDrillDown({ dimension, key: entity.key, label: `${entity.label} · ${period}`, period })
    }
    : undefined

  // One row per period, one column per entity: the shape Recharts draws lines from.
  const data = periods.map((period, index) => {
    const point: Record<string, string | number> = { period }
    series.forEach((entity) => { point[entity.key] = entity.points[index]?.value ?? 0 })
    return point
  })

  return (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="period" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tickFormatter={(value) => formatShortByKind(value, format)}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
          />
          <Tooltip
            cursor={{ stroke: "var(--viz-axis)", strokeDasharray: "3 3" }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null
              return (
                <VizTooltip
                  title={String(label)}
                  rows={series.map((entity, index) => ({
                    label: entity.label,
                    value: formatByKind(Number(payload.find((p: any) => p.dataKey === entity.key)?.value ?? 0), format),
                    color: SERIES[index % SERIES.length],
                  }))}
                />
              )
            }}
          />
          {series.map((entity, index) => (
            <Line
              key={entity.key}
              type="monotone"
              dataKey={entity.key}
              name={entity.label}
              stroke={SERIES[index % SERIES.length]}
              strokeWidth={2}
              dot={(
                <DrillDot
                  color={SERIES[index % SERIES.length]}
                  onDrill={drillPoint ? (period) => drillPoint(entity, period) : undefined}
                />
              )}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend items={series.map((entity, index) => ({ key: entity.key, label: entity.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        {metricLabel} per {isTimeAxis && dimension === "day" ? "day" : "month"}. A period with no purchase reads as zero,
        not as a gap.
      </p>
      <DrillHint enabled={Boolean(drillPoint)} noun={isTimeAxis ? "point" : `point — one ${dimensionLabel.toLowerCase()} in one month`} />
    </>
  )
}

// ── Value against quantity ─────────────────────────────────────────────────

function ScatterCompare({ rows, format, metricLabel, unit, dimension, onDrillDown }: Readonly<ChartProps>) {
  const usable = rows.filter((row) => row.quantity > 0)
  const drill = drillHandler(dimension, onDrillDown)

  if (usable.length === 0) {
    return (
      <p className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
        Value against quantity needs order lines with a quantity. Choose a single unit of measure to plot this.
      </p>
    )
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <ScatterChart margin={{ top: 16, right: 24, bottom: 32, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} />
          <XAxis
            type="number"
            dataKey="quantity"
            name="Quantity"
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={countShort}
            label={{ value: unit ? `Quantity (${unit})` : "Quantity", position: "insideBottom", offset: -16, style: AXIS_STYLE }}
          />
          <YAxis
            type="number"
            dataKey="spendCents"
            name="Value"
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={72}
            tickFormatter={(value) => formatShortByKind(value, "currency")}
          />
          <ZAxis type="number" dataKey="orderCount" range={[60, 320]} name="Orders" />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null
              const row: ComparisonRow = payload[0].payload
              return (
                <VizTooltip
                  title={row.label}
                  rows={[
                    { label: "Value", value: money(row.spendCents), color: SERIES[0] },
                    { label: `Quantity${unit ? ` (${unit})` : ""}`, value: countShort(row.quantity) },
                    { label: "Avg unit price", value: money(row.avgUnitPriceCents) },
                    { label: "Orders", value: countShort(row.orderCount), muted: true },
                    { label: metricLabel, value: formatByKind(row.value, format), muted: true },
                  ]}
                />
              )
            }}
          />
          <Scatter
            data={usable}
            fill={SERIES[0]}
            fillOpacity={0.75}
            stroke="var(--viz-surface)"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={drill}
            className={drill ? "cursor-pointer" : undefined}
          >
            {usable.map((row, index) => (
              <Cell key={row.key} fill={entityColor(index, true)} />
            ))}
            <LabelList
              dataKey="label"
              position="top"
              style={{ fontSize: 10, fill: "var(--viz-ink)" }}
            />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Each point is one entity: quantity across, value up, bubble size is order count. High and left means paying a lot
        for little; low and right means buying volume cheaply.
      </p>
      <DrillHint enabled={Boolean(drill)} noun="point" />
    </>
  )
}

// ── Table ──────────────────────────────────────────────────────────────────

/** What the ranked table reads; `ComparisonChart` hands it the full chart props. */
export type ComparisonTableProps = Pick<
  ChartProps,
  "rows" | "format" | "metricLabel" | "dimensionLabel" | "concentrationEligible" | "dimension" | "onDrillDown"
>

/**
 * The table form of a ranking: the same rows, readable without colour.
 *
 * Reached two ways — as the `table` chart type in the Explore workbench, and
 * as the table view of every ranked panel on the Product Performance screen,
 * where it is what makes "graph + table" true for the bar panels and not only
 * the trends.
 */
export function ComparisonTable({
  rows, format, metricLabel, dimensionLabel, concentrationEligible, dimension, onDrillDown,
}: Readonly<ComparisonTableProps>) {
  return (
    <DataTable
      columns={[
        dimensionLabel,
        metricLabel,
        ...(concentrationEligible ? ["Share"] : []),
        "vs prior",
        "Orders",
      ]}
      rows={rows.map((row) => [
        row.label,
        formatByKind(row.value, format),
        ...(concentrationEligible ? [percent(row.share)] : []),
        changeLabel(row.changePct).text,
        countShort(row.orderCount),
      ])}
      // The table is the keyboard path to the same drill-down the bars give a
      // mouse, so neither reader is offered a comparison they cannot open.
      rowKeys={rows.map((row) => row.key)}
      onSelectRow={dimension && onDrillDown
        ? (key, index) => onDrillDown({ dimension, key, label: rows[index]?.label ?? key })
        : undefined}
    />
  )
}

/** The table shown for a trend, since a line chart has no single value per row. */
export function SeriesTable({ series, periods, format, onSelectEntity }: Readonly<{
  series: EntitySeries[]
  periods: string[]
  format: string
  onSelectEntity?: (key: string, index: number) => void
}>) {
  return (
    <DataTable
      columns={["Entity", ...periods]}
      rows={series.map((entity) => [
        entity.label,
        ...entity.points.map((point) => formatByKind(point.value, format)),
      ])}
      rowKeys={series.map((entity) => entity.key)}
      onSelectRow={onSelectEntity}
    />
  )
}
