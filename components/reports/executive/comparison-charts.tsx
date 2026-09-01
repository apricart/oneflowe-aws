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

import type { ChartTypeId } from "@/lib/executive-analytics"
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
  onSelectEntity?: (key: string) => void
}

/** Long labels need vertical room; short lists should not stretch to fill. */
const rankHeight = (count: number) => Math.max(220, Math.min(560, count * 34 + 48))

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

function RankedBars({ rows, format, metricLabel, onSelectEntity }: Readonly<ChartProps>) {
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
            onClick={(entry: any) => onSelectEntity?.(entry?.payload?.key)}
            className={onSelectEntity ? "cursor-pointer" : undefined}
          >
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
      <Legend items={[{ label: metricLabel, color: SERIES[0] }]} />
    </>
  )
}

// ── Columns ────────────────────────────────────────────────────────────────

function ColumnChart({ rows, format, metricLabel }: Readonly<ChartProps>) {
  const crowded = rows.length > 6
  return (
    <>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={rows} margin={{ top: 20, right: 12, bottom: crowded ? 72 : 12, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            interval={0}
            angle={crowded ? -28 : 0}
            textAnchor={crowded ? "end" : "middle"}
            height={crowded ? 76 : 30}
          />
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
          <Bar dataKey="value" fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={56}>
            <LabelList
              dataKey="value"
              position="top"
              formatter={(value: any) => formatShortByKind(Number(value), format)}
              style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <Legend items={[{ label: metricLabel, color: SERIES[0] }]} />
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

function DonutChart({ rows, format, metricLabel, dimensionLabel }: Readonly<ChartProps>) {
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value), 0)
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
      <Legend items={rows.map((row, index) => ({ label: row.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Shares are of the {rows.length} {dimensionLabel.toLowerCase()} shown, totalling {formatByKind(total, format)} —
        not of everything in the period.
      </p>
    </>
  )
}

// ── Trend over time ────────────────────────────────────────────────────────

function TrendChart({ series, periods, format, metricLabel }: Readonly<ChartProps>) {
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
              dot={{ r: 3 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <Legend items={series.map((entity, index) => ({ label: entity.label, color: SERIES[index % SERIES.length] }))} />
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        {metricLabel} per month. A month with no purchase reads as zero, not as a gap.
      </p>
    </>
  )
}

// ── Value against quantity ─────────────────────────────────────────────────

function ScatterCompare({ rows, format, metricLabel, unit }: Readonly<ChartProps>) {
  const usable = rows.filter((row) => row.quantity > 0)

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
          <Scatter data={usable} fill={SERIES[0]} fillOpacity={0.75} stroke="var(--viz-surface)" strokeWidth={2}>
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
    </>
  )
}

// ── Table ──────────────────────────────────────────────────────────────────

function ComparisonTable({ rows, format, metricLabel, dimensionLabel, concentrationEligible }: Readonly<ChartProps>) {
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
    />
  )
}

/** The table shown for a trend, since a line chart has no single value per row. */
export function SeriesTable({ series, periods, format }: Readonly<{
  series: EntitySeries[]
  periods: string[]
  format: string
}>) {
  return (
    <DataTable
      columns={["Entity", ...periods]}
      rows={series.map((entity) => [
        entity.label,
        ...entity.points.map((point) => formatByKind(point.value, format)),
      ])}
    />
  )
}
