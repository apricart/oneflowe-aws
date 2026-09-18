"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { cn } from "@/lib/utils"
import type { MatrixDimensionId } from "@/lib/executive-analytics"
import { AXIS_STYLE, GRID_STYLE, Legend, VizTooltip, formatByKind, formatShortByKind } from "./chart-kit"
import { DrillHint, entityColor, type DrillTarget } from "./comparison-charts"
import type { ExecutiveFilterState } from "./executive-filters"

/**
 * The requester × product grid: one figure per pair, drawn two ways.
 *
 * As columns, the products run along the axis and each requester is a series,
 * so "who consumed more of this product" is read across one cluster and "what
 * did this person consume" across one colour. As a table, the same figures
 * sit in a grid with the margins the server ranked them by, for the reader
 * who wants the numbers rather than their shape.
 *
 * Both are pure presentation. Every figure, label and margin comes from the
 * `/matrix` response; nothing is summed here, so the grid cannot disagree with
 * the panels beside it. A cell is a click away from its own order lines — the
 * requester as the key, the product as a narrowing — through the same
 * drill-down every other panel uses.
 */

export type MatrixEntity = { key: string; label: string; total: number }
export type MatrixCell = {
  row: string
  column: string
  value: number
  spendCents: number
  quantity: number
  orderCount: number
}

export type MatrixResponse = {
  rowDimension: MatrixDimensionId
  columnDimension: MatrixDimensionId
  rowLabel: string
  columnLabel: string
  metric: string
  grain: string
  format: string
  label: string
  formula: string
  period: { startDate: string; endDate: string }
  quantityUnit: { selected: string | null; conflict: boolean; available: string[] }
  limits: { rows: number; columns: number }
  rows: MatrixEntity[]
  columns: MatrixEntity[]
  cells: MatrixCell[]
  blocked?: { reason: string; message: string }
  error?: string
}

/** Which shared filter a grid dimension's key narrows, for the drill-down. */
const NARROWING_FILTER: Record<MatrixDimensionId, keyof Pick<ExecutiveFilterState, "productIds" | "userIds" | "categoryIds" | "branchIds">> = {
  user: "userIds",
  product: "productIds",
  category: "categoryIds",
  branch: "branchIds",
}

/**
 * The detail request for one cell.
 *
 * The row entity travels as the key, the column entity as a narrowing of the
 * shared filters — the server folds the first through `applyEntityKeys` and
 * applies the second as it applies the screen's own focus, so the lines listed
 * are exactly the pair's and nothing wider.
 */
export function cellDrillTarget(
  response: Pick<MatrixResponse, "rowDimension" | "columnDimension">,
  row: MatrixEntity,
  column: MatrixEntity,
): DrillTarget {
  return {
    dimension: response.rowDimension,
    key: row.key,
    label: `${row.label} · ${column.label}`,
    narrow: { [NARROWING_FILTER[response.columnDimension]]: [column.key] },
  }
}

/** `{ "<row>|<column>": cell }`, so a lookup is one map read rather than a scan per cell. */
export function indexCells(cells: MatrixCell[]): Map<string, MatrixCell> {
  return new Map(cells.map((cell) => [`${cell.row}|${cell.column}`, cell]))
}

const cellKey = (row: string, column: string) => `${row}|${column}`

type Props = {
  response: MatrixResponse
  onDrillDown?: (target: DrillTarget) => void
}

type ColumnDatum = { key: string; label: string; total: number; values: Record<string, number> }

// ── Columns ────────────────────────────────────────────────────────────────

export function MatrixChart({ response, onDrillDown }: Readonly<Props>) {
  const { rows, columns, format, label: metricLabel } = response
  const byPair = React.useMemo(() => indexCells(response.cells), [response.cells])

  // One datum per column entity, carrying every row's value under the row's
  // key, which is what a grouped column chart reads.
  const data: ColumnDatum[] = columns.map((column) => ({
    key: column.key,
    label: column.label,
    total: column.total,
    values: Object.fromEntries(rows.map((row) => [row.key, byPair.get(cellKey(row.key, column.key))?.value ?? 0])),
  }))

  const crowded = columns.length > 6
  const drill = onDrillDown
    ? (row: MatrixEntity) => (entry: any) => {
      const columnKey = entry?.payload?.key ?? entry?.key
      const column = columns.find((candidate) => candidate.key === columnKey)
      if (column && byPair.has(cellKey(row.key, column.key))) onDrillDown(cellDrillTarget(response, row, column))
    }
    : undefined

  return (
    <>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data} margin={{ top: 12, right: 12, bottom: crowded ? 72 : 12, left: 4 }} barCategoryGap="22%" barGap={2}>
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
            content={({ active, payload }: any) => {
              if (!active || !payload?.length) return null
              const datum: ColumnDatum = payload[0].payload
              return (
                <VizTooltip
                  title={datum.label}
                  rows={[
                    ...rows.map((row, index) => ({
                      label: row.label,
                      value: byPair.has(cellKey(row.key, datum.key)) ? formatByKind(datum.values[row.key], format) : "—",
                      color: entityColor(index, true),
                    })),
                    { label: `All ${response.rowLabel.toLowerCase()}s`, value: formatByKind(datum.total, format), muted: true },
                  ]}
                />
              )
            }}
          />
          {rows.map((row, index) => (
            <Bar
              key={row.key}
              // A function rather than a path string: an entity key is an id
              // and must never be parsed as a property path.
              dataKey={(datum: ColumnDatum) => datum.values[row.key] ?? 0}
              name={row.label}
              fill={entityColor(index, true)}
              radius={[4, 4, 0, 0]}
              maxBarSize={40}
              isAnimationActive={false}
              onClick={drill?.(row)}
              className={drill ? "cursor-pointer" : undefined}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend items={rows.map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))} />
      <DrillHint enabled={Boolean(onDrillDown)} noun="column" />
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        Each column is one {response.rowLabel.toLowerCase()}&apos;s {metricLabel.toLowerCase()} of one{" "}
        {response.columnLabel.toLowerCase()} — never combined across {response.rowLabel.toLowerCase()}s.
      </p>
    </>
  )
}

// ── Grid ───────────────────────────────────────────────────────────────────

const CELL_BUTTON_CLASS = "rounded tabular-nums text-indigo-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"

/**
 * The same figures as a grid, margins included.
 *
 * A pair that never happened is shown as "—" rather than 0: the server sends
 * no cell for it, and "bought nothing" and "bought a refunded-to-nothing
 * amount" are different facts. Every cell with a figure is a button to its
 * own order lines; the margins are read-only, because a row total is already
 * the "By requester" panel's bar and drills from there.
 */
export function MatrixTable({ response, onDrillDown }: Readonly<Props>) {
  const { rows, columns, format } = response
  const byPair = React.useMemo(() => indexCells(response.cells), [response.cells])
  const isCount = format === "count"

  if (rows.length === 0 || columns.length === 0) return null

  return (
    <div className="max-h-[320px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
              {response.rowLabel}
            </th>
            {columns.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
                {column.label}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
              {isCount ? "Orders" : "Total"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={row.key} className="border-t border-slate-100 dark:border-slate-800">
              <th scope="row" className="px-3 py-1.5 text-left font-medium text-slate-700 dark:text-slate-300">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: entityColor(rowIndex, true) }} />
                  {row.label}
                </span>
              </th>
              {columns.map((column) => {
                const cell = byPair.get(cellKey(row.key, column.key))
                return (
                  <td key={column.key} className="px-3 py-1.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                    {cell ? (
                      onDrillDown ? (
                        <button
                          type="button"
                          onClick={() => onDrillDown(cellDrillTarget(response, row, column))}
                          aria-label={`${row.label}, ${column.label}: ${formatByKind(cell.value, format)}. Open order lines`}
                          className={CELL_BUTTON_CLASS}
                        >
                          {formatByKind(cell.value, format)}
                        </button>
                      ) : formatByKind(cell.value, format)
                    ) : (
                      <span className="text-slate-400 dark:text-slate-600" aria-label={`${row.label}, ${column.label}: nothing`}>—</span>
                    )}
                  </td>
                )
              })}
              <td className={cn("px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100")}>
                {formatByKind(row.total, format)}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-200 bg-slate-50/60 dark:border-slate-700 dark:bg-slate-800/40">
            <th scope="row" className="px-3 py-1.5 text-left font-semibold text-slate-700 dark:text-slate-300">
              {isCount ? "Orders" : "Total"}
            </th>
            {columns.map((column) => (
              <td key={column.key} className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {formatByKind(column.total, format)}
              </td>
            ))}
            <td className="px-3 py-1.5" />
          </tr>
        </tbody>
      </table>
      {isCount ? (
        <p className="px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400">
          An order holding two products is one order in each cell and one order in the margin, so the cells do not add up to it.
        </p>
      ) : null}
    </div>
  )
}
