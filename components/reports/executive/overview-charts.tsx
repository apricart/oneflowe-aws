"use client"

import * as React from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { cn } from "@/lib/utils"
import {
  AXIS_STYLE,
  BUDGET_BESIDE_COLOR,
  ChartCard,
  DataTable,
  GRID_STYLE,
  Legend,
  SERIES,
  STATUS_COLOR,
  VizTooltip,
  countShort,
  money,
  moneyShort,
  percent,
  sequentialStep,
} from "./chart-kit"

/**
 * The Level-1 visuals.
 *
 * Every chart here is a comparison, never a display: branch against budget,
 * branch against branch, this period against the last, one category's share
 * against the whole. Each one is wrapped in `ChartCard`, which carries its
 * business question, a formula affordance and a table view.
 */

export type BranchRow = {
  branchId: number
  branchName: string
  totalBudgetCents: number
  allocatedCents: number
  creditedCents: number
  spentCents: number
  heldCents: number
  consumedCents: number
  remainingCents: number
  utilizationPct: number
  health: "over" | "warning" | "healthy" | "underused" | "unbudgeted"
  spendCents: number
  orderCount: number
  avgOrderValueCents: number
  spendGrowthPct: number | null
  shareOfSpendPct: number
}

const HEALTH_META: Record<BranchRow["health"], { color: string; label: string }> = {
  over: { color: STATUS_COLOR.critical, label: "Over budget" },
  warning: { color: STATUS_COLOR.serious, label: "Approaching limit" },
  healthy: { color: STATUS_COLOR.good, label: "On track" },
  underused: { color: STATUS_COLOR.warning, label: "Under-used" },
  unbudgeted: { color: "var(--viz-track)", label: "No budget set" },
}

/** Bars need room for a name; a long branch list scrolls rather than crushing labels. */
function chartHeight(rowCount: number, perRow = 34, minimum = 200) {
  return Math.max(minimum, rowCount * perRow + 40)
}

// ── 1. Budget vs Consumed ──────────────────────────────────────────────────

/**
 * Room per branch on the category axis, so a long tenant scrolls sideways
 * rather than crushing a hundred names into slivers. Two columns and a gap
 * need about this much to stay readable; the chart's own width is the larger
 * of the card and this.
 */
export const BUDGET_COLUMN_WIDTH = 64
const BUDGET_COLUMN_HEIGHT = 340

/** The pixel width a Budget vs Consumed chart needs for `count` branches. */
export function budgetChartMinWidth(count: number): number {
  return Math.max(0, count) * BUDGET_COLUMN_WIDTH + 96
}

/**
 * Two upright columns per branch — Total Budget beside Consumed — and nothing
 * stacked, because that is the comparison the reader is making: how much was
 * given against how much was used. Spent and committed, the two halves of
 * Consumed, stay in the tooltip and the table where they can be read as
 * figures rather than guessed from a boundary inside a bar.
 */
export function BudgetVsActualChart({ rows, loading, error, onSelectBranch, selectedBranchId }: Readonly<{
  rows: BranchRow[]
  loading: boolean
  error: string | null
  onSelectBranch?: (branchId: number) => void
  selectedBranchId?: number | null
}>) {
  const data = rows.filter((row) => row.totalBudgetCents > 0 || row.consumedCents > 0)
  const crowded = data.length > 8
  const select = onSelectBranch
    ? (entry: any) => onSelectBranch(entry?.payload?.branchId)
    : undefined

  return (
    <ChartCard
      title="Budget vs Consumed by Branch"
      question="Is each branch living within the budget it was given?"
      formula="Total Budget = allocated + add-ons. Consumed = spent + committed. Remaining = Total Budget − Consumed."
      loading={loading}
      error={error}
      empty={data.length === 0 ? "No branch in the selected period has a budget or any procurement activity." : null}
      table={
        <DataTable
          columns={["Branch", "Total Budget", "Consumed", "Spent", "Committed", "Remaining", "Utilization"]}
          rows={data.map((row) => [
            row.branchName,
            money(row.totalBudgetCents),
            money(row.consumedCents),
            money(row.spentCents),
            money(row.heldCents),
            money(row.remainingCents),
            row.totalBudgetCents > 0 ? percent(row.utilizationPct) : "no budget",
          ])}
        />
      }
    >
      <div className="overflow-x-auto" data-testid="budget-vs-consumed-scroll">
        <div style={{ minWidth: budgetChartMinWidth(data.length) }} data-testid="budget-vs-consumed-canvas">
          <ResponsiveContainer width="100%" height={BUDGET_COLUMN_HEIGHT}>
            <BarChart data={data} margin={{ top: 12, right: 12, bottom: crowded ? 72 : 12, left: 4 }} barCategoryGap="24%" barGap={3}>
              <CartesianGrid {...GRID_STYLE} vertical={false} />
              <XAxis
                dataKey="branchName"
                tick={AXIS_STYLE}
                axisLine={false}
                tickLine={false}
                interval={0}
                angle={crowded ? -35 : 0}
                textAnchor={crowded ? "end" : "middle"}
                height={crowded ? 76 : 30}
              />
              <YAxis tickFormatter={moneyShort} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={72} />
              <Tooltip
                cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
                content={({ active, payload }: any) => {
                  if (!active || !payload?.length) return null
                  const row: BranchRow = payload[0].payload
                  return (
                    <VizTooltip
                      title={row.branchName}
                      rows={[
                        { label: "Total budget", value: money(row.totalBudgetCents), color: BUDGET_BESIDE_COLOR },
                        { label: "Consumed", value: money(row.consumedCents), color: SERIES[0] },
                        { label: "Spent", value: money(row.spentCents), muted: true },
                        { label: "Committed", value: money(row.heldCents), muted: true },
                        { label: "Remaining", value: money(row.remainingCents) },
                        {
                          label: "Utilization",
                          value: row.totalBudgetCents > 0 ? percent(row.utilizationPct) : "no budget set",
                          muted: true,
                        },
                        { label: "Orders", value: countShort(row.orderCount), muted: true },
                      ]}
                    />
                  )
                }}
              />
              <Bar
                dataKey="totalBudgetCents"
                name="Total budget"
                fill={BUDGET_BESIDE_COLOR}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
                isAnimationActive={false}
                onClick={select}
                className={select ? "cursor-pointer" : undefined}
              />
              <Bar
                dataKey="consumedCents"
                name="Consumed"
                fill={SERIES[0]}
                radius={[4, 4, 0, 0]}
                maxBarSize={28}
                isAnimationActive={false}
                onClick={select}
                className={select ? "cursor-pointer" : undefined}
              >
                {data.map((row) => (
                  <Cell key={row.branchId} stroke={selectedBranchId === row.branchId ? "var(--viz-ink)" : undefined} strokeWidth={2} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <Legend
        items={[
          { label: "Total budget", color: BUDGET_BESIDE_COLOR },
          { label: "Consumed (spent + committed)", color: SERIES[0] },
        ]}
      />
    </ChartCard>
  )
}

// ── 2. Utilization ranking ─────────────────────────────────────────────────

export function UtilizationRankingChart({ rows, warningPct, loading, error }: Readonly<{
  rows: BranchRow[]
  warningPct: number
  loading: boolean
  error: string | null
}>) {
  const data = rows
    .filter((row) => row.totalBudgetCents > 0)
    .sort((left, right) => right.utilizationPct - left.utilizationPct)
  const unbudgeted = rows.filter((row) => row.totalBudgetCents <= 0)

  return (
    <ChartCard
      title="Budget Utilization Ranking"
      question="Which branch is closest to exhausting its budget?"
      formula="Utilization % = (spent + committed) ÷ (allocated + add-ons) × 100. Branches with no budget are listed separately rather than shown at 0%."
      loading={loading}
      error={error}
      empty={data.length === 0 ? "No branch in scope has an allocated budget for this period, so utilization cannot be ranked." : null}
      table={
        <DataTable
          columns={["Branch", "Utilization", "Consumed", "Total Budget", "Status"]}
          rows={data.map((row) => [
            row.branchName,
            percent(row.utilizationPct),
            money(row.consumedCents),
            money(row.totalBudgetCents),
            HEALTH_META[row.health].label,
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height={chartHeight(data.length)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            domain={[0, (max: number) => Math.max(100, Math.ceil(max / 10) * 10)]}
            tickFormatter={(value) => `${value}%`}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="branchName" width={128} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <ReferenceLine x={warningPct} stroke={STATUS_COLOR.serious} strokeDasharray="4 4" />
          <ReferenceLine x={100} stroke={STATUS_COLOR.critical} strokeDasharray="4 4" />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null
              const row: BranchRow = payload[0].payload
              return (
                <VizTooltip
                  title={row.branchName}
                  rows={[
                    { label: "Utilization", value: percent(row.utilizationPct), color: HEALTH_META[row.health].color },
                    { label: "Status", value: HEALTH_META[row.health].label },
                    { label: "Consumed", value: money(row.consumedCents), muted: true },
                    { label: "Total budget", value: money(row.totalBudgetCents), muted: true },
                    { label: "Remaining", value: money(row.remainingCents), muted: true },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="utilizationPct" radius={[0, 4, 4, 0]} barSize={18}>
            {data.map((row) => (
              <Cell key={row.branchId} fill={HEALTH_META[row.health].color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* Status is never carried by colour alone: each band is named. */}
      <Legend
        items={[
          { label: `On track (< ${warningPct}%)`, color: STATUS_COLOR.good },
          { label: `Approaching limit (≥ ${warningPct}%)`, color: STATUS_COLOR.serious },
          { label: "Over budget (> 100%)", color: STATUS_COLOR.critical },
          { label: "Under-used", color: STATUS_COLOR.warning },
        ]}
      />
      {unbudgeted.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          Not ranked — no budget set for this period: {unbudgeted.map((row) => row.branchName).join(", ")}
        </p>
      ) : null}
    </ChartCard>
  )
}

// ── 3. Procurement trend ───────────────────────────────────────────────────

export type TrendPoint = { key: string; label: string; spendCents: number; orderCount: number }

export function ProcurementTrendChart({ current, previous, loading, error }: Readonly<{
  current: TrendPoint[]
  previous: TrendPoint[]
  loading: boolean
  error: string | null
}>) {
  // The two windows are aligned by position, not by month name: "the third
  // month of this period" against "the third month of the last one".
  const data = current.map((point, index) => ({
    label: point.label,
    currentCents: point.spendCents,
    previousCents: previous[index]?.spendCents ?? null,
    previousLabel: previous[index]?.label ?? null,
    orderCount: point.orderCount,
  }))

  return (
    <ChartCard
      title="Procurement Trend"
      question="Are we spending faster than we were?"
      formula="Procurement Value per month = Σ(order total − refunds) over revenue-eligible orders. The comparison series is the equal-length window immediately before this one, aligned by position."
      loading={loading}
      error={error}
      empty={data.length === 0 ? "No procurement activity in the selected period." : null}
      table={
        <DataTable
          columns={["Month", "This period", "Prior period", "Orders"]}
          rows={data.map((point) => [
            point.label,
            money(point.currentCents),
            point.previousCents === null ? "—" : money(point.previousCents),
            countShort(point.orderCount),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={moneyShort} tick={AXIS_STYLE} axisLine={false} tickLine={false} width={64} />
          <Tooltip
            cursor={{ stroke: "var(--viz-axis)", strokeDasharray: "3 3" }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload
              return (
                <VizTooltip
                  title={String(label)}
                  rows={[
                    { label: "This period", value: money(point.currentCents), color: SERIES[0] },
                    {
                      label: point.previousLabel ? `Prior (${point.previousLabel})` : "Prior period",
                      value: point.previousCents === null ? "no data" : money(point.previousCents),
                      color: SERIES[1],
                    },
                    { label: "Orders", value: countShort(point.orderCount), muted: true },
                  ]}
                />
              )
            }}
          />
          <Line
            type="monotone"
            dataKey="previousCents"
            stroke={SERIES[1]}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            connectNulls
          />
          <Line type="monotone" dataKey="currentCents" stroke={SERIES[0]} strokeWidth={2} dot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
      <Legend items={[{ label: "This period", color: SERIES[0] }, { label: "Prior period", color: SERIES[1] }]} />
    </ChartCard>
  )
}

// ── 4. Category concentration (Pareto) ─────────────────────────────────────

export type CategoryRow = {
  key: string
  label: string
  valueCents: number
  quantity: number
  orderCount: number
  share: number
  cumulativeShare: number
}

export function CategoryParetoChart({ rows, categoriesTo80, loading, error, onSelectCategory }: Readonly<{
  rows: CategoryRow[]
  categoriesTo80: number
  loading: boolean
  error: string | null
  onSelectCategory?: (key: string) => void
}>) {
  // Both series are percentages of the same total, so the chart has one scale.
  // A second y-axis for the raw money would be a dual-axis chart, which
  // misleads by letting the two curves cross wherever the scales are set.
  const data = rows.slice(0, 12)

  return (
    <ChartCard
      title="Spend Concentration by Category"
      question="Which few categories carry most of our procurement cost?"
      formula="Share = category value ÷ total value × 100, largest first. The line is the running cumulative share. Category value is line-grain: Σ(unit price × quantity − approved refunds)."
      loading={loading}
      error={error}
      empty={data.length === 0 ? "No categorised procurement in the selected period." : null}
      table={
        <DataTable
          columns={["Category", "Value", "Share", "Cumulative", "Orders"]}
          rows={data.map((row) => [
            row.label,
            money(row.valueCents),
            percent(row.share),
            percent(row.cumulativeShare),
            countShort(row.orderCount),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ ...AXIS_STYLE }}
            axisLine={false}
            tickLine={false}
            interval={0}
            angle={data.length > 6 ? -25 : 0}
            textAnchor={data.length > 6 ? "end" : "middle"}
            height={data.length > 6 ? 64 : 30}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <ReferenceLine y={80} stroke="var(--viz-axis)" strokeDasharray="4 4" />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null
              const row: CategoryRow = payload[0].payload
              return (
                <VizTooltip
                  title={String(label)}
                  rows={[
                    { label: "Value", value: money(row.valueCents), color: SERIES[0] },
                    { label: "Share of spend", value: percent(row.share) },
                    { label: "Cumulative", value: percent(row.cumulativeShare), color: SERIES[1] },
                    { label: "Orders", value: countShort(row.orderCount), muted: true },
                  ]}
                />
              )
            }}
          />
          <Bar
            dataKey="share"
            fill={SERIES[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={44}
            onClick={(entry: any) => onSelectCategory?.(entry?.payload?.key)}
            className={onSelectCategory ? "cursor-pointer" : undefined}
          />
          <Line type="monotone" dataKey="cumulativeShare" stroke={SERIES[1]} strokeWidth={2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
      <Legend items={[{ label: "Share of spend", color: SERIES[0] }, { label: "Cumulative share", color: SERIES[1] }]} />
      {data.length > 0 ? (
        <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          {categoriesTo80} of {rows.length} categories account for 80% of procurement value.
        </p>
      ) : null}
    </ChartCard>
  )
}

// ── 5. Branch × Category heatmap ───────────────────────────────────────────

export type MatrixData = {
  categories: Array<{ key: string; name: string }>
  rows: Array<{
    branchId: number
    branchName: string
    totalCents: number
    cells: Array<{ categoryKey: string; valueCents: number; quantity: number; sharePct: number }>
  }>
}

export function BranchCategoryHeatmap({ matrix, loading, error }: Readonly<{
  matrix: MatrixData
  loading: boolean
  error: string | null
}>) {
  const categories = matrix.categories.slice(0, 8)
  const singleBranch = matrix.rows.length === 1

  return (
    <ChartCard
      title="Branch × Category Mix"
      question="Is any branch's category mix unlike its peers?"
      formula="Each cell is that category's share of that branch's own procurement value, so branches of different sizes are comparable. Shade steps with the share; the exact value is in the cell title."
      loading={loading}
      error={error}
      empty={
        matrix.rows.length === 0
          ? "No categorised procurement in the selected period."
          : singleBranch
            ? "A mix comparison needs at least two branches with procurement activity in the selected period."
            : null
      }
      table={
        <DataTable
          columns={["Branch", ...categories.map((category) => category.name)]}
          rows={matrix.rows.map((row) => [
            row.branchName,
            ...categories.map((category) => {
              const cell = row.cells.find((entry) => entry.categoryKey === category.key)
              return cell && cell.valueCents > 0 ? `${percent(cell.sharePct, 0)} · ${money(cell.valueCents)}` : "—"
            }),
          ])}
        />
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr>
              <th scope="col" className="w-32 px-2 py-1 text-left font-medium text-slate-500 dark:text-slate-400">Branch</th>
              {categories.map((category) => (
                <th key={category.key} scope="col" className="px-2 py-1 text-center font-medium text-slate-500 dark:text-slate-400">
                  {category.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.branchId}>
                <th scope="row" className="px-2 py-1 text-left text-xs font-medium text-slate-700 dark:text-slate-300">
                  {row.branchName}
                </th>
                {categories.map((category) => {
                  const cell = row.cells.find((entry) => entry.categoryKey === category.key)
                  const share = cell?.sharePct ?? 0
                  return (
                    <td
                      key={category.key}
                      title={`${row.branchName} · ${category.name}: ${money(cell?.valueCents ?? 0)} (${percent(share, 0)} of this branch)`}
                      className="rounded-md px-2 py-2 text-center font-semibold tabular-nums"
                      style={{
                        background: sequentialStep(share / 100),
                        color: share > 55 ? "#ffffff" : "var(--viz-ink)",
                      }}
                    >
                      {share > 0 ? percent(share, 0) : "—"}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Darker means a larger share of that branch&apos;s own spend. Percentages are printed in every cell, so the grid is
        readable without colour.
      </p>
    </ChartCard>
  )
}

// ── 6. Order status composition ────────────────────────────────────────────

export type StatusBranch = {
  branchId: number
  branchName: string
  totalOrders: number
  statuses: Array<{ status: string; orderCount: number; sharePct: number }>
}

/** Five slots is the ceiling; anything past them folds into "Other". */
const STATUS_ORDER = ["PENDING", "APPROVED", "FULFILLED", "REJECTED", "REFUNDED"] as const
const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending approval",
  APPROVED: "Approved",
  FULFILLED: "Fulfilled",
  REJECTED: "Rejected / cancelled",
  REFUNDED: "Refunded",
  OTHER: "Other",
}

export function StatusCompositionChart({ branches, loading, error }: Readonly<{
  branches: StatusBranch[]
  loading: boolean
  error: string | null
}>) {
  const data = branches.map((branch) => {
    const point: Record<string, number | string> = { branchName: branch.branchName, totalOrders: branch.totalOrders }
    let other = 0
    branch.statuses.forEach((entry) => {
      const bucket = entry.status === "CANCELLED" ? "REJECTED" : entry.status
      if ((STATUS_ORDER as readonly string[]).includes(bucket)) {
        point[bucket] = (Number(point[bucket]) || 0) + entry.sharePct
        point[`${bucket}_count`] = (Number(point[`${bucket}_count`]) || 0) + entry.orderCount
      } else {
        other += entry.sharePct
        point.OTHER_count = (Number(point.OTHER_count) || 0) + entry.orderCount
      }
    })
    if (other > 0) point.OTHER = other
    return point
  })

  const present = [...STATUS_ORDER, "OTHER"].filter((status) => data.some((point) => Number(point[status]) > 0))

  return (
    <ChartCard
      title="Order Status Composition by Branch"
      question="Where is the procurement process getting stuck?"
      formula="Each segment is that status's share of the branch's own orders in the period, across every status. Shares, not counts, so a large branch does not swamp a small one."
      loading={loading}
      error={error}
      empty={data.length === 0 ? "No orders in the selected period." : null}
      table={
        <DataTable
          columns={["Branch", "Orders", ...present.map((status) => STATUS_LABEL[status])]}
          rows={data.map((point) => [
            String(point.branchName),
            countShort(Number(point.totalOrders)),
            ...present.map((status) => (Number(point[status]) > 0 ? percent(Number(point[status]), 0) : "—")),
          ])}
        />
      }
    >
      <ResponsiveContainer width="100%" height={chartHeight(data.length, 38)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid {...GRID_STYLE} horizontal={false} />
          <XAxis
            type="number"
            domain={[0, 100]}
            tickFormatter={(value) => `${value}%`}
            tick={AXIS_STYLE}
            axisLine={false}
            tickLine={false}
          />
          <YAxis type="category" dataKey="branchName" width={128} tick={AXIS_STYLE} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: "var(--viz-track)", fillOpacity: 0.35 }}
            content={({ active, payload, label }: any) => {
              if (!active || !payload?.length) return null
              const point = payload[0].payload
              return (
                <VizTooltip
                  title={String(label)}
                  rows={[
                    { label: "Orders in period", value: countShort(Number(point.totalOrders)) },
                    ...present.map((status, index) => ({
                      label: STATUS_LABEL[status],
                      value: Number(point[status])
                        ? `${percent(Number(point[status]), 0)} · ${countShort(Number(point[`${status}_count`]) || 0)}`
                        : "—",
                      color: SERIES[index % SERIES.length],
                    })),
                  ]}
                />
              )
            }}
          />
          {present.map((status, index) => (
            <Bar
              key={status}
              dataKey={status}
              stackId="status"
              fill={SERIES[index % SERIES.length]}
              barSize={18}
              radius={index === present.length - 1 ? [0, 4, 4, 0] : undefined}
              stroke="var(--viz-surface)"
              strokeWidth={2}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend
        items={present.map((status, index) => ({
          label: STATUS_LABEL[status],
          color: SERIES[index % SERIES.length],
        }))}
      />
    </ChartCard>
  )
}

// ── 7. Price variance ──────────────────────────────────────────────────────

export type PriceVarianceRow = {
  productId: number
  productName: string
  unit: string
  branchCount: number
  minUnitPriceCents: number
  maxUnitPriceCents: number
  avgUnitPriceCents: number
  spreadPct: number
  valueCents: number
}

export function PriceVariancePanel({ rows, thresholdPct, loading, error, onSelectProduct }: Readonly<{
  rows: PriceVarianceRow[]
  thresholdPct: number
  loading: boolean
  error: string | null
  onSelectProduct?: (productId: number, unit: string) => void
}>) {
  return (
    <ChartCard
      title="Same Product, Different Price"
      question="Are branches paying different prices for the same item?"
      formula="Per branch: weighted average unit price = Σ(line value) ÷ Σ(quantity). Compared only within the same product AND the same unit of measure. Spread = (highest − lowest) ÷ lowest × 100."
      loading={loading}
      error={error}
      empty={
        rows.length === 0
          ? "Price comparison requires the same product, in the same unit, to have been bought by at least two branches in the selected period."
          : null
      }
      table={
        <DataTable
          columns={["Product", "Unit", "Branches", "Lowest", "Highest", "Spread"]}
          rows={rows.map((row) => [
            row.productName,
            row.unit || "—",
            row.branchCount,
            money(row.minUnitPriceCents),
            money(row.maxUnitPriceCents),
            percent(row.spreadPct, 0),
          ])}
        />
      }
    >
      <ul className="space-y-2">
        {rows.map((row) => {
          const flagged = row.spreadPct >= thresholdPct
          return (
            <li key={`${row.productId}-${row.unit}`}>
              <button
                type="button"
                onClick={() => onSelectProduct?.(row.productId, row.unit)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition",
                  "border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60",
                  onSelectProduct ? "cursor-pointer" : "cursor-default",
                )}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">{row.productName}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {row.branchCount} branches · per {row.unit || "unit"} · {money(row.minUnitPriceCents)} – {money(row.maxUnitPriceCents)}
                  </p>
                </div>
                <span
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] font-bold tabular-nums"
                  style={{
                    background: flagged ? STATUS_COLOR.serious : "var(--viz-track)",
                    color: flagged ? "#1a1a19" : "var(--viz-ink)",
                  }}
                >
                  {percent(row.spreadPct, 0)} spread
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
        Highlighted where the spread is at or above the {thresholdPct}% analytics review threshold. A spread is not by
        itself a saving — quantity, timing and product revision can all explain it.
      </p>
    </ChartCard>
  )
}
