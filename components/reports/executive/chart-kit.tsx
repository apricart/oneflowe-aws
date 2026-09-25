"use client"

import * as React from "react"
import { AlertTriangle, Info, Table2, BarChart3 } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn, formatPKR } from "@/lib/utils"

/**
 * Shared chart chrome for the Executive Analytics Center.
 *
 * The palette below is a validated categorical set: every adjacent pair clears
 * the colour-vision-deficiency separation floor in both light and dark mode,
 * and the dark column is its own set of steps chosen for the dark surface
 * rather than an automatic flip of the light one.
 *
 * Three light-mode slots sit below 3:1 contrast against a white card. That is
 * allowed only under the relief rule — the chart must also carry visible
 * labels or a table view — which is why `ChartCard` ships a table toggle on
 * every visual and the bar charts are directly labelled. Colour is never the
 * only channel: status is always paired with an icon and a word.
 *
 * `--viz-reference` is the one mark that is neither an entity nor a status: a
 * quantity *given*, such as the Total Budget a bar is read against. It is
 * deliberately not a seventh `SERIES` slot — it stands beside every one of the
 * six at once, and no added hue clears the all-pairs floors against all six in
 * both modes. It wins its separation on lightness instead, sitting outside the
 * series band in each theme: darker than them on the light surface, lighter on
 * the dark one. Validated against each of the six — worst normal-vision
 * ΔE 19.2 light / 17.7 dark (≥15 floor), worst CVD ΔE 12.7 / 10.9 (≥8
 * target), contrast 6.6:1 / 6.9:1 — and recessive enough that the taller
 * reference bar does not out-shout the shorter coloured one beside it.
 */
export const VIZ_CLASS = "exec-viz"

const VIZ_CSS = `
      .${VIZ_CLASS} {
        --viz-1: #2a78d6;
        --viz-2: #eb6834;
        --viz-3: #1baf7a;
        --viz-4: #eda100;
        --viz-5: #e87ba4;
        --viz-6: #008300;
        --viz-good: #0ca30c;
        --viz-warning: #fab219;
        --viz-serious: #ec835a;
        --viz-critical: #d03b3b;
        --viz-track: #e8e8e4;
        --viz-reference: #79506b;
        --viz-grid: #e1e0d9;
        --viz-axis: #898781;
        --viz-ink: #52514e;
        --viz-surface: #ffffff;
        --viz-seq-100: #cde2fb;
        --viz-seq-250: #86b6ef;
        --viz-seq-400: #3987e5;
        --viz-seq-550: #1c5cab;
        --viz-seq-700: #0d366b;
      }
      .dark .${VIZ_CLASS} {
        --viz-1: #3987e5;
        --viz-2: #d95926;
        --viz-3: #199e70;
        --viz-4: #c98500;
        --viz-5: #d55181;
        --viz-6: #008300;
        --viz-good: #0ca30c;
        --viz-warning: #fab219;
        --viz-serious: #ec835a;
        --viz-critical: #d03b3b;
        --viz-track: #2c2f3a;
        --viz-reference: #b59fbc;
        --viz-grid: #2c2c2a;
        --viz-axis: #898781;
        --viz-ink: #c3c2b7;
        --viz-surface: #1a1d26;
        --viz-seq-100: #0d366b;
        --viz-seq-250: #184f95;
        --viz-seq-400: #256abf;
        --viz-seq-550: #3987e5;
        --viz-seq-700: #86b6ef;
      }
`

/**
 * Injected once by the Analytics Center. Plain CSS rather than a CSS-in-JS
 * dependency, so the tokens resolve identically in both themes and the charts
 * only ever reference them by role.
 */
export function ExecutiveVizStyles() {
  return <style dangerouslySetInnerHTML={{ __html: VIZ_CSS }} />
}

/**
 * Fixed slot order. Never cycled, never generated — a 7th series folds to
 * "Other" rather than inventing a hue no check has passed. Validated as a set
 * in both modes: every adjacent pair clears the colour-vision separation floor.
 */
export const SERIES = [
  "var(--viz-1)", "var(--viz-2)", "var(--viz-3)",
  "var(--viz-4)", "var(--viz-5)", "var(--viz-6)",
] as const

export const STATUS_COLOR = {
  good: "var(--viz-good)",
  warning: "var(--viz-warning)",
  serious: "var(--viz-serious)",
  critical: "var(--viz-critical)",
} as const

/**
 * The hue of a quantity *given* — a Total Budget a bar is read against.
 *
 * Neither an entity nor a status, so it is neither a `SERIES` slot nor a
 * `STATUS_COLOR`. It was `--viz-track` until it turned out to be the wrong job
 * for that token: at 1.1:1 against a white card the tallest bar on the chart
 * read as background. Shared by the Overview's Budget vs Consumed chart and
 * the Product Performance columns, which are deliberately the same form.
 */
export const BUDGET_BESIDE_COLOR = "var(--viz-reference)"

/** One hue, light to dark — the only correct encoding for a magnitude grid. */
export const SEQUENTIAL = [
  "var(--viz-seq-100)",
  "var(--viz-seq-250)",
  "var(--viz-seq-400)",
  "var(--viz-seq-550)",
  "var(--viz-seq-700)",
] as const

export function sequentialStep(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return "var(--viz-track)"
  const index = Math.min(SEQUENTIAL.length - 1, Math.floor(ratio * SEQUENTIAL.length))
  return SEQUENTIAL[index]
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Exact money, for tooltips and tables. Cents in, rupees out. */
export function money(cents: number): string {
  return formatPKR((Number(cents) || 0) / 100, { maximumFractionDigits: 0 })
}

/** Abbreviated money for axes and bar labels. Tooltips still carry the exact value. */
export function moneyShort(cents: number): string {
  const value = (Number(cents) || 0) / 100
  const sign = value < 0 ? "-" : ""
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) return `${sign}₨${(absolute / 1_000_000_000).toFixed(1)}B`
  if (absolute >= 1_000_000) return `${sign}₨${(absolute / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${sign}₨${(absolute / 1_000).toFixed(1)}K`
  return `${sign}₨${absolute.toFixed(0)}`
}

/**
 * Abbreviated money without the currency mark, for a label that has no room
 * for one.
 *
 * Used where a column already carries two figures stacked above it: twelve
 * columns across half a row leave each about sixty pixels, and the mark is the
 * first thing to go because the axis, the tooltip and the table all still
 * carry it. Never used where the figure stands alone.
 */
export function moneyShortBare(cents: number): string {
  return moneyShort(cents).replace("₨", "")
}

export function percent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—"
  return `${value.toFixed(digits)}%`
}

export function countShort(value: number): string {
  const number = Number(value) || 0
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)}K`
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

export function formatByKind(value: number, format: string): string {
  switch (format) {
    case "currency": return money(value)
    case "percent": return percent(value)
    default: return countShort(value)
  }
}

export function formatShortByKind(value: number, format: string): string {
  switch (format) {
    case "currency": return moneyShort(value)
    case "percent": return percent(value, 0)
    default: return countShort(value)
  }
}

/**
 * `formatShortByKind` for a label drawn *on* a mark, where the currency mark
 * costs more than it carries.
 *
 * Upright columns are the crowded case: twelve of them across half a card, and
 * a pair of them per category once a budget stands beside each, leave a label
 * about fifty pixels. ₨ is two of those characters, and it was pushing
 * neighbouring labels into each other. The axis beside the columns still reads
 * ₨, as do the tooltip and the table.
 */
export function formatMarkLabelByKind(value: number, format: string): string {
  return format === "currency" ? moneyShortBare(value) : formatShortByKind(value, format)
}

/** Signed change, or a plain dash when there was no previous period to compare against. */
export function changeLabel(changePct: number | null | undefined): { text: string; tone: "up" | "down" | "flat" } {
  if (changePct === null || changePct === undefined || !Number.isFinite(changePct)) {
    return { text: "no prior period", tone: "flat" }
  }
  if (Math.abs(changePct) < 0.05) return { text: "no change", tone: "flat" }
  return { text: `${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% vs prior`, tone: changePct > 0 ? "up" : "down" }
}

// ── Card chrome ────────────────────────────────────────────────────────────

type ChartCardProps = {
  title: string
  /** The management question this visual exists to answer. */
  question: string
  /** How the figure is calculated, shown on the info affordance. */
  formula?: string
  loading?: boolean
  error?: string | null
  /** Rendered instead of the chart when there is nothing to draw. */
  empty?: string | null
  /** The accessible alternative to colour: the same numbers as rows. */
  table?: React.ReactNode
  toolbar?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/**
 * Every visual in the Center is wrapped in this.
 *
 * It carries the business question next to the title (a chart that cannot state
 * one does not belong here), a table toggle that satisfies the relief rule for
 * the low-contrast light-mode slots and doubles as the screen-reader path, and
 * explicit loading, error and empty states — an empty comparison explains why
 * it is empty instead of drawing a misleading blank axis.
 */
const ICON_BUTTON_CLASS =
  "rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"

/** Loading, error, empty and content are mutually exclusive; this picks one. */
function ChartBody({ loading, error, empty, table, view, children }: Readonly<{
  loading?: boolean
  error?: string | null
  empty?: string | null
  table?: React.ReactNode
  view: "chart" | "table"
  children: React.ReactNode
}>) {
  if (loading) return <Skeleton className="h-[260px] w-full rounded-lg" />
  if (error) return <ChartMessage tone="error" message={error} />
  if (empty) return <ChartMessage tone="empty" message={empty} />
  if (view === "table" && table) return <>{table}</>
  return <>{children}</>
}

export function ChartCard({
  title, question, formula, loading, error, empty, table, toolbar, className, children,
}: Readonly<ChartCardProps>) {
  const [view, setView] = React.useState<"chart" | "table">("chart")
  const [showFormula, setShowFormula] = React.useState(false)

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="gap-1 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight text-slate-900 dark:text-slate-100">{title}</h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{question}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {toolbar}
            {formula ? (
              <button
                type="button"
                onClick={() => setShowFormula((open) => !open)}
                aria-expanded={showFormula}
                aria-label={`How ${title} is calculated`}
                className={ICON_BUTTON_CLASS}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {table ? (
              <button
                type="button"
                onClick={() => setView((current) => (current === "chart" ? "table" : "chart"))}
                aria-label={view === "chart" ? `Show ${title} as a table` : `Show ${title} as a chart`}
                className={ICON_BUTTON_CLASS}
              >
                {view === "chart" ? <Table2 className="h-3.5 w-3.5" /> : <BarChart3 className="h-3.5 w-3.5" />}
              </button>
            ) : null}
          </div>
        </div>
        {showFormula && formula ? (
          <p className="mt-1 rounded-md bg-slate-50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            {formula}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <ChartBody loading={loading} error={error} empty={empty} table={table} view={view}>
          {children}
        </ChartBody>
      </CardContent>
    </Card>
  )
}

export function ChartMessage({ tone, message }: Readonly<{ tone: "error" | "empty"; message: string }>) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-200 px-6 text-center dark:border-slate-700">
      <AlertTriangle className={cn("h-5 w-5", tone === "error" ? "text-rose-500" : "text-slate-400")} />
      <p className="max-w-sm text-xs leading-relaxed text-slate-500 dark:text-slate-400">{message}</p>
    </div>
  )
}

/**
 * The table half of every chart card: the same rows, readable without colour.
 *
 * When `onSelectRow` is given the first cell becomes a real button, so the
 * drill-down the bars offer a mouse is reachable by keyboard and by a screen
 * reader. `rowKeys` supplies a stable identity — the first cell's text is a
 * label and two entities may share one.
 */
export function DataTable({ columns, rows, rowKeys, onSelectRow }: Readonly<{
  columns: string[]
  rows: Array<Array<string | number>>
  rowKeys?: string[]
  onSelectRow?: (key: string, index: number) => void
}>) {
  if (rows.length === 0) return <ChartMessage tone="empty" message="No rows in the selected period." />
  return (
    <div className="max-h-[280px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
          <tr>
            {columns.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={cn(
                  "px-3 py-2 font-semibold text-slate-600 dark:text-slate-300",
                  index === 0 ? "text-left" : "text-right",
                )}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const key = rowKeys?.[rowIndex] ?? String(row[0])
            return (
              <tr key={key} className="border-t border-slate-100 dark:border-slate-800">
                {row.map((cell, index) => (
                  <td
                    key={`${key}-${columns[index]}`}
                    className={cn(
                      "px-3 py-1.5 tabular-nums text-slate-700 dark:text-slate-300",
                      index === 0 ? "text-left font-medium" : "text-right",
                    )}
                  >
                    {index === 0 && onSelectRow ? (
                      <button
                        type="button"
                        onClick={() => onSelectRow(key, rowIndex)}
                        className="rounded text-left font-medium text-indigo-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                      >
                        {cell}
                      </button>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The tooltip every chart uses.
 *
 * It carries context rather than a bare number: the figure, what it is a share
 * of, and how it moved — so a reader understands why the chart matters without
 * opening another report.
 */
export function VizTooltip({ title, rows }: Readonly<{
  title: string
  rows: Array<{ label: string; value: string; color?: string; muted?: boolean }>
}>) {
  return (
    <div className="min-w-[180px] rounded-lg border border-slate-200 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title}</p>
      <dl className="space-y-1">
        {rows.map((row, index) => (
          // Slot-indexed: the list is a fixed read-out, and a metric label can
          // coincide with a context row (the scatter shows "Quantity" twice).
          <div key={`${index}:${row.label}`} className="flex items-center justify-between gap-4">
            <dt className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              {row.color ? (
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: row.color }} />
              ) : null}
              {row.label}
            </dt>
            <dd className={cn(
              "text-xs font-semibold tabular-nums",
              row.muted ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-slate-100",
            )}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A legend is always present for two or more series; identity is never colour alone. */
/**
 * Legend entries take an optional `key` — the entity's id — because two entities
 * may share a label (two people with one name, a product renamed mid-period).
 * Without one the slot index stands in: the legend is a static read-out of the
 * chart's rows and never reorders on its own.
 */
export function Legend({ items }: Readonly<{ items: Array<{ key?: string; label: string; color: string }> }>) {
  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item, index) => (
        <li key={item.key ?? `${index}:${item.label}`} className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400">
          <span aria-hidden className="h-2 w-2 rounded-[2px]" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

export const AXIS_STYLE = {
  fontSize: 11,
  fill: "var(--viz-axis)",
} as const

export const GRID_STYLE = {
  stroke: "var(--viz-grid)",
  strokeDasharray: "3 3",
} as const
