"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { cn } from "@/lib/utils"
import type { MatrixDimensionId } from "@/lib/executive-analytics"
import {
  AXIS_STYLE,
  GRID_STYLE,
  Legend,
  VizTooltip,
  countShort,
  formatByKind,
  formatShortByKind,
  hoveredDatum,
  money,
  type InjectedTooltipProps,
} from "./chart-kit"
import {
  DrillHint,
  columnAxisProps,
  columnBottomMargin,
  columnChartHeight,
  columnLabelsRotated,
  columnTicksAngled,
  columnTopMargin,
  dualColumnLabel,
  entityColor,
  type DrillTarget,
} from "./comparison-charts"
import type { ExecutiveFilterState } from "./executive-filters"

/**
 * A segmented comparison grid: one figure per row/column pair, drawn two ways.
 *
 * As grouped columns — the "By product" or "By category" panel with several
 * requesters picked — the products or categories run along the axis and each
 * requester is a series, so "who consumed more of this one" is read across
 * one cluster and "what did this person consume" across one colour. As a table, the same figures sit in
 * a grid with the margins the server ranked them by, for the reader who wants
 * the numbers rather than their shape.
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
  /** The panel spans the whole row, so more columns have room for their figures. */
  fullWidth?: boolean
}

export type ColumnDatum = {
  key: string
  label: string
  total: number
  /** Each row entity's figure for this column, under the row's key. */
  values: Record<string, number>
}

/** One datum per column entity, which is what a column chart reads. */
export function columnData(response: Pick<MatrixResponse, "rows" | "columns" | "cells">): ColumnDatum[] {
  const byPair = indexCells(response.cells)
  return response.columns.map((column) => ({
    key: column.key,
    label: column.label,
    total: column.total,
    values: Object.fromEntries(
      response.rows.map((row) => [row.key, byPair.get(cellKey(row.key, column.key))?.value ?? 0]),
    ),
  }))
}

// ── Columns ────────────────────────────────────────────────────────────────

/**
 * Past this many columns in all, an upright figure is wider than the pitch of
 * the columns it stands over — about twelve pixels each across half a 1280px
 * window at the labelled cluster gap, and eleven across the whole row at the
 * larger cap — and neighbouring figures overwrite each other. The figures are
 * then left to the tooltip and the table rather than drawn illegibly.
 */
const MATRIX_LABEL_MAX_COLUMNS = 24
const MATRIX_LABEL_MAX_COLUMNS_FULL_WIDTH = 60

/**
 * The gap between clusters. A labelled grid gives a little of it to its
 * columns, which is what buys each upright figure its width; an unlabelled one
 * keeps the wider, easier-to-read separation.
 */
const CLUSTER_GAP = "22%"
const CLUSTER_GAP_LABELLED = "12%"

/** Whether every column in the grid carries its quantity and value over it. */
export function matrixColumnsLabelled(columnCount: number, fullWidth?: boolean): boolean {
  return columnCount <= (fullWidth ? MATRIX_LABEL_MAX_COLUMNS_FULL_WIDTH : MATRIX_LABEL_MAX_COLUMNS)
}

/** One pair's figure in the tooltip: quantity and amount together when the grid measures either. */
export function matrixCellFigure(cell: MatrixCell, format: string): string {
  if (format !== "currency" && format !== "quantity") return formatByKind(cell.value, format)
  return `Qty ${countShort(cell.quantity)} · ${money(cell.spendCents)}`
}

/** What one cluster holds, one line per row entity, the column's total last. */
function ColumnTooltip({ response, byPair, ...injected }: InjectedTooltipProps<ColumnDatum> & Readonly<{
  response: MatrixResponse
  byPair: Map<string, MatrixCell>
}>) {
  const datum = hoveredDatum(injected)
  if (!datum) return null
  const { rows, format } = response
  return (
    <VizTooltip
      title={datum.label}
      rows={[
        ...rows.map((row, index) => {
          const cell = byPair.get(cellKey(row.key, datum.key))
          return {
            label: row.label,
            value: cell ? matrixCellFigure(cell, format) : "—",
            color: entityColor(index, true),
          }
        }),
        { label: `All ${response.rowLabel.toLowerCase()}s`, value: formatByKind(datum.total, format), muted: true },
      ]}
    />
  )
}

/**
 * The click on one row entity's column or segment, opening the pair's lines.
 *
 * Recharts hands the clicked datum; the column is looked up from it, and a
 * pair the server sent no cell for opens nothing — there are no lines behind
 * a segment that is not there.
 */
function cellDrillHandler(
  response: MatrixResponse,
  byPair: Map<string, MatrixCell>,
  onDrillDown: ((target: DrillTarget) => void) | undefined,
) {
  if (!onDrillDown) return undefined
  return (row: MatrixEntity) => (entry: any) => {
    const columnKey = entry?.payload?.key ?? entry?.key
    const column = response.columns.find((candidate) => candidate.key === columnKey)
    if (column && byPair.has(cellKey(row.key, column.key))) onDrillDown(cellDrillTarget(response, row, column))
  }
}

/** How to read a column, in one sentence. */
function ColumnFootnote({ response }: Readonly<{ response: MatrixResponse }>) {
  const rowNoun = response.rowLabel.toLowerCase()
  const columnNoun = response.columnLabel.toLowerCase()
  const metricNoun = response.label.toLowerCase()
  return (
    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
      Each column is one {rowNoun}&apos;s {metricNoun} of one {columnNoun} — never combined across {rowNoun}s.
    </p>
  )
}

/** The grid as grouped columns: one cluster per column entity, one column per row entity inside it. */
export function MatrixChart({ response, onDrillDown, fullWidth }: Readonly<Props>) {
  const { rows, columns, format } = response
  const byPair = React.useMemo(() => indexCells(response.cells), [response.cells])
  const data = React.useMemo(() => columnData(response), [response])

  const angled = columnTicksAngled(columns)
  const drill = cellDrillHandler(response, byPair, onDrillDown)

  // Every column carries its quantity and value, as on the ranked panels —
  // upright as one string once the columns are narrower than two lines are
  // wide, and not at all past the point where even that would collide.
  const columnCount = rows.length * columns.length
  const labelled = matrixColumnsLabelled(columnCount, fullWidth)
  const rotated = columnLabelsRotated(columnCount, fullWidth)
  const topMargin = labelled ? columnTopMargin({ dual: true, rotated, combined: rotated }) : 12

  return (
    <>
      {/* The card grows for the labels rather than the plot shrinking for them. */}
      <ResponsiveContainer width="100%" height={columnChartHeight(angled, 320) + topMargin - 12}>
        <BarChart
          data={data}
          margin={{ top: topMargin, right: 12, bottom: columnBottomMargin(angled), left: 4 }}
          barCategoryGap={labelled ? CLUSTER_GAP_LABELLED : CLUSTER_GAP}
          barGap={2}
        >
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
            content={<ColumnTooltip response={response} byPair={byPair} />}
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
            >
              {labelled ? (
                <LabelList
                  position="top"
                  content={dualColumnLabel(
                    data.map((datum) => byPair.get(cellKey(row.key, datum.key)) ?? null),
                    format,
                    rotated,
                    { combined: true },
                  )}
                />
              ) : null}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend items={rows.map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) }))} />
      <DrillHint enabled={Boolean(onDrillDown)} noun="column" />
      <ColumnFootnote response={response} />
      <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
        {labelled
          ? `Each column is labelled with its quantity ${rotated ? "before" : "above"} its value in ₨. Values are abbreviated; the exact figures are in the tooltip and the table.`
          : "Too many columns to print figures over each one — hover a column for its quantity and value, or widen the panel."}
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
/**
 * The row entities carry the swatches, because they are the chart's series:
 * one requester is one hue on the chart, in the legend and in the table.
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
