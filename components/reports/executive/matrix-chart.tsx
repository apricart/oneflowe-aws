"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { cn } from "@/lib/utils"
import type { MatrixDimensionId } from "@/lib/executive-analytics"
import { AXIS_STYLE, GRID_STYLE, Legend, VizTooltip, formatByKind, formatShortByKind } from "./chart-kit"
import {
  DrillHint,
  columnAxisProps,
  columnBottomMargin,
  columnChartHeight,
  columnTicksAngled,
  entityColor,
  type DrillTarget,
} from "./comparison-charts"
import type { ExecutiveFilterState } from "./executive-filters"

/**
 * The requester × product grid: one figure per pair, drawn three ways.
 *
 * As grouped columns, the products run along the axis and each requester is a
 * series, so "who consumed more of this product" is read across one cluster
 * and "what did this person consume" across one colour. As stacked columns —
 * the "By product" panel with several requesters picked — each product is one
 * column whose height is its total and whose segments are the requesters'
 * shares, so the ranking and its composition are read together. As a table,
 * the same figures sit in a grid with the margins the server ranked them by,
 * for the reader who wants the numbers rather than their shape.
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

/**
 * The grid the other way round: rows become columns, columns rows, the cells
 * following. The stacked "By product" panel draws the grid one way — products
 * along the axis, requesters as segments — and tabulates it the other, one
 * row per product, so the table reads the same way as the chart above it.
 * Every figure is the same object; nothing is recomputed.
 */
export function transposeMatrix(response: MatrixResponse): MatrixResponse {
  return {
    ...response,
    rowDimension: response.columnDimension,
    columnDimension: response.rowDimension,
    rowLabel: response.columnLabel,
    columnLabel: response.rowLabel,
    limits: { rows: response.limits.columns, columns: response.limits.rows },
    rows: response.columns,
    columns: response.rows,
    cells: response.cells.map((cell) => ({ ...cell, row: cell.column, column: cell.row })),
  }
}

type Props = {
  response: MatrixResponse
  onDrillDown?: (target: DrillTarget) => void
}

export type ColumnDatum = {
  key: string
  label: string
  total: number
  /** Each row entity's figure for this column, under the row's key. */
  values: Record<string, number>
  /**
   * What the column's total holds beyond the rows on the axis.
   *
   * The axis carries at most the cap's worth of requesters. When more were
   * picked to compare, a stack of only the shown ones would stop short of
   * the product's own total, so the difference is drawn as one neutral
   * "other" segment. A margin below its own cells folds to zero rather than
   * to a negative segment.
   */
  other: number
}

/** One datum per column entity, which is what a column chart reads in either form. */
export function columnData(response: Pick<MatrixResponse, "rows" | "columns" | "cells">): ColumnDatum[] {
  const byPair = indexCells(response.cells)
  return response.columns.map((column) => {
    const values = Object.fromEntries(
      response.rows.map((row) => [row.key, byPair.get(cellKey(row.key, column.key))?.value ?? 0]),
    )
    const shown = response.rows.reduce((sum, row) => sum + values[row.key], 0)
    return { key: column.key, label: column.label, total: column.total, values, other: Math.max(0, column.total - shown) }
  })
}

/** The legend and tooltip name for the folded remainder, e.g. "Other requesters". */
export function otherSegmentLabel(rowLabel: string): string {
  return `Other ${rowLabel.toLowerCase()}s`
}

/** The folded remainder wears the track colour: it is a quantity, not an entity. */
const OTHER_SEGMENT_COLOR = "var(--viz-track)"

// ── Columns ────────────────────────────────────────────────────────────────

/** What one column holds, one line per row entity, the remainder when drawn, the total last. */
function ColumnTooltip({ datum, response, byPair, hasOther }: Readonly<{
  datum: ColumnDatum
  response: MatrixResponse
  byPair: Map<string, MatrixCell>
  hasOther: boolean
}>) {
  const { rows, format } = response
  return (
    <VizTooltip
      title={datum.label}
      rows={[
        ...rows.map((row, index) => ({
          label: row.label,
          value: byPair.has(cellKey(row.key, datum.key)) ? formatByKind(datum.values[row.key], format) : "—",
          color: entityColor(index, true),
        })),
        ...(hasOther
          ? [{ label: otherSegmentLabel(response.rowLabel), value: formatByKind(datum.other, format), color: OTHER_SEGMENT_COLOR }]
          : []),
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

/** How to read a column, in one sentence, for whichever form is drawn. */
function ColumnFootnote({ response, stacked, hasOther }: Readonly<{
  response: MatrixResponse
  stacked: boolean
  hasOther: boolean
}>) {
  const rowNoun = response.rowLabel.toLowerCase()
  const columnNoun = response.columnLabel.toLowerCase()
  const metricNoun = response.label.toLowerCase()
  return (
    <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
      {stacked ? (
        <>
          Each column is one {columnNoun}&apos;s {metricNoun} in total; its segments are each {rowNoun}&apos;s share of it.
          {hasOther ? ` ${otherSegmentLabel(response.rowLabel)} is the part from people beyond the ${response.rows.length} shown.` : ""}
        </>
      ) : (
        <>
          Each column is one {rowNoun}&apos;s {metricNoun} of one {columnNoun} — never combined across {rowNoun}s.
        </>
      )}
    </p>
  )
}

/**
 * @param stacked The row entities as segments of one column per column entity,
 * rather than as a cluster beside it. The column then reaches the entity's
 * total, labelled above it, and the "other" remainder is drawn when needed.
 */
export function MatrixChart({ response, onDrillDown, stacked = false }: Readonly<Props & { stacked?: boolean }>) {
  const { rows, columns, format } = response
  const byPair = React.useMemo(() => indexCells(response.cells), [response.cells])
  const data = React.useMemo(() => columnData(response), [response])

  const otherLabel = otherSegmentLabel(response.rowLabel)
  const hasOther = stacked && data.some((datum) => datum.other > 0)
  // Stacked segments are parted by a hairline of surface rather than rounded,
  // so two neighbouring hues never touch; a cluster's columns stand apart.
  const segmentStyle = stacked
    ? { stackId: "column", stroke: "var(--viz-surface)", strokeWidth: 2, radius: 0, maxBarSize: 56 }
    : { stackId: undefined, stroke: undefined, strokeWidth: 0, radius: [4, 4, 0, 0] as [number, number, number, number], maxBarSize: 40 }
  const angled = columnTicksAngled(columns)
  const drill = cellDrillHandler(response, byPair, onDrillDown)

  // The total is labelled once, above the topmost segment of the stack —
  // whichever series that is — never on every segment.
  const totalLabel = (
    <LabelList
      dataKey="total"
      position="top"
      formatter={(value: any) => formatShortByKind(Number(value), format)}
      style={{ fontSize: 11, fill: "var(--viz-ink)", fontWeight: 600 }}
    />
  )
  const topSeriesIndex = hasOther ? rows.length : rows.length - 1

  return (
    <>
      <ResponsiveContainer width="100%" height={columnChartHeight(angled, 320)}>
        <BarChart
          data={data}
          margin={{ top: stacked ? 20 : 12, right: 12, bottom: columnBottomMargin(angled), left: 4 }}
          barCategoryGap="22%"
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
            content={({ active, payload }: any) => (active && payload?.length
              ? <ColumnTooltip datum={payload[0].payload} response={response} byPair={byPair} hasOther={hasOther} />
              : null)}
          />
          {rows.map((row, index) => (
            <Bar
              key={row.key}
              // A function rather than a path string: an entity key is an id
              // and must never be parsed as a property path.
              dataKey={(datum: ColumnDatum) => datum.values[row.key] ?? 0}
              name={row.label}
              fill={entityColor(index, true)}
              {...segmentStyle}
              isAnimationActive={false}
              onClick={drill?.(row)}
              className={drill ? "cursor-pointer" : undefined}
            >
              {stacked && index === topSeriesIndex ? totalLabel : null}
            </Bar>
          ))}
          {hasOther ? (
            <Bar dataKey="other" name={otherLabel} fill={OTHER_SEGMENT_COLOR} {...segmentStyle} isAnimationActive={false}>
              {totalLabel}
            </Bar>
          ) : null}
        </BarChart>
      </ResponsiveContainer>
      <Legend
        items={[
          ...rows.map((row, index) => ({ key: row.key, label: row.label, color: entityColor(index, true) })),
          ...(hasOther ? [{ key: "other", label: otherLabel, color: OTHER_SEGMENT_COLOR }] : []),
        ]}
      />
      <DrillHint enabled={Boolean(onDrillDown)} noun={stacked ? "segment" : "column"} />
      <ColumnFootnote response={response} stacked={stacked} hasOther={hasOther} />
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
 * @param seriesAxis Which axis the chart above colours — its entities carry
 * the swatches here, so one requester is one hue on the chart, in the legend
 * and in the table. Rows for the grouped form, columns for the stacked one.
 */
export function MatrixTable({ response, onDrillDown, seriesAxis = "rows" }: Readonly<Props & { seriesAxis?: "rows" | "columns" }>) {
  const { rows, columns, format } = response
  const byPair = React.useMemo(() => indexCells(response.cells), [response.cells])
  const isCount = format === "count"

  if (rows.length === 0 || columns.length === 0) return null

  const swatch = (index: number) => (
    <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: entityColor(index, true) }} />
  )

  return (
    <div className="max-h-[320px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
              {response.rowLabel}
            </th>
            {columns.map((column, columnIndex) => (
              <th key={column.key} scope="col" className="px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
                <span className="inline-flex items-center gap-1.5">
                  {seriesAxis === "columns" ? swatch(columnIndex) : null}
                  {column.label}
                </span>
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
                  {seriesAxis === "rows" ? swatch(rowIndex) : null}
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
