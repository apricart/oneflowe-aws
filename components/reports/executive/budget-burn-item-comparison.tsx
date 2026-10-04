"use client"

import { AlertTriangle, GitCompareArrows, X } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { BUDGET_BURN_PATTERN_MONTHS, BUDGET_BURN_THRESHOLDS } from "@/lib/budget-burn-risk"
import type { ItemMonth, ItemPatternRow } from "@/lib/budget-burn-item-comparison"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import { ChartMessage, countShort, money } from "./chart-kit"
import {
  HIGHLIGHT_MARKER,
  monthLabel,
  monthRangeLabel,
  shortMonthLabel,
  signedPercent,
  type BudgetBurnItemDrillSelection,
} from "./budget-burn-watchlist"

/**
 * The products behind one requester's months.
 *
 * It reads the same month buckets the row above it was drawn from, so each
 * column total equals the month cell it explains, and a product is
 * highlighted by the same rule as the requester — at or above
 * `momSpikePct` on the previous month, from a baseline worth measuring. As on
 * the row, the highlight never rests on colour alone.
 */

type ItemComparisonBucket = { month: string; startDate: string; endDate: string; complete: boolean }

type ItemComparisonResponse = {
  userId: string
  branchId: number
  month: string
  windows: { pattern: ItemComparisonBucket[] }
  items: ItemPatternRow[]
  monthTotals: ItemMonth[]
  truncated: boolean
  error?: string
}

/**
 * The months the panel will show, derived locally only so the heading can be
 * drawn before the response lands. The server's own `windows.pattern` is
 * authoritative and replaces this the moment it arrives.
 */
function fallbackMonths(month: string, span: number): string[] {
  const [year, monthNumber] = month.split("-").map(Number)
  return Array.from({ length: span }, (_, index) => {
    const shifted = new Date(Date.UTC(year, monthNumber - 1 - (span - 1 - index), 1))
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`
  })
}

export function BudgetBurnItemComparisonPanel({ selection, onClose }: Readonly<{
  selection: BudgetBurnItemDrillSelection
  onClose: () => void
}>) {
  const params = new URLSearchParams({
    userId: selection.userId,
    branchIds: String(selection.branchId),
    month: selection.month,
  })
  const url = `/api/v1/analytics/executive/budget-burn/item-comparison?${params.toString()}`
  const { data, error, isLoading } = useAPI<ItemComparisonResponse>(url)
  const requestError = error
    ? "The item comparison could not be loaded. Your session may have expired, or the selected month returned an error."
    : data?.error ?? null
  const rows = data?.items ?? []
  const months = data
    ? data.windows.pattern.map((bucket) => bucket.month)
    : fallbackMonths(selection.month, BUDGET_BURN_PATTERN_MONTHS)
  const span = months.length
  const lastMonth = months.at(-1)
  const range = lastMonth === undefined ? "" : monthRangeLabel(months[0], lastMonth)

  return (
    <Card className="overflow-hidden ring-1 ring-indigo-200 dark:ring-indigo-900">
      <CardHeader className="gap-1 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <GitCompareArrows className="h-4 w-4 text-indigo-600" aria-hidden />
              Item-wise {span}-month consumption
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {selection.requesterName} at {selection.branchName}: {range}, month by month.
              {" "}Orders counted as consumed, pending ones included, so these columns add up to the month cells you opened them from.
              {" "}A product is highlighted on the same rule as the row — at least {BUDGET_BURN_THRESHOLDS.momSpikePct}% above the previous month.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-3 w-3" aria-hidden />
            Close
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data && !requestError ? (
          <dl className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
            {data.monthTotals.map((total) => (
              <Total key={total.month} term={monthLabel(total.month)} value={money(total.spendCents)} />
            ))}
          </dl>
        ) : null}

        {isLoading ? <Skeleton className="h-[220px] w-full rounded-lg" /> : null}
        {!isLoading && requestError ? <ChartMessage tone="error" message={requestError} /> : null}
        {!isLoading && !requestError && rows.length === 0 ? (
          <ChartMessage tone="empty" message="No consumed items were found for this requester in these months." />
        ) : null}
        {!isLoading && !requestError && rows.length > 0 ? <ItemTable rows={rows} months={months} /> : null}

        {data?.truncated && !requestError ? (
          <p className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            The comparison hit its row cap; the smallest product totals may be missing.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function Total({ term, value }: Readonly<{ term: string; value: string }>) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{term}</dt>
      <dd className="text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  )
}

const HIGHLIGHT_CELL_CLASS = "bg-rose-50 font-semibold text-rose-700 dark:bg-rose-500/15 dark:text-rose-300"

/** What a product's percentage means, for its tooltip and its accessible label. */
function itemMomTitle(row: ItemPatternRow): string {
  const current = row.months.at(-1)
  const previous = row.months.at(-2)
  if (!current || !previous) return "No earlier month to compare against."
  const pair = `${monthLabel(previous.month)}: ${money(previous.spendCents)} → ${monthLabel(current.month)}: ${money(current.spendCents)}`
  if (row.momPct === null) return `${pair}. Nothing bought in ${monthLabel(previous.month)}, so there is no baseline.`
  return `${pair}. ${signedPercent(row.momPct, 1)}${row.momFlagged ? " — at or above the review threshold" : ""}.`
}

function ItemTable({ rows, months }: Readonly<{ rows: ItemPatternRow[]; months: string[] }>) {
  const lastIndex = months.length - 1
  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-800">
          <tr>
            <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">Product</th>
            <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">Unit</th>
            {months.map((month) => (
              <th key={month} scope="col" className="whitespace-nowrap px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">
                {shortMonthLabel(month)}
              </th>
            ))}
            <th scope="col" className="whitespace-nowrap px-3 py-2 text-right font-semibold text-slate-600 dark:text-slate-300">vs prev month</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.productId ?? "unknown"}:${row.unit}`} className="border-t border-slate-100 dark:border-slate-800">
              <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-200">{row.productName}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-600 dark:text-slate-400">{row.unit}</td>
              {row.months.map((cell, index) => (
                <td
                  key={cell.month}
                  className={cn("whitespace-nowrap px-3 py-1.5 text-right tabular-nums", row.momFlagged && index === lastIndex && HIGHLIGHT_CELL_CLASS)}
                  title={`${monthLabel(cell.month)}: ${money(cell.spendCents)} over ${countShort(cell.quantity)} ${row.unit}`}
                >
                  {row.momFlagged && index === lastIndex ? <span aria-hidden className="mr-0.5">{HIGHLIGHT_MARKER}</span> : null}
                  {money(cell.spendCents)}
                  <div className="text-[10px] font-normal text-slate-500 dark:text-slate-400">qty {countShort(cell.quantity)}</div>
                </td>
              ))}
              <td
                className={cn("whitespace-nowrap px-3 py-1.5 text-right tabular-nums", row.momFlagged && HIGHLIGHT_CELL_CLASS)}
                title={itemMomTitle(row)}
                aria-label={`${row.productName}, ${row.unit}: ${itemMomTitle(row)}`}
              >
                {row.momFlagged ? <span aria-hidden className="mr-0.5">{HIGHLIGHT_MARKER}</span> : null}
                {signedPercent(row.momPct, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
